// 방장 기기 저장(PRD §9.5): 저장 → 방송 순서, 쓰기 실패, 용량 정리, 만료
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPIRE_MS, type RoomRec } from '../../../worker/room';
import { HostStorage, hostKey, sweepRooms, type SaveStatus } from '../storage';
import { Direct, FakeStore, Remote, atQuestion, fakeClock, fakeDeps, flush, freeze, mustOpen, newHost, quotaError, reopen, snap, started, tick } from './helpers';

beforeEach(fakeClock);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const rec = (store: FakeStore, code: string) => JSON.parse(store.data.get(hostKey(code, 'room'))!) as RoomRec;
const chunkKeys = (store: FakeStore, code: string) => store.keys(code).filter((k) => k.includes('.log:'));

/** 저장본을 같은 시각에 다시 연 판(PRD §3.7 확정 ②③): 자동 멈춤 하나와 사람 자리 끊김만 다르다 */
function reopened({ rec: r, game: g }: ReturnType<typeof snap>) {
  const at = r.lastTickAt;
  const pause = { ev: 'clock', kind: 'pause', remainingMs: g.clock.remainingMs, by: 'auto' };
  const claimed = (i: number) => r.seats[i].claimed;
  return {
    rec: {
      ...r, lastTickAt: null, cutsceneScan: r.cutsceneScan + 1,
      logLen: r.logLen + 1, logChunks: r.logChunks + 1, logBytes: r.logBytes + JSON.stringify([pause]).length,
      seats: r.seats.map((s: object, i: number) => (claimed(i) ? { ...s, connected: false, lastSeen: at, offSince: at } : s)),
    },
    game: {
      ...g, phase: 'paused', clock: { ...g.clock, pausedAt: at }, log: [...g.log, pause],
      seats: g.seats.map((s: object, i: number) => (claimed(i) ? { ...s, connected: false } : s)),
    },
  };
}

describe('한 번의 처리', () => {
  it('P1E06 room·새 로그 조각이 첫 방송 send 보다 먼저 쓰이고, 버리고 새로 열면 방금 방송한 상태와 같다', async () => {
    const { host, deps, store, code, direct, remotes } = await atQuestion(1);
    const seq: string[] = [];
    vi.spyOn(store, 'setItem').mockImplementation((k, v) => { seq.push(k); store.data.set(k, v); });
    vi.spyOn(remotes[0], 'send').mockImplementation((s) => { const m = JSON.parse(s); remotes[0].sent.push(m); seq.push(m.t); });
    await direct.say({ t: 'act', a: { type: 'answer', choice: 0, ms: 1_000 } });
    const first = seq.indexOf('state');
    expect(seq.slice(0, first)).toEqual([expect.stringContaining('.log:'), hostKey(code, 'room')]);
    expect(seq.slice(first).filter((x) => x.startsWith('tw.host.'))).toEqual([]);
    const st = remotes[0].last('state')!;
    const want = snap(host);
    host.close();
    const again = await mustOpen(code, deps);
    expect(snap(again)).toEqual(reopened(want));
    expect(st.logFrom + st.log.length).toBe(again.room.game!.log.length - 1);
    expect(st.game!.turn.step).toBe(again.room.game!.turn.step);
  });
});

