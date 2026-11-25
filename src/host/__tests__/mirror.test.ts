// 거울(PRD §9.5, P2P-7): localStorage 에 쓴 것을 IndexedDB 에도 — 브라우저가 강제 종료되면 localStorage 만 최대 60초 뒤처진다.
// 여기는 메모리 거울. 진짜 IndexedDB 는 e2e/p2p-durable.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPIRE_MS, type RoomRec } from '../../../worker/room';
import { openHostRoom } from '../host-room';
import type { LocksLike } from '../lock';
import { adoptRooms, openMirror } from '../mirror';
import { hostKey, sweepRooms, type StorageLike } from '../storage';
import { Direct, FakeLocks, FakeMirror, FakeStore, SlowLocks, atQuestion, fakeClock, fakeDeps, flush, freeze, mustOpen, newHost, quotaError, reopen, started, tick } from './helpers';

let m: FakeMirror;
beforeEach(async () => { fakeClock(); m = new FakeMirror(); await openMirror(() => m); });
afterEach(async () => {
  await openMirror(() => { throw new Error('끔'); });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const asStore = (s: FakeStore) => s as unknown as StorageLike;
const rec = (store: FakeStore, code: string) => JSON.parse(store.data.get(hostKey(code, 'room'))!) as RoomRec;
/** 앱을 여는 탭 하나 */
const boot = async (store: FakeStore, locks: FakeLocks | null = new FakeLocks()) => {
  const all = await openMirror(() => m);
  await adoptRooms(all!, asStore(store), locks as unknown as LocksLike | null);
};

/** 판 중 강제 종료: localStorage 는 앞 시점(old)으로 되돌아가고 거울은 마지막까지(last) 있다 */
async function killed(deps = fakeDeps()) {
  const s = await atQuestion(1);
  Object.assign(deps.store, { data: s.store.data });
  await tick(1_000);
  await flush();
  const old = new Map(s.store.data);
  await s.direct.say({ t: 'act', a: { type: 'answer', choice: 0, ms: 1_000 } });
  await tick(3_000);
  await flush();
  const last = s.store.of(s.code);
  expect(m.of(s.code)).toEqual(last);
  s.host.close();
  await flush();
  s.store.data = new Map(old);
  deps.store.data = s.store.data;
  return { code: s.code, deps, store: deps.store, old: Object.fromEntries([...old].filter(([k]) => k.startsWith(hostKey(s.code, ''))).sort()), last, game: s.host.room.game! };
}

describe('P7E01 쓰기', () => {
  it('P7E01 한 처리(조각 + room)는 거울 배치 하나, 처리가 끝난 뒤에. 내용은 localStorage 와 같다', async () => {
    const s = await started(1);
    await flush();
    expect(m.of(s.code)).toEqual(s.store.of(s.code));
    const n = m.batches.length;
    const chunk = `log:${String(s.host.room.rec!.logChunks).padStart(6, '0')}`;
    s.direct.sock.send(JSON.stringify({ t: 'act', a: { type: 'roll' } })); // 동기로 끝나는 처리
    expect(s.store.data.has(hostKey(s.code, chunk))).toBe(true);
    expect(m.batches.length).toBe(n);
    await flush();
    expect(m.batches.slice(n).map((b) => b.map(([k]) => k))).toEqual([[hostKey(s.code, chunk), hostKey(s.code, 'room')]]);
    expect(m.of(s.code)).toEqual(s.store.of(s.code));
  });

  it('P7E01 심박은 alive 하나', async () => {
    const { store, code } = await newHost();
    await flush();
    const n = m.batches.length;
    await tick(2_000);
    await flush();
    expect(m.batches.slice(n)).toEqual([1, 2].map((i) => [[hostKey(code, 'alive'), String(Date.now() - 2_000 + i * 1_000)]]));
    expect(m.of(code)).toEqual(store.of(code));
  });

  it('P7E01 앞 배치가 끝나야 다음 배치를 보낸다(앞이 실패하면 뒤도 안 나간다)', async () => {
    const done: (() => void)[] = [];
    const sent: string[] = [];
    await openMirror(() => ({ all: async () => new Map(), write: (ops) => { sent.push(ops[0][0]); return new Promise<void>((ok) => { done.push(ok); }); } }));
    const { code } = await newHost();
    await tick(2_000);
    await flush();
    expect(sent).toEqual([hostKey(code, 'room')]);
    done[0]();
    await flush();
    expect(sent).toEqual([hostKey(code, 'room'), hostKey(code, 'alive')]);
  });
});

describe('P7E02 저장이 멈춘 방', () => {
  it('P7E02 처음부터 막힘(never): 거울 쓰기 0', async () => {
    const deps = fakeDeps();
    deps.store.fail = () => Object.assign(new Error('blocked'), { name: 'SecurityError' });
    const { host, code } = await newHost(deps);
    const d = new Direct(host);
    await d.say({ t: 'hello', charId: 0 });
    await d.say({ t: 'start' });
    await tick(10_000);
    await flush();
    expect([host.storage.status, m.of(code)]).toEqual(['never', {}]);
  });

  for (const [tag, bad] of [['조각', '.log:'], ['조각 뒤 room', '.room']] as const) {
    it(`P7E02 ${tag} 쓰기에서 멈춤(stopped): 거울 = 마지막으로 성공한 localStorage. 다시 열면 남은 조각은 거울에서도 사라진다`, async () => {
      const { host, deps, store, code, direct } = await atQuestion(1);
      const chunk = hostKey(code, `log:${String(host.room.rec!.logChunks).padStart(6, '0')}`);
      store.fail = (k) => (k.includes(bad) ? quotaError() : null);
      await direct.say({ t: 'act', a: { type: 'answer', choice: 0, ms: 1_000 } });
      expect(host.storage.status).toBe('stopped');
      expect(m.of(code)).toEqual(store.of(code));
      expect(m.data.has(chunk)).toBe(bad === '.room');
      const n = m.batches.length;
      await tick(5_000);
      await direct.say({ t: 'pause' });
      expect(m.batches.length).toBe(n);
      host.close();
      store.fail = () => null;
      const again = await mustOpen(code, deps);
      await flush();
      expect(m.of(code)).toEqual(store.of(code));
      expect(m.data.get(chunk)).toBe(JSON.stringify([again.room.game!.log.at(-1)])); // 남은 조각 대신 자동 멈춤 조각
    });
  }
});

describe('P7E03 앱을 열 때 갈아 끼우기', () => {
  it('P7E03 거울이 엄격히 새로움: 그 방 키 집합이 거울과 같아지고 다른 방은 그대로. 그 시점의 판이 열린다', async () => {
    const k = await killed();
    k.store.data.set(hostKey(k.code, 'log:000099'), '[]'); // 거울에 없는 키
    k.store.data.set(hostKey('BBBBBB', 'alive'), '1');
    await boot(k.store);
    expect(k.store.of(k.code)).toEqual(k.last);
    expect(k.store.of('BBBBBB')).toEqual({ [hostKey('BBBBBB', 'alive')]: '1' });
    const { lastTickAt } = rec(k.store, k.code);
    const alive = Number(k.last[hostKey(k.code, 'alive')]);
    freeze(60_000);
    const again = await mustOpen(k.code, k.deps);
    expect(again.room.game!.phase).toBe('paused');
    expect(again.room.game!.log.slice(0, -1)).toEqual(k.game.log);
    expect(again.room.game!.clock.pausedAt).toBe(Math.max(alive, lastTickAt!));
  });

  for (const [tag, d] of [['같음', 0], ['오래됨', -1]] as const) it(`P7E03 거울 alive ${tag}: localStorage 는 한 글자도 안 바뀐다`, async () => {
    const k = await killed();
    m.data.set(hostKey(k.code, 'alive'), String(Number(k.old[hostKey(k.code, 'alive')]) + d));
    const n = k.store.touched(k.code);
    await boot(k.store);
    expect(k.store.of(k.code)).toEqual(k.old);
    expect(k.store.touched(k.code)).toBe(n);
  });

  it('P7E03 거울에만 있음(만료 전): localStorage 에 생기고 열린다', async () => {
    const k = await killed();
    k.store.data.clear();
    await boot(k.store);
    expect(k.store.of(k.code)).toEqual(k.last);
    expect((await mustOpen(k.code, k.deps)).room.game!.log.slice(0, -1)).toEqual(k.game.log);
  });

  it('P7E03 localStorage 에만 있음: 그대로', async () => {
    const k = await killed();
    m.data.clear();
    const n = k.store.touched(k.code);
    await boot(k.store);
    expect(k.store.of(k.code)).toEqual(k.old);
    expect(k.store.touched(k.code)).toBe(n);
  });
});

describe('P7E21 거울 없이 이어 온 방', () => {
  it('P7E21 다시 열면 한 트랜잭션으로 온전한 사본이 된다(다른 방·자리 그대로). 그 뒤 강제 종료돼도 거울 시점의 판이 열린다', async () => {
    const k = await killed();
    m.data.clear();
    const other = [['tw.seat', '{"at":1}'], [hostKey('BBBBBB', 'alive'), '1']] as const;
    for (const [a, b] of [...other, [hostKey(k.code, 'log:000099'), '[]']] as const) m.data.set(a, b);
    const n = m.batches.length;
    const again = await mustOpen(k.code, k.deps);
    await flush();
    expect(m.batches.length).toBe(n + 1);
    expect(m.of(k.code)).toEqual(k.store.of(k.code));
    for (const [a, b] of other) expect(m.data.get(a)).toBe(b);
    const d = new Direct(again);
    await d.say({ t: 'rejoin', ...again.hostRejoin()! });
    const old = new Map(k.store.data);
    await d.say({ t: 'resume' });
    await tick(5_000);
    again.close();
    await flush();
    const { log } = again.room.game!;
    k.store.data = new Map(old);
    await boot(k.store);
    expect((await mustOpen(k.code, k.deps)).room.game!.log.slice(0, log.length)).toEqual(log);
  });

  for (const [tag, spoil] of [
    ['빠짐', (key: string) => { m.data.delete(key); }],
    ['깨짐', (key: string) => { m.data.set(key, '[{"ev'); }],
  ] as const) for (const lost of [false, true]) it(`P7E21 거울의 로그 조각이 ${tag}(localStorage ${lost ? '없음' : '있음'}): 거울이 더 새로워도 localStorage 는 그대로, 거울에서 그 방만 지운다`, async () => {
    const k = await killed();
    m.data.set('tw.seat', '{"at":1}');
    spoil(hostKey(k.code, 'log:000000'));
    if (lost) k.store.data.clear();
    const before = k.store.of(k.code);
    const n = k.store.touched(k.code);
    await boot(k.store);
    await flush();
    expect(k.store.of(k.code)).toEqual(before);
    expect(k.store.touched(k.code)).toBe(n);
    expect([...m.data]).toEqual([['tw.seat', '{"at":1}']]);
  });
});

describe('P7E04 갈아 끼우지 못함', () => {
  for (const bad of ['.log:', '.room']) it(`P7E04 ${bad} setItem 이 던짐: 거기서 멈추고 옛 room 이 남는다. 다른 방을 지우지 않고, 열면 일관된 옛 판`, async () => {
    const k = await killed();
    const oldRoom = k.old[hostKey(k.code, 'room')];
    const oldLen = rec(k.store, k.code).logLen;
    const other = { [hostKey('BBBBBB', 'room')]: JSON.stringify({ code: 'BBBBBB', expiresAt: Date.now() + EXPIRE_MS, lastActiveAt: 1, game: { phase: 'finished' } }) };
    for (const [a, b] of Object.entries(other)) k.store.data.set(a, b);
    const n = k.store.ops.length;
    k.store.fail = (x) => (x.includes(`${k.code}${bad}`) ? quotaError() : null);
    await boot(k.store);
    expect(k.store.data.get(hostKey(k.code, 'room'))).toBe(oldRoom);
    expect(k.store.of('BBBBBB')).toEqual(other);
    const ops = k.store.ops.slice(n).filter((o) => /^(set|del)/.test(o));
    expect(ops.at(-1)).toContain(bad); // 던진 것이 마지막
    k.store.fail = () => null;
    const again = await mustOpen(k.code, k.deps);
    expect(again.room.game!.log.length).toBe(oldLen + 1); // 자동 멈춤 하나
    expect(again.room.rec!.logLen).toBe(oldLen + 1);
  });

  for (const [tag, room] of [
    ['깨짐', '{"code"'],
    ['만료됨', JSON.stringify({ expiresAt: 1 })],
    ['없음', null],
  ] as const) it(`P7E04 거울의 room 이 ${tag}: localStorage 는 그대로, 거울에서 그 방만 지운다`, async () => {
    const k = await killed();
    m.data.set('tw.seat', '{"at":1}');
    if (room === null) m.data.delete(hostKey(k.code, 'room'));
    else m.data.set(hostKey(k.code, 'room'), room);
    const n = k.store.touched(k.code);
    await boot(k.store);
    await flush();
    expect(k.store.of(k.code)).toEqual(k.old);
    expect(k.store.touched(k.code)).toBe(n);
    expect([...m.data]).toEqual([['tw.seat', '{"at":1}']]);
  });
});

describe('P7E05 다른 탭·시계', () => {
  it('P7E05 Web Locks 를 남이 쥔 방은 교체 0', async () => {
    const k = await killed();
    const locks = new FakeLocks();
    locks.held.add(`tw.host.${k.code}`);
    const n = k.store.touched(k.code);
    await boot(k.store, locks);
    expect(k.store.touched(k.code)).toBe(n);
    expect(k.store.of(k.code)).toEqual(k.old);
  });

  it('P7E05 Web Locks 없음: alive 가 3초 안이면 교체 0(다시 보지 않는다), 넘으면 교체', async () => {
    const k = await killed();
    const was = k.store.data.get(hostKey(k.code, 'alive'))!;
    k.store.data.set(hostKey(k.code, 'alive'), String(Date.now() - 2_900));
    m.data.set(hostKey(k.code, 'alive'), String(Date.now()));
    const before = k.store.of(k.code);
    const t = Date.now();
    await boot(k.store, null);
    expect([Date.now() - t, vi.getTimerCount()]).toEqual([0, 0]);
    expect(k.store.of(k.code)).toEqual(before);
    k.store.data.set(hostKey(k.code, 'alive'), was);
    await boot(k.store, null);
    expect(k.store.of(k.code)).toEqual(m.of(k.code));
  });

  for (const locks of [new FakeLocks(), new SlowLocks(), null]) it(`P7E05 새 탭 둘이 동시에 엶(${locks?.constructor.name ?? 'Web Locks 없음'}): 교체는 한 번, 끝 상태는 같다`, async () => {
    const k = await killed();
    const n = k.store.ops.length;
    const all = (await openMirror(() => m))!;
    const both = Promise.all([0, 1].map(() => adoptRooms(all, asStore(k.store), locks as unknown as LocksLike | null)));
    await tick(200);
    await both;
    expect(k.store.ops.slice(n).filter((o) => o === `set ${hostKey(k.code, 'room')}`)).toHaveLength(1);
    expect(k.store.of(k.code)).toEqual(k.last);
  });

  it('P7E05 기기 시계가 뒤로 감(거울 alive < localStorage alive): 교체 0', async () => {
    const k = await killed();
    k.store.data.set(hostKey(k.code, 'alive'), String(Date.now() + 3_600_000));
    const before = k.store.of(k.code);
    await boot(k.store);
    expect(k.store.of(k.code)).toEqual(before);
  });
});

describe('P7E06 거울이 안 되는 곳', () => {
  const play = async () => { const s = await started(0); await tick(5_000); await flush(); return s; };

  it('P7E06 indexedDB 가 없음 · 열기가 던짐: 바로 돌아오고 그 세션 거울 쓰기 0, 예외 0', async () => {
    expect(typeof indexedDB).toBe('undefined');
    expect(await openMirror()).toBeNull();
    await play();
    expect(await openMirror(() => { throw new DOMException('막힘', 'SecurityError'); })).toBeNull();
    const s = await play();
    expect(s.host.storage.status).toBe('ok');
    expect(m.batches).toEqual([]);
  });

  it('P7E06 열기가 답하지 않음: 2초에 돌아오고, 그 사이 쌓인 것도 늦게 열려도 쓰기 0', async () => {
    let late: (v: Map<string, string>) => void = () => {};
    const sent: unknown[] = [];
    const t = Date.now();
    const p = openMirror(() => ({ all: () => new Promise((ok) => { late = ok; }), write: async (ops) => { sent.push(ops); } }));
    const { host } = await newHost();
    await tick(1_999);
    let got: unknown = 'wait';
    void p.then((v) => { got = v; });
    await flush();
    expect(got).toBe('wait');
    await tick(1);
    expect([got, Date.now() - t]).toEqual([null, 2_000]);
    late(new Map());
    await tick(5_000);
    await flush();
    expect([sent, host.storage.status]).toEqual([[], 'ok']);
    host.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('P7E06 읽기가 실패함: 그 세션 거울 쓰기 0', async () => {
    const sent: unknown[] = [];
    expect(await openMirror(() => ({ all: () => Promise.reject(new Error('AbortError')), write: async (ops) => { sent.push(ops); } }))).toBeNull();
    await play();
    expect(sent).toEqual([]);
  });

  it('P7E06 읽는 사이 만든 방은 다 읽은 뒤 거울에 들어간다', async () => {
    let done: (v: Map<string, string>) => void = () => {};
    const p = openMirror(() => ({ all: () => new Promise((ok) => { done = ok; }), write: (ops) => m.write(ops) }));
    const { store, code } = await newHost();
    await tick(1_000);
    expect(m.of(code)).toEqual({});
    done(new Map());
    await p;
    await flush();
    expect(m.of(code)).toEqual(store.of(code));
  });

  it('P7E06 트랜잭션 오류 뒤: localStorage 는 계속, 거울 쓰기 0(다시 되는 때가 와도), Room 으로 예외 0', async () => {
    const s = await started(1);
    await flush();
    m.fail = quotaError();
    await s.direct.say({ t: 'act', a: { type: 'roll' } });
    const kept = m.of(s.code);
    m.fail = null;
    const n = m.batches.length;
    await tick(5_000);
    await s.direct.say({ t: 'pause' });
    await flush();
    expect([m.batches.length, s.host.storage.status, s.host.room.game!.phase]).toEqual([n, 'ok', 'paused']);
    expect(m.of(s.code)).toEqual(kept);
    expect(rec(s.store, s.code).game!.phase).toBe('paused');
  });

  it('P7E06 저장소 자체가 막혀도 앱 열기는 예외 없이 끝난다', async () => {
    const k = await killed();
    k.store.fail = () => Object.assign(new Error('blocked'), { name: 'SecurityError' });
    await boot(k.store);
    await adoptRooms(await m.all(), null, null);
    const bad = new Proxy({}, { get() { throw new Error('막힘'); } }) as StorageLike;
    await adoptRooms(await m.all(), bad, null);
    expect(k.store.of(k.code)).toEqual(k.old);
  });
});

describe('P7E07 방 삭제', () => {
  /** code 만 사라지고 다른 방·자리는 남고, 앱을 다시 열어도 되살아나지 않는다 */
  async function gone(code: string, store: FakeStore, keep: string) {
    await flush();
    expect([m.of(code), m.data.get('tw.seat')]).toEqual([{}, '{"at":1}']);
    expect(Object.keys(m.of(keep)).length).toBeGreaterThan(0);
    await boot(store);
    expect(store.keys(code)).toEqual([]);
  }
  async function two() {
    const deps = fakeDeps();
    const keep = await started(0, deps);
    const s = await started(0, deps);
    m.data.set('tw.seat', '{"at":1}');
    m.data.set(hostKey(s.code, 'log:000077'), '[]'); // localStorage 에는 없는 키
    await flush();
    return { deps, store: deps.store, keep: keep.code, kept: keep.host, s };
  }

  it('P7E07 [게임 끝내기]', async () => {
    const { store, keep, s } = await two();
    await s.direct.say({ t: 'end' });
    await gone(s.code, store, keep);
  });

  it('P7E07 만료 청소(sweepRooms)', async () => {
    const { store, keep, s } = await two();
    s.host.close();
    store.data.set(hostKey(s.code, 'room'), JSON.stringify({ ...rec(store, s.code), expiresAt: 1 }));
    sweepRooms(asStore(store));
    await gone(s.code, store, keep);
  });

  it('P7E07 용량 정리로 지운 다른 방', async () => {
    const { store, keep, kept, s } = await two();
    s.host.close();
    store.data.set(hostKey(s.code, 'room'), JSON.stringify({ ...rec(store, s.code), game: { ...rec(store, s.code).game, phase: 'finished' } }));
    await tick(5_000);
    let full = true;
    store.fail = (k) => (full && k === hostKey(keep, 'room') ? quotaError() : null);
    const del = store.removeItem.bind(store);
    vi.spyOn(store, 'removeItem').mockImplementation((k) => { full = false; del(k); });
    kept.room.webSocketClose((kept.room as unknown as { ctx: { getWebSockets(): never[] } }).ctx.getWebSockets()[0]); // 저장할 변경 하나
    expect([full, kept.storage.status, store.keys(s.code)]).toEqual([false, 'ok', []]);
    await gone(s.code, store, keep);
  });

  it('P7E07 열 때 none(만료·깨짐)', async () => {
    for (const bad of ['{"code"', JSON.stringify({ expiresAt: 1 })]) {
      const { deps, store, keep, s } = await two();
      s.host.close();
      store.data.set(hostKey(s.code, 'room'), bad);
      expect(await reopen(s.code, deps)).toBe('none');
      await gone(s.code, store, keep);
    }
  });
});

describe('P7E20 갈아 끼운 바로 뒤 같은 탭이 연다', () => {
  for (const locks of [new FakeLocks(), new SlowLocks()]) it(`P7E20 ${locks.constructor.name}: busy 가 아니다`, async () => {
    const k = await killed();
    const p = boot(k.store, locks).then(() => openHostRoom(k.code, { store: asStore(k.store), locks: locks as unknown as LocksLike })); // reopen 처럼 기다려 주지 않는다
    await tick(200);
    expect(typeof await p).toBe('object');
    expect(k.store.data.get(hostKey(k.code, 'room'))).not.toBe(k.old[hostKey(k.code, 'room')]);
  });

  it('P7E20 Web Locks 없음: 교체로 alive 가 신선해져도 기다렸다 연다', async () => {
    const k = await killed();
    k.store.data.set(hostKey(k.code, 'alive'), String(Number(k.old[hostKey(k.code, 'alive')]) - 10_000));
    await boot(k.store, null);
    expect(k.store.of(k.code)).toEqual(k.last);
    let got: unknown = null;
    void reopen(k.code, { ...k.deps, locks: null }).then((v) => { got = v; });
    for (let i = 0; i < 80 && !got; i++) await tick(50);
    expect(typeof got).toBe('object');
  });
});

describe('P7bE01 거울이 꺼진 세션의 방 삭제', () => {
  /** 거울에 방 둘(keep · s)이 들어간 뒤 거울이 꺼진다. makes = 꺼진 뒤 새로 만든 백엔드 수 */
  async function off(why: '배치 실패' | '2초 시한') {
    const deps = fakeDeps();
    const keep = await started(0, deps);
    const s = await started(0, deps);
    m.data.set('tw.seat', '{"at":1}');
    await flush();
    const made = { n: 0, fail: null as Error | null };
    let first = true;
    const make = () => {
      if (first) { first = false; return why === '2초 시한' ? { all: () => new Promise<never>(() => {}), write: (ops: Parameters<FakeMirror['write']>[0]) => m.write(ops) } : m; }
      made.n++;
      if (made.fail) throw made.fail;
      return m;
    };
    const p = openMirror(make);
    await tick(2_000); // 2초 시한 쪽은 여기서 꺼진다(심박 두 번은 다 읽은 뒤 나가려다 버려진다)
    await p;
    if (why === '배치 실패') { m.fail = quotaError(); await tick(1_000); m.fail = null; }
    const n = m.batches.length;
    await tick(5_000);
    await s.direct.say({ t: 'pause' });
    await flush();
    expect([m.batches.length, made.n]).toEqual([n, 0]); // 방 데이터 0 = 꺼졌다
    expect(Object.keys(m.of(s.code)).length).toBeGreaterThan(2);
    const kept = m.of(keep.code);
    /** 지움 하나가 새 백엔드로 트랜잭션 하나에 갔고, 다음에 앱을 열어도 되살아나지 않는다 */
    const gone = async () => {
      await flush();
      expect.soft(m.batches.slice(n)).toEqual([[[hostKey(s.code, ''), null]]]);
      expect.soft([made.n, m.of(s.code), m.of(keep.code), m.data.get('tw.seat')]).toEqual([1, {}, kept, '{"at":1}']);
      await tick(5_000); // 방 데이터는 그 뒤로도 0
      expect.soft([made.n, m.batches.length]).toEqual([1, n + 1]);
      await boot(deps.store);
      sweepRooms(asStore(deps.store));
      expect(deps.store.keys(s.code)).toEqual([]);
      expect(deps.store.keys(keep.code).length).toBeGreaterThan(0);
    };
    return { deps, store: deps.store, keep, s, made, n, gone };
  }
  type Off = Awaited<ReturnType<typeof off>>;
  const ways: [string, (r: Off) => Promise<void>][] = [
    ['끝내기', async ({ s }) => { await s.direct.say({ t: 'end' }); }],
    ['만료 청소', async ({ s, store }) => {
      s.host.close();
      store.data.set(hostKey(s.code, 'room'), JSON.stringify({ ...rec(store, s.code), expiresAt: 1 }));
      sweepRooms(asStore(store));
    }],
    ['열 때 none', async ({ s, store, deps }) => {
      s.host.close();
      store.data.set(hostKey(s.code, 'room'), '{"code"');
      expect(await reopen(s.code, deps)).toBe('none');
    }],
    ['용량 정리', async ({ s, store, keep }) => {
      s.host.close();
      store.data.set(hostKey(s.code, 'room'), JSON.stringify({ ...rec(store, s.code), game: { ...rec(store, s.code).game, phase: 'finished' } }));
      await tick(5_000);
      let full = true;
      store.fail = (k) => (full && k === hostKey(keep.code, 'room') ? quotaError() : null);
      const del = store.removeItem.bind(store);
      vi.spyOn(store, 'removeItem').mockImplementation((k) => { full = false; del(k); });
      await keep.direct.say({ t: 'pause' });
      expect([full, keep.host.storage.status, store.keys(s.code)]).toEqual([false, 'ok', []]);
    }],
  ];
  for (const why of ['배치 실패', '2초 시한'] as const) for (const [name, act] of ways) it(`P7bE01 ${why} → ${name}: 지움만 새 연결로 한 번, 다음에 열어도 되살아나지 않는다`, async () => {
    const r = await off(why);
    await act(r);
    await r.gone();
  });

  it('P7bE01 끝내기 배치 자체가 실패: 그 배치의 지움만 새 연결로 한 번 더', async () => {
    const deps = fakeDeps();
    const s = await started(0, deps);
    await flush();
    let makes = 0;
    await openMirror(() => { makes++; return m; });
    let bad = true;
    vi.spyOn(m, 'write').mockImplementationOnce(async () => { bad = false; throw quotaError(); });
    const n = m.batches.length;
    s.direct.sock.send(JSON.stringify({ t: 'act', a: { type: 'roll' } })); // 같은 배치에 방 데이터도 들어간다
    s.direct.sock.send(JSON.stringify({ t: 'end' }));
    await flush();
    expect([bad, makes, m.batches.slice(n)]).toEqual([false, 2, [[[hostKey(s.code, ''), null]]]]);
    expect(m.of(s.code)).toEqual({});
    await boot(deps.store);
    expect(deps.store.keys(s.code)).toEqual([]);
  });

  it('P7bE01 읽기가 시한을 넘기기 전에 지운 방도 꺼진 뒤 한 번 간다', async () => {
    const deps = fakeDeps();
    const s = await started(0, deps);
    await flush();
    let makes = 0;
    const p = openMirror(() => (makes++ ? m : { all: () => new Promise<never>(() => {}), write: async () => { throw new Error('보내지 않는다'); } }));
    await s.direct.say({ t: 'end' });
    expect(m.of(s.code)).not.toEqual({});
    await tick(2_000);
    await p;
    await flush();
    expect([makes, m.of(s.code)]).toEqual([2, {}]);
  });

  for (const bad of ['make 가 던짐', 'write 거부', '답 없음'] as const) it(`P7bE01 새 연결도 ${bad}: 예외 0, 되풀이 0`, async () => {
    const r = await off('배치 실패');
    const noise = vi.spyOn(console, 'error');
    if (bad === 'make 가 던짐') r.made.fail = new DOMException('막힘', 'SecurityError');
    if (bad === 'write 거부') m.fail = quotaError();
    if (bad === '답 없음') vi.spyOn(m, 'write').mockImplementation(() => new Promise(() => {}));
    await r.s.direct.say({ t: 'end' });
    await tick(10_000);
    expect([r.made.n, r.deps.store.keys(r.s.code)]).toEqual([1, []]);
    await r.keep.direct.say({ t: 'end' });
    await tick(10_000);
    expect([r.made.n, r.deps.store.keys(r.keep.code), noise.mock.calls.length]).toEqual([2, [], 0]);
  });
});

describe('P7bE04 다시 열 때의 거울 맞춤', () => {
  for (const stop of [false, true]) for (const was of ['빈 거울', '다른 내용'] as const) it(`P7bE04 ${was}${stop ? ', 연 직후 저장이 멈춤(putAlive 가 던짐)' : ''}: 거울 = localStorage(alive 까지), 트랜잭션 하나. 그 뒤 강제 종료돼도 갈아 끼운다`, async () => {
    const k = await killed();
    m.data.clear();
    if (was === '다른 내용') for (const x of ['log:000099', 'alive']) m.data.set(hostKey(k.code, x), '[]');
    const n = m.batches.length;
    if (stop) k.store.fail = (x) => (x === hostKey(k.code, 'alive') ? quotaError() : null);
    freeze(1_000);
    const again = await mustOpen(k.code, k.deps);
    await flush();
    expect([again.storage.status, m.batches.length]).toEqual([stop ? 'stopped' : 'ok', n + 1]);
    expect(m.of(k.code)).toEqual(k.store.of(k.code));
    expect(m.data.get(hostKey(k.code, 'alive'))).toBe(k.store.data.get(hostKey(k.code, 'alive')));
    expect(m.data.has(hostKey(k.code, 'alive'))).toBe(true);
    again.close();
    await flush();
    // 강제 종료: localStorage 는 더 옛 시점으로
    const want = m.of(k.code);
    k.store.fail = () => null;
    k.store.data.set(hostKey(k.code, 'alive'), '1');
    k.store.data.set(hostKey(k.code, 'room'), k.old[hostKey(k.code, 'room')]);
    await boot(k.store);
    expect(k.store.of(k.code)).toEqual(want);
  });
});

describe('P7bE05 거울에만 있던 방을 만들다 던짐', () => {
  for (const bad of ['.log:', '.room', '.alive']) it(`P7bE05 ${bad} 에서: 넣은 그 방 키를 지운다. 다른 방·거울은 그대로, 다음에 다시 만든다`, async () => {
    const k = await killed();
    k.store.data.clear();
    const other = { [hostKey('BBBBBB', 'alive')]: '1' };
    k.store.data.set(...(Object.entries(other)[0] as [string, string]));
    const before = m.of(k.code);
    let n = 0;
    k.store.fail = (x) => (x.includes(`${k.code}${bad}`) && (bad !== '.log:' || ++n === 2) ? quotaError() : null); // 조각은 하나 넣고 둘째에서
    await boot(k.store);
    expect(k.store.ops.some((o) => o.startsWith(`set ${hostKey(k.code, '')}`))).toBe(true);
    expect(k.store.keys(k.code)).toEqual([]);
    expect(k.store.of('BBBBBB')).toEqual(other);
    await flush();
    expect(m.of(k.code)).toEqual(before);
    k.store.fail = () => null;
    await boot(k.store);
    expect(k.store.of(k.code)).toEqual(k.last);
    expect((await mustOpen(k.code, k.deps)).room.game!.log.slice(0, -1)).toEqual(k.game.log);
  });

  it('P7bE05 room 이 있는지 못 읽는 저장소에서는 아무것도 쓰거나 지우지 않는다', async () => {
    const k = await killed();
    const before = k.store.of(k.code);
    const get = k.store.getItem.bind(k.store);
    vi.spyOn(k.store, 'getItem').mockImplementation((x) => { if (x.endsWith('.room')) throw new Error('막힘'); return get(x); });
    k.store.fail = quotaError;
    await boot(k.store);
    expect(k.store.of(k.code)).toEqual(before);
  });
});

describe('P7bE06 갈아 끼우는 순서', () => {
  const isLog = (k: string) => k.includes('.log:');
  const sets = (k: Awaited<ReturnType<typeof killed>>, n: number) => k.store.ops.slice(n).filter((o) => o.startsWith('set ')).map((o) => o.slice(4));

  it('P7bE06 조각 → room → alive', async () => {
    const k = await killed();
    const n = k.store.ops.length;
    await boot(k.store);
    const order = sets(k, n);
    expect(order.slice(-2)).toEqual([hostKey(k.code, 'room'), hostKey(k.code, 'alive')]);
    expect(order.slice(0, -2).every(isLog)).toBe(true);
    expect(order.length).toBe(Object.keys(k.last).length);
  });

  it('P7bE06 room 에서 던짐: alive 는 옛것, 그대로 열면 옛 판의 시계가 거울 시각까지 깎이지 않는다. 다음에 다시 갈아 끼운다', async () => {
    const k = await killed();
    const alive = hostKey(k.code, 'alive');
    const old = new Map(k.store.data);
    k.store.fail = (x) => (x === hostKey(k.code, 'room') ? quotaError() : null);
    await boot(k.store);
    expect.soft(k.store.data.get(alive)).toBe(k.old[alive]);
    k.store.fail = () => null;
    const { lastTickAt } = rec(k.store, k.code);
    const half = new Map(k.store.data);
    const again = await mustOpen(k.code, k.deps);
    expect.soft(again.room.game!.clock.pausedAt).toBe(Math.max(Number(k.old[alive]), lastTickAt!));
    expect(Number(k.last[alive])).toBeGreaterThan(again.room.game!.clock.pausedAt!);
    again.close();
    await flush();
    // 열지 않고 다시 앱을 연 쪽: 거울이 여전히 새롭다
    m.data = new Map(Object.entries(k.last));
    k.store.data = half;
    expect(old.get(alive)).toBe(half.get(alive));
    await boot(k.store);
    expect(k.store.of(k.code)).toEqual(k.last);
  });

  it('P7bE06 alive 에서만 던짐: room 은 새것·alive 는 옛것, 다음에 다시 갈아 끼워 alive 도 새것', async () => {
    const k = await killed();
    const [room, alive] = [hostKey(k.code, 'room'), hostKey(k.code, 'alive')];
    k.store.fail = (x) => (x === alive ? quotaError() : null);
    await boot(k.store);
    expect([k.store.data.get(room), k.store.data.get(alive)]).toEqual([k.last[room], k.old[alive]]);
    k.store.fail = () => null;
    await boot(k.store);
    expect(k.store.of(k.code)).toEqual(k.last);
  });
});

describe('P7bE07 밀린 배치 가운데 첫째가 실패', () => {
  it('P7bE07 둘째의 write 0, 그 뒤 방 데이터도 0, Room 은 그대로 돈다', async () => {
    const sent: string[] = [];
    let no: (e: Error) => void = () => {};
    let makes = 0;
    await openMirror(() => { makes++; return { all: async () => new Map(), write: (ops) => { sent.push(ops[0][0]); return new Promise<void>((_, bad) => { no = bad; }); } }; });
    const { host, code } = await newHost();
    await tick(1_000); // 심박 배치가 밀린다
    await flush();
    expect(sent).toEqual([hostKey(code, 'room')]);
    no(quotaError());
    await flush();
    const d = new Direct(host);
    await d.say({ t: 'hello', charId: 0 });
    await d.say({ t: 'start' });
    await tick(5_000);
    expect([sent, makes]).toEqual([[hostKey(code, 'room')], 1]);
    expect([host.storage.status, host.room.game!.phase]).toEqual(['ok', 'playing']);
  });
});