describe('P1E07 쓰기 실패', () => {
  it('P1E07 ⓐ 처음부터 막힘: 판은 메모리로 계속, 상태 never, 그 뒤 쓰기 0, 새 어댑터는 없는 방', async () => {
    const deps = fakeDeps();
    deps.store.fail = () => Object.assign(new Error('blocked'), { name: 'SecurityError' });
    const seen: SaveStatus[] = [];
    const { host, store, code } = await newHost(deps);
    host.storage.subscribe((s) => seen.push(s));
    expect(host.storage.status).toBe('never');
    const n = store.touched(code);
    expect(n).toBe(1); // 첫 room 쓰기 하나뿐
    const direct = new Direct(host);
    await direct.say({ t: 'hello', charId: 0 });
    await direct.say({ t: 'start' });
    await tick(60_000);
    expect(host.room.game!.log.length).toBeGreaterThan(5);
    expect(store.touched(code)).toBe(n);
    host.close();
    expect(await reopen(code, deps)).toBe('none');
  });

  it('P1E07 ⓐ localStorage 자체가 없는 곳도 같다', async () => {
    const { host } = await newHost({ ...fakeDeps(), store: null as never });
    expect(host.storage.status).toBe('never');
    const direct = new Direct(host);
    await direct.say({ t: 'hello', charId: 0 });
    expect(direct.last('welcome')).toMatchObject({ seat: 0 });
  });

  for (const [tag, bad] of [['ⓑ 로그 조각', '.log:'], ['ⓒ 조각 뒤 room', '.room']] as const) {
    it(`P1E07 ${tag} 쓰기에서: 예외 없이 계속, 상태 stopped, 쓰기 0(alive 포함), 다시 열면 마지막 온전한 저장본`, async () => {
      const { host, deps, store, code, direct, remotes } = await atQuestion(1);
      const seen: SaveStatus[] = [];
      host.storage.subscribe((s) => seen.push(s));
      const want = snap(host);
      const chunks = host.room.rec!.logChunks;
      store.fail = (k) => (k.includes(bad) ? quotaError() : null);
      await direct.say({ t: 'act', a: { type: 'answer', choice: 0, ms: 1_000 } });
      expect(host.storage.status).toBe('stopped');
      expect(seen).toEqual(['stopped']);
      expect(host.room.game!.turn.step).toBe('explanation'); // 메모리로 계속
      expect(remotes[0].last('state')!.game!.turn.step).toBe('explanation');
      expect(chunkKeys(store, code).length).toBe(bad === '.room' ? chunks + 1 : chunks);
      const n = store.touched(code);
      store.fail = () => null; // 자리가 다시 나도 이 탭은 더 쓰지 않는다
      await tick(3_000);
      await direct.say({ t: 'pause' });
      expect(store.touched(code)).toBe(n);
      host.close();
      vi.setSystemTime(want.rec.lastTickAt);
      const again = await mustOpen(code, deps);
      expect(snap(again)).toEqual(reopened(want));
      expect(again.room.game!.log.length).toBe(again.room.rec!.logLen);
      expect(chunkKeys(store, code).length).toBe(chunks + 1); // 남은 조각 대신 자동 멈춤 조각
      expect(JSON.parse(store.data.get(chunkKeys(store, code).at(-1)!)!)).toEqual([again.room.game!.log.at(-1)]);
      expect(again.storage.status).toBe('ok');
    });
  }

  it('P1E18 저장 멈춤 뒤 5분 더 논 다음 새로고침: 시계는 실패 시각까지만, 자동 멈춤, 저장 다시 시도, 조각 번호 이어짐', async () => {
    const { host, deps, store, code, direct } = await atQuestion(1);
    await tick(2_500);
    const chunks = rec(store, code).logChunks;
    store.fail = (k) => (k.includes('.log:') ? quotaError() : null);
    const failAt = Date.now();
    await direct.say({ t: 'act', a: { type: 'answer', choice: 0, ms: 1_000 } });
    expect(host.storage.status).toBe('stopped');
    const left = host.room.game!.clock.remainingMs;
    await tick(300_000);
    expect(left - host.room.game!.clock.remainingMs).toBeGreaterThan(200_000); // 그동안 판은 정말 흘렀다
    host.close();
    store.fail = () => null;
    const again = await mustOpen(code, deps);
    expect(again.room.game!.phase).toBe('paused');
    expect(again.room.game!.turn.step).toBe('question');
    expect(Math.abs(again.room.game!.clock.remainingMs - left)).toBeLessThanOrEqual(1_200);
    expect(Math.abs(again.room.game!.clock.pausedAt! - failAt)).toBeLessThanOrEqual(1_200);
    expect(again.storage.status).toBe('ok');
    expect(rec(store, code).logChunks).toBe(chunks + 1); // 자동 멈춤 로그 하나
    expect(chunkKeys(store, code).at(-1)).toBe(hostKey(code, `log:${String(chunks).padStart(6, '0')}`));
    const next = await (async () => { again.close(); return mustOpen(code, deps); })();
    expect(snap(next)).toEqual(snap(again));
  });
});

describe('P1E19 용량 정리', () => {
  const other = (store: FakeStore, code: string, o: { phase: string | null; last: number; alive?: number; pad?: number }) => {
    store.data.set(hostKey(code, 'room'), JSON.stringify({
      code, expiresAt: Date.now() + EXPIRE_MS, lastActiveAt: o.last, logChunks: 1, game: o.phase && { phase: o.phase },
    }));
    store.data.set(hostKey(code, 'log:000000'), 'x'.repeat(o.pad ?? 1_000));
    store.data.set(hostKey(code, 'alive'), String(o.alive ?? o.last));
  };
  const dump = (store: FakeStore, code: string) => store.keys(code).map((k) => [k, store.data.get(k)]);
  const KEEP = ['PAUSED', 'LBBYYY', 'TABTAB'];

  /** 방 넷 + 다른 탭이 돌리는 끝난 판 하나 */
  async function crowded() {
    const s = await atQuestion(1);
    const t = Date.now();
    other(s.store, 'NEWFNN', { phase: 'finished', last: t - 60_000 });
    other(s.store, 'QLDFNN', { phase: 'finished', last: t - 600_000 });
    other(s.store, 'PAUSED', { phase: 'paused', last: t - 9_000_000 });
    other(s.store, 'LBBYYY', { phase: null, last: t - 9_000_000 });
    other(s.store, 'TABTAB', { phase: 'finished', last: t - 9_000_000, alive: t - 2_900 });
    const keep = KEEP.map((c) => dump(s.store, c));
    const answer = () => s.direct.say({ t: 'act', a: { type: 'answer', choice: 0, ms: 1_000 } });
    return { ...s, keep, answer };
  }

  it('P1E19 오래된 끝난 판 하나만 지우고 다시 써서 성공 → 거기서 멈춤', async () => {
    const { host, store, keep, answer, code } = await crowded();
    store.cap = store.chars();
    await answer();
    expect(host.storage.status).toBe('ok');
    expect(store.keys('QLDFNN')).toEqual([]);
    expect(store.keys('NEWFNN').length).toBe(3);
    expect(KEEP.map((c) => dump(store, c))).toEqual(keep);
    expect(rec(store, code).logLen).toBe(host.room.game!.log.length); // 실패한 쓰기를 다시 했다
  });

  it('P1E19 다 지워도 안 되면 저장 멈춤. 진행 중인 판·대기실·다른 탭 방과 이 방 저장본은 그대로', async () => {
    const { host, store, keep, answer, code } = await crowded();
    const mine = dump(store, code);
    store.cap = 0;
    await answer();
    expect(host.storage.status).toBe('stopped');
    expect([...store.keys('QLDFNN'), ...store.keys('NEWFNN')]).toEqual([]);
    expect(store.ops.filter((o) => o.startsWith('del ')).map((o) => o.split('.')[2])).toEqual(['QLDFNN', 'QLDFNN', 'QLDFNN', 'NEWFNN', 'NEWFNN', 'NEWFNN']); // 오래된 것부터
    expect(KEEP.map((c) => dump(store, c))).toEqual(keep);
    expect(dump(store, code)).toEqual(mine);
  });

  it('P1E19 지울 것이 없으면 저장 멈춤', async () => {
    const { host, store, answer } = await crowded();
    for (const c of ['QLDFNN', 'NEWFNN']) for (const k of store.keys(c)) store.data.delete(k);
    store.cap = 0;
    await answer();
    expect(host.storage.status).toBe('stopped');
    expect(store.ops.some((o) => o.startsWith('del '))).toBe(false);
  });

  it('P1bE12 다른 방이 만료된 멈춘 판뿐이면 그것을 지우고 다시 쓴다. 만료 안 된 판은 그대로', async () => {
    const { host, store, code, answer } = await crowded();
    for (const c of ['QLDFNN', 'NEWFNN', 'TABTAB', 'LBBYYY']) for (const k of store.keys(c)) store.data.delete(k);
    other(store, 'EXPRED', { phase: 'paused', last: Date.now() - EXPIRE_MS - 1 });
    const k = hostKey('EXPRED', 'room');
    store.data.set(k, JSON.stringify({ ...JSON.parse(store.data.get(k)!), expiresAt: Date.now() - 1 }));
    const keep = dump(store, 'PAUSED');
    store.cap = store.chars();
    await answer();
    expect(host.storage.status).toBe('ok');
    expect(store.keys('EXPRED')).toEqual([]);
    expect(dump(store, 'PAUSED')).toEqual(keep);
    expect(rec(store, code).logLen).toBe(host.room.game!.log.length);
  });

  it('P1E19 용량 말고 다른 예외(SecurityError)는 아무것도 지우지 않는다', async () => {
    const { host, store, answer } = await crowded();
    store.fail = () => Object.assign(new Error('x'), { name: 'SecurityError' });
    await answer();
    expect(host.storage.status).toBe('stopped');
    expect(store.ops.some((o) => o.startsWith('del '))).toBe(false);
  });
});

describe('키', () => {
  it('P1E08 list 는 키 사전순, 다른 방·tw.seat·소리 설정은 list·deleteAll 에 안 걸린다', async () => {
    const store = new FakeStore();
    const others = { 'tw.seat': '{}', 'tw.sound': '1', [hostKey('BBBBBB', 'log:000000')]: 'b', [hostKey('BBBBBB', 'room')]: '{}' };
    for (const [k, v] of Object.entries(others)) store.data.set(k, v);
    const s = new HostStorage(store as never, 'AAAAAA');
    for (const n of [10, 2, 0, 9, 1]) s.kv.put(`log:${String(n).padStart(6, '0')}`, `v${n}`);
    s.kv.put('room', '{}');
    expect([...s.kv.list({ prefix: 'log:' })]).toEqual([['log:000000', 'v0'], ['log:000001', 'v1'], ['log:000002', 'v2'], ['log:000009', 'v9'], ['log:000010', 'v10']]);
    s.deleteAll();
    expect(store.keys('AAAAAA')).toEqual([]);
    expect(Object.fromEntries(store.data)).toEqual(others);
    expect(s.kv.get('room')).toBeUndefined();
  });

  it('P1E09 앱을 열 때: 지난 방 둘과 깨진 방은 키 전부 삭제, 살아 있는 끝난 판은 그대로', () => {
    const store = new FakeStore();
    const put = (code: string, room: string) => { store.data.set(hostKey(code, 'room'), room); store.data.set(hostKey(code, 'log:000000'), '[]'); store.data.set(hostKey(code, 'alive'), '1'); };
    const t = Date.now();
    put('GQNEAA', JSON.stringify({ expiresAt: t - 1 }));
    put('GQNEBB', JSON.stringify({ expiresAt: t }));
    put('LVVEAA', JSON.stringify({ expiresAt: t + 1, game: { phase: 'finished' } }));
    put('BRKNAA', '{"code":"BRK');
    store.data.set('tw.seat', 'x');
    expect(() => sweepRooms(store as never)).not.toThrow();
    expect([...store.data.keys()].sort()).toEqual([...store.keys('LVVEAA'), 'tw.seat'].sort());
    expect(store.keys('LVVEAA').length).toBe(3);
    expect(() => sweepRooms(null)).not.toThrow();
  });

  it('P1E09 방을 불러올 때도 지난 방·깨진 방은 지우고 없는 방', async () => {
    const { host, deps, store, code } = await started();
    host.close();
    freeze(EXPIRE_MS + 1);
    expect(await reopen(code, deps)).toBe('none');
    expect(store.keys(code)).toEqual([]);
    store.data.set(hostKey('BRKNAA', 'room'), '{');
    expect(await reopen('BRKNAA', deps)).toBe('none');
    expect(store.keys('BRKNAA')).toEqual([]);
    expect(deps.locks!.held.size).toBe(0); // 못 열었으면 잠금도 놓는다
  });

  for (const locks of [true, false]) {
    it(`P1bE14 getItem 이 던지면 지우지 않는다: 열기 broken, 청소는 건너뜀, 만들기는 메모리로(${locks ? 'Web Locks' : '신선도'})`, async () => {
      const deps = fakeDeps(undefined, locks ? undefined : null);
      const { host, store, code } = await started(1, deps);
      host.close();
      freeze(EXPIRE_MS + 1); // 읽을 수 있었다면 지울 만큼 지난 방
      const before = [...store.data];
      store.ops.length = 0;
      store.getItem = () => { throw Object.assign(new Error('x'), { name: 'SecurityError' }); };
      expect(() => sweepRooms(store as never)).not.toThrow();
      expect(await reopen(code, deps)).toBe('broken');
      expect(await reopen(code, deps)).toBe('broken'); // 잠금이 남지 않는다
      store.fail = () => Object.assign(new Error('x'), { name: 'SecurityError' });
      const made = await newHost(deps);
      expect(made.host.storage.status).toBe('never');
      expect(store.ops.some((o) => o.startsWith('del '))).toBe(false);
      expect([...store.data]).toEqual(before);
    });
  }

  it('P1bE14 키 목록을 못 읽어도 로그 없는 판으로 열지 않고 broken', async () => {
    const { host, store, code, deps } = await started(1);
    host.close();
    store.key = () => { throw new Error('x'); };
    expect(() => sweepRooms(store as never)).not.toThrow();
    expect(await reopen(code, deps)).toBe('broken');
    expect(store.data.has(hostKey(code, 'room'))).toBe(true);
  });

  it('P1bE14 용량 정리 중 읽기가 던지는 방은 지우지 않는다', async () => {
    const { host, store, direct } = await atQuestion(1);
    store.data.set(hostKey('QLDFNN', 'room'), JSON.stringify({ expiresAt: Date.now() + 1, lastActiveAt: 1, game: { phase: 'finished' } }));
    store.getItem = () => { throw new Error('x'); };
    store.fail = quotaError;
    await direct.say({ t: 'act', a: { type: 'answer', choice: 0, ms: 1_000 } });
    expect(host.storage.status).toBe('stopped');
    expect(store.keys('QLDFNN').length).toBe(1);
  });

  /** 로그 조각 넷 이상인 판을 닫아 두고 조각을 망가뜨린 뒤 두 번 연다. 저장소는 바이트 단위로 그대로여야 한다 */
  const BAD: [string, (store: FakeStore, keys: string[]) => void][] = [
    ['가운데 조각이 빠짐', (st, k) => { st.data.delete(k[1]); }],
    ['마지막 조각이 빠짐', (st, k) => { st.data.delete(k.at(-1)!); }],
    ['조각 전부 빠짐', (st, k) => { for (const x of k) st.data.delete(x); }],
    ['[] 조각', (st, k) => { st.data.set(k[1], '[]'); }],
    ['"abc" 조각', (st, k) => { st.data.set(k[1], '"abc"'); }],
    ['길이가 같은 문자열 조각', (st, k) => { st.data.set(k[1], JSON.stringify('a'.repeat(JSON.parse(st.data.get(k[1])!).length))); }],
    ['[null] 조각', (st, k) => { st.data.set(k[1], JSON.stringify(JSON.parse(st.data.get(k[1])!).map(() => null))); }],
    ['ev 없는 객체 조각', (st, k) => { st.data.set(k[1], JSON.stringify(JSON.parse(st.data.get(k[1])!).map(() => ({ seat: 0 })))); }],
    ['ev 가 글자가 아님', (st, k) => { st.data.set(k[1], JSON.stringify(JSON.parse(st.data.get(k[1])!).map(() => ({ ev: 1 })))); }],
  ];
  for (const [tag, spoil] of BAD) for (const leftover of [false, true]) {
    it(`P1bE16 ${tag}${leftover ? ' + 저장 멈춤으로 남은 조각' : ''}: broken, 저장소는 그대로`, async () => {
      const { host, deps, store, code } = await atQuestion(1);
      host.close();
      const keys = chunkKeys(store, code);
      expect(keys.length).toBeGreaterThanOrEqual(3);
      if (leftover) store.data.set(hostKey(code, `log:${String(rec(store, code).logChunks).padStart(6, '0')}`), '[{"ev":"dice","seat":0,"d1":1,"d2":2}]');
      spoil(store, keys);
      const before = [...store.data];
      const n = store.touched(code);
      for (let i = 0; i < 3; i++) expect(await reopen(code, deps)).toBe('broken');
      expect([...store.data]).toEqual(before);
      expect(store.touched(code)).toBe(n);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it('P1bE16 정상 판은 그대로 열린다: 대기실(로그 0)·방금 시작한 판·멈춤·남은 조각(깨진 것이어도 로그가 아니다)', async () => {
    const lobby = await newHost();
    const fresh = await started(0);
    const paused = await atQuestion(1);
    await paused.direct.say({ t: 'pause' });
    const left = await atQuestion(1);
    const extra = (s: typeof left) => hostKey(s.code, `log:${String(rec(s.store, s.code).logChunks).padStart(6, '0')}`);
    for (const s of [paused, left]) s.store.data.set(extra(s), '[{"ev":');
    for (const s of [lobby, fresh, paused, left]) {
      s.host.close();
      const log = s.host.room.game?.log.length ?? 0;
      const again = await mustOpen(s.code, s.deps);
      if (s === paused) expect(s.store.data.has(extra(paused))).toBe(false); // 남은 조각은 지워진다
      const added = again.room.game && s !== paused ? 1 : 0; // 진행 중이던 판의 자동 멈춤
      expect(again.room.game?.log.length ?? 0).toBe(log + added);
      expect(again.room.rec!.logLen).toBe(log + added);
      again.close();
      expect(typeof await reopen(s.code, s.deps)).toBe('object'); // 다시 연 판도 온전하다
    }
  });

  it('P1bE16 저장소 읽기가 잠금 확인 도중 던져도 openHostRoom 은 거부되지 않고 broken', async () => {
    const { host, store, code, deps } = await started(1, fakeDeps(undefined, null));
    host.close();
    const real = store.getItem.bind(store);
    let n = 0;
    store.getItem = (k) => { if (n++ > 0) throw new Error('x'); return real(k); };
    expect(await reopen(code, deps)).toBe('broken');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('P1E09 열어 둔 채 14일이 지나면 알람이 닫고 지운다', async () => {
    const { host, store, code, deps } = await newHost();
    const r = new Remote(host);
    for (let i = 0; i < 15; i++) { freeze(86_400_000); await tick(1_000); }
    await flush();
    expect(r.closes).toEqual([1001]);
    expect(store.keys(code)).toEqual([]);
    expect(deps.locks!.held.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
