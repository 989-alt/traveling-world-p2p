// 방장 기기 흐름: 진짜 GameClient + 진짜 HostRoom(가짜 저장소·잠금·시계) + 가짜 PeerHost(시험이 상태를 낸다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('peerjs', async () => ({ default: (await import('../../net/__tests__/fakes')).FakePeer }));
import { createHostRoom, openHostRoom, type HostDeps, type HostRoom } from '../../host/host-room';
import { FakeLocks, FakeStore, fakeClock, flush, Remote, tick } from '../../host/__tests__/helpers';
import { hostKey } from '../../host/storage';
import { NET } from '../../net/config';
import type { HostNetState, PeerHostOpts, RemoteRoom } from '../../net/peer-host';
import type { SocketLike } from '../../net/socket';
import { GameClient, LATE_MS } from '../client';
import { createHost, openHost, type HostNetDeps } from '../host-net';
import { loadSeat, saveSeat } from '../seat-store';
import { hostCover } from '../store';

/** 시험이 상태를 내는 PeerHost. close 의 약속은 done() 을 불러야 끝난다 */
class FakeNet {
  closes = 0;
  closed = false;
  done = () => {};
  constructor(public room: RemoteRoom, public o: PeerHostOpts) {}
  state(s: HostNetState) { this.o.onState!(s); }
  async taken() { const r = await this.o.repick!(); if (r) this.room = r; else this.state('failed'); await flush(); return r as HostRoom | null; }
  close() { this.closes++; return new Promise<void>((ok) => { this.done = () => { this.closed = true; ok(); }; }); }
}

/** 한 기기: 저장소·잠금은 탭끼리 같이 쓴다 */
function device(store = new FakeStore(), locks = new FakeLocks()) {
  vi.stubGlobal('localStorage', store);
  const rooms: HostRoom[] = [];
  const opened: string[] = [];
  const keep = <T>(r: T) => { if (r && typeof r === 'object') rooms.push(r as unknown as HostRoom); return r; };
  const deps = { store, locks } as unknown as HostDeps;
  /** 탭 하나 */
  const tab = () => {
    const nets: FakeNet[] = [];
    const d: HostNetDeps = {
      peer: (room, o) => { const n = new FakeNet(room, o); nets.push(n); return n; },
      create: async (s) => keep(await createHostRoom(s, deps)),
      open: async (code) => { opened.push(code); return keep(await openHostRoom(code, deps)); },
    };
    const seen = new Set<string>();
    const socks: SocketLike[] = [];
    const c = new GameClient(() => { const s: SocketLike = { readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }; socks.push(s); return s; }, undefined,
      async () => ({ createHost: (s) => createHost(s, d), openHost: (code) => openHost(code, d) }));
    // 화면에 코드가 보이는 조건(Lobby: 등록이 열렸고 대기실)
    c.subscribe((s) => { if (s.room && s.host?.net === 'open') seen.add(s.room.code); });
    return { c, nets, seen, socks };
  };
  return { store, locks, rooms, opened, tab, ...tab() };
}
const make = async (d: ReturnType<typeof device>, charId?: number) => {
  expect(await d.c.create({ totalMinutes: 40 })).toBe(true);
  await flush();
  if (charId !== undefined) { d.c.join(charId); await flush(); }
};
/** 앞 탭이 사라지고(저장본만 남음) 새 탭이 저장 자리로 자동 복귀 */
async function reload(d: ReturnType<typeof device>) {
  for (const r of d.rooms) r.close();
  await flush();
  const t = d.tab();
  expect(t.c.resumeSaved()).toBe(true);
  expect(t.c.state.host).toMatchObject({ net: 'opening', restored: true });
  await tick(0);
  await flush();
  return t;
}

beforeEach(fakeClock);
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('P3E23 코드 다시 뽑기', () => {
  for (const charId of [undefined, 3]) it(`P3E23 ${charId === undefined ? '캐릭터를 고르기 전' : '고른 뒤'}: 옛 방·잠금·저장본이 사라지고 새 방 하나, 보이는 코드는 등록된 것 하나, 자리·캐릭터는 그대로`, async () => {
    const d = device();
    await make(d, charId);
    const codes = [d.nets[0].room.code];
    for (let i = 0; i < 2; i++) {
      const old = d.rooms.at(-1)!;
      const next = (await d.nets[0].taken())!;
      codes.push(next.code);
      expect(next.code).not.toBe(old.code);
      expect(d.store.keys(old.code)).toEqual([]);
      expect([...d.locks.held]).toEqual([`tw.host.${next.code}`]);
      const port = new Remote(old); // 닫힌 방
      expect(port.closes).toEqual([1008]);
    }
    expect(d.nets).toHaveLength(1);
    d.nets[0].state('open');
    expect([...d.seen]).toEqual([codes[2]]);
    const room = d.rooms[2].room.rec!;
    if (charId === undefined) {
      expect([d.c.state.seat, room.seats[0].claimed]).toEqual([null, false]);
      d.c.join(1);
      await flush();
    } else expect(room.seats[0]).toMatchObject({ claimed: true, charId });
    expect([d.c.state.seat, d.c.state.room!.hostSeat, d.c.state.room!.code]).toEqual([0, 0, codes[2]]);
    expect(loadSeat()).toEqual({ roomCode: codes[2], seatNo: 0, seatPin: d.rooms[2].room.rec!.seats[0].pin });
    await tick(60_000); // 옛 방의 심박·알람은 돌지 않는다
    for (const c of codes.slice(0, 2)) expect(d.store.keys(c)).toEqual([]);
    d.c.leave();
    d.nets[0].done();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('P3E23 5번 다 겹침(failed): 남은 방은 하나, 출발할 수 있다. 다시 연결하면 같은 방으로 새로 등록', async () => {
    const d = device();
    await make(d, 0);
    for (let i = 0; i < 5; i++) await d.nets[0].taken();
    d.nets[0].state('failed');
    const left = d.rooms.at(-1)!;
    expect(d.c.state.host).toMatchObject({ net: 'failed', restored: false });
    expect([...d.seen]).toEqual([]);
    expect([...d.locks.held]).toEqual([`tw.host.${left.code}`]);
    expect([...d.store.data.keys()].filter((k) => k.endsWith('.room'))).toEqual([hostKey(left.code, 'room')]);
    d.c.retryHost();
    expect([d.nets.length, d.nets[0].closes, d.nets[1].room === left, d.c.state.host!.net]).toEqual([2, 1, true, 'wait']);
    d.nets[0].state('open'); // 닫은 것의 늦은 답
    expect(d.c.state.host!.net).toBe('wait');
    d.nets[1].state('offline');
    d.store.fail = () => new Error('막힘'); // 바뀐 방의 저장 상태를 본다
    await tick(1_000);
    expect(d.c.state.host!.save).toBe('stopped');
    expect(d.c.send({ t: 'start' })).toBe(true);
    await flush();
    expect(d.c.state.room!.phase).toBe('playing');
  });

  it('P3E23 새 방을 못 만들거나 이미 출발했거나 만드는 사이 떠났으면 null: 옛 방은 그대로 · 남는 방 0', async () => {
    const d = device();
    await make(d, 0);
    const [room] = d.rooms;
    d.store.cap = 0; // 저장이 막혀도 방은 만들어진다 → 잠금으로 막는다
    vi.spyOn(d.locks, 'request').mockImplementation(async (_n, _o, cb) => cb(null));
    expect(await d.nets[0].o.repick!()).toBeNull();
    expect([d.c.state.seat, d.rooms.length]).toEqual([0, 1]);
    vi.restoreAllMocks();
    d.store.cap = Infinity;
    const p = d.nets[0].o.repick!();
    d.c.send({ t: 'start' }); // 만드는 사이 출발
    expect(await p).toBeNull();
    await flush();
    expect([d.c.state.room!.code, d.c.state.room!.phase]).toEqual([room.code, 'playing']);
    expect(d.store.keys(d.rooms[1].code)).toEqual([]);
    expect(await d.nets[0].o.repick!()).toBeNull();
    expect(d.rooms).toHaveLength(2);
    expect([...d.locks.held]).toEqual([`tw.host.${room.code}`]);

    const e = device();
    await make(e);
    const q = e.nets[0].o.repick!();
    e.c.leave();
    expect(await q).toBeNull();
    await flush();
    expect([...e.locks.held]).toEqual([]);
    expect(e.store.keys(e.rooms[1].code)).toEqual([]);
  });
});

describe('P3E24 저장된 방을 다시 여는 중', () => {
  async function restored(start = true) {
    const d = device();
    await make(d, 2);
    if (start) { d.c.send({ t: 'start' }); await flush(); }
    await tick(3_000);
    const code = d.rooms[0].code;
    const t = await reload(d);
    expect(t.c.state).toMatchObject({ seat: 0, code, host: { net: 'wait', restored: true } });
    expect(t.nets).toHaveLength(1);
    expect(t.nets[0].o.repick).toBeUndefined();
    return { d, code, ...t };
  }

  it('P3E24 직결 rejoin 이 끝난 뒤에 등록한다. 돌던 판은 멈춤 모달, 방장이 멈춰 둔 판은 이어 하기 화면', async () => {
    const d = device();
    await make(d, 2);
    d.c.send({ t: 'start' });
    await flush();
    for (const r of d.rooms) r.close();
    await flush();
    const t = d.tab();
    let seatAtRegister: unknown = 'no';
    const push = t.nets.push.bind(t.nets);
    t.nets.push = (n) => { seatAtRegister = [t.c.state.seat, (n.room as HostRoom).room.rec!.seats[0].connected]; return push(n); };
    t.c.resumeSaved();
    await flush();
    expect(seatAtRegister).toEqual([0, true]);
    expect(t.c.state.room!.phase).toBe('paused');
    expect(t.c.state.pins).toEqual([{ seat: 0, pin: t.c.state.pin }]); // 멈춤 모달
    t.c.send({ t: 'resume' });
    await flush();
    expect([t.c.state.room!.phase, t.c.state.pins]).toEqual(['playing', null]);
    t.c.send({ t: 'pause' });
    await flush();
    const u = await reload(d);
    expect([u.c.state.room!.phase, u.c.state.pins]).toEqual(['paused', null]); // 이어 하기 화면
  });

  it('P3E24 failed → [다시 해 보기]: 앞 PeerHost 를 닫고 같은 방으로 새로 등록, 저장본을 다시 읽지 않는다', async () => {
    const r = await restored();
    const room = r.d.rooms.at(-1)!;
    r.nets[0].state('failed');
    expect(r.c.state.host).toMatchObject({ net: 'failed', restored: true });
    const reads = r.d.store.ops.filter((o) => o.startsWith('get')).length;
    r.c.retryHost();
    await flush();
    expect([r.nets[0].closes, r.nets.length, r.nets[1].room === room, r.d.opened.length]).toEqual([1, 2, true, 1]);
    expect(r.d.store.ops.filter((o) => o.startsWith('get')).length).toBe(reads);
    expect(r.c.state.host!.net).toBe('wait');
    r.nets[1].state('open');
    expect([r.c.state.host!.net, r.c.state.room!.phase]).toEqual(['open', 'paused']);
  });

  it('P3E24 failed → [처음 화면으로]: PeerHost·HostRoom 을 닫고(곧바로 다시 열 수 있다) 저장 자리만 지운다', async () => {
    const r = await restored();
    r.nets[0].state('failed');
    const keys = r.d.store.keys(r.code);
    r.c.leave();
    expect([r.c.state.code, r.c.state.host, loadSeat(), r.nets[0].closes]).toEqual([null, null, null, 1]);
    await flush();
    expect([...r.d.locks.held]).toEqual([]);
    expect(r.d.store.keys(r.code)).toEqual(keys);
    r.c.open(r.code); // 같은 코드를 넣으면 방장으로 다시 열린다(PIN 없이)
    await tick(0);
    await flush();
    expect(r.c.state).toMatchObject({ seat: 0, host: { net: 'wait', restored: true } });
    r.nets[0].done();
    await flush();
    expect(r.c.state.seat).toBe(0);
  });

  it('P3E24 offline(판 중): 멈춤 모달로 가고 [게임 계속하기]가 된다. 뒤늦은 open 은 화면 변화 0', async () => {
    const r = await restored();
    r.nets[0].state('offline');
    expect(r.c.state).toMatchObject({ host: { net: 'offline', restored: true }, room: { phase: 'paused' } });
    expect(r.c.state.pins).not.toBeNull();
    r.c.send({ t: 'resume' });
    await flush();
    expect(r.c.state.room!.phase).toBe('playing');
    const before = { ...r.c.state, host: null };
    r.nets[0].state('open');
    expect({ ...r.c.state, host: null }).toEqual(before);
  });

  it('P3E24 offline(대기실) → open 이면 코드가 보인다. 다른 창이 돌리는 방은 busy, 저장 자리는 그대로', async () => {
    const r = await restored(false);
    r.nets[0].state('offline');
    expect([r.c.state.host!.net, r.c.state.room!.phase, [...r.seen]]).toEqual(['offline', 'lobby', []]);
    r.nets[0].state('open');
    expect([...r.seen]).toEqual([r.code]);
    const n = r.d.store.touched(r.code);
    const u = r.d.tab();
    u.c.resumeSaved();
    await flush();
    expect(u.c.state.host).toMatchObject({ net: 'busy' });
    u.c.home();
    expect([u.c.state.code, loadSeat()?.roomCode, r.d.store.touched(r.code)]).toEqual([null, r.code, n]);
  });

  it('저장본이 깨진 방: broken → [다시 해 보기]도 broken, [처음 화면으로]는 저장 자리만 지운다', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = device();
    await make(d, 2);
    d.c.send({ t: 'start' });
    await flush();
    const code = d.rooms[0].code;
    d.rooms[0].close();
    await flush();
    d.store.data.set(hostKey(code, 'log:000000'), '[{"ev"');
    const t = d.tab();
    t.c.resumeSaved();
    for (let i = 0; i < 2; i++) {
      await flush();
      expect(t.c.state.host!.net).toBe('broken');
      if (!i) { t.c.retryHost(); expect(t.c.state.host!.net).toBe('opening'); }
    }
    const keys = d.store.keys(code);
    t.c.leave();
    expect([loadSeat(), d.store.keys(code), [...d.locks.held], t.nets.length]).toEqual([null, keys, [], 0]);
  });

  it('만료돼 열 것이 없으면(none) 학생으로 붙는다', async () => {
    const d = device();
    await make(d, 2);
    const code = d.rooms[0].code;
    d.rooms[0].close();
    await flush();
    vi.setSystemTime(Date.now() + 15 * 86_400_000);
    const t = d.tab();
    t.c.open(code);
    await flush();
    expect([t.c.state.host, t.c.state.conn, t.socks.length]).toEqual([null, 'connecting', 1]);
  });
});

describe('P3E25 방이 끝남', () => {
  const ways: [string, (d: ReturnType<typeof device>) => Promise<void>][] = [
    ['방장 [게임 끝내기]', async (d) => { expect(d.c.endGame()).toBe(true); await flush(); }],
    ['방장 자리에서 leave', async (d) => { d.c.leaveGame(); await flush(); }],
    ['만료(직결이 1001 로 닫힘)', async (d) => { d.rooms[0].room.rec!.expiresAt = Date.now(); await d.rooms[0].room.alarm(); await flush(); }],
  ];
  for (const [name, end] of ways) it(`P3E25 ${name}: PeerHost.close 한 번, 화면은 기다리지 않고 첫 화면, 방 키 0건, 새 방을 만들 수 있다`, async () => {
    const d = device();
    await make(d, 0);
    d.nets[0].state('open');
    d.c.send({ t: 'start' });
    await flush();
    const code = d.rooms[0].code;
    const remote = new Remote(d.rooms[0]);
    await end(d);
    expect([d.c.state.code, d.c.state.room, d.c.state.bye, d.c.state.host, loadSeat()]).toEqual([null, null, null, null, null]);
    expect([d.nets[0].closes, d.nets[0].closed]).toEqual([1, false]); // 닫힘 프레임이 나가는 중
    expect(remote.closes).toEqual([name.startsWith('만료') ? 1001 : 4001]);
    expect(d.store.keys(code)).toEqual([]);
    expect([...d.locks.held]).toEqual([]);
    await make(d, 1);
    expect(d.c.state).toMatchObject({ seat: 0, host: { net: 'wait', restored: false } });
    d.nets[0].state('open'); // 앞 방의 늦은 알림
    expect(d.c.state.host!.net).toBe('wait');
    d.nets[0].done();
    await tick(10_000);
    expect([d.nets[0].closes, d.nets.length, d.store.keys(code).length, d.c.state.seat]).toEqual([1, 2, 0, 0]);
  });
});

describe('P3E26 1008 로만 닫히는 학생', () => {
  it('P3E26 연결이 열린 것만으로 붙었다고 세지 않는다: 들어가기 시작한 지 20초에 안내, 재시도는 늘어난 간격으로 계속, 뒤늦게 받아 주면 들어간다', async () => {
    const d = device();
    d.c.open('ABCDEF');
    const at: number[] = [];
    const t0 = Date.now();
    let n = 0;
    for (let ms = 0; ms < 60_000; ms += 100) {
      if (d.socks.length > n) {
        n = d.socks.length;
        at.push(Date.now() - t0);
        d.socks[n - 1].onopen?.({});
        d.socks[n - 1].onclose?.({ code: 1008 });
      }
      await tick(100);
      expect(d.c.state.late, String(ms)).toBe(Date.now() - t0 >= LATE_MS);
    }
    const gaps = at.slice(1).map((x, i) => Math.round((x - at[i]) / 500) * 500);
    expect(gaps).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000].slice(0, gaps.length));
    expect(gaps.length).toBeGreaterThanOrEqual(8);
    expect(LATE_MS).toBe(20_000);
    while (d.socks.length === n) await tick(100);
    const s = d.socks.at(-1)!;
    s.onopen?.({});
    s.onmessage?.({ data: JSON.stringify({ t: 'state', code: 'ABCDEF', phase: 'lobby', settings: {}, hostSeat: 0, seats: [], game: null, deadlineAt: null, stepAt: 0, now: 0, cards: [], notice: null, cutscene: null, logFrom: 0, log: [] }) });
    expect([d.c.state.late, d.c.state.room!.phase]).toEqual([false, 'lobby']);
    d.c.close();
  });
});

describe('저장 멈춤 알림', () => {
  it('처음부터면 never, 도중이면 stopped', async () => {
    const d = device();
    d.store.fail = () => new Error('막힘');
    await make(d, 0);
    expect(d.c.state.host!.save).toBe('never');
    const e = device();
    await make(e, 0);
    expect(e.c.state.host!.save).toBe('ok');
    e.store.fail = () => new Error('막힘');
    await tick(1_000);
    expect(e.c.state.host!.save).toBe('stopped');
  });
  it('저장 자리가 다른 방을 가리켜도 자기 방 코드를 넣으면 방장으로 열린다', async () => {
    const d = device();
    await make(d, 2);
    const code = d.rooms[0].code;
    d.rooms[0].close();
    await flush();
    saveSeat({ roomCode: 'ABCDEF', seatNo: 2, seatPin: '1234' });
    const t = d.tab();
    t.c.open(code);
    await flush();
    expect(t.c.state).toMatchObject({ seat: 0, host: { restored: true } });
  });
});

/** 저장된 방을 다시 연 탭. phase 는 앞 탭이 남긴 판 */
async function restore(phase: 'lobby' | 'playing' | 'finished') {
  const d = device();
  await make(d, 2);
  if (phase !== 'lobby') { d.c.send({ t: 'start' }); await flush(); }
  if (phase === 'finished') {
    const r = d.rooms[0].room as unknown as { run(f: null, b: () => void): void; game: { clock: { remainingMs: number } }; dirty: boolean };
    r.run(null, () => { r.game.clock.remainingMs = 500; r.dirty = true; });
    await tick(1_000);
    expect(d.c.state.room!.phase).toBe('finished');
  }
  await tick(3_000);
  const t = await reload(d);
  const cover = () => hostCover(t.c.state);
  /** 화면이 그리는 것(방장 연결 상태는 뺀다) */
  const drawn = () => { const { host: _, seq: __, ...s } = t.c.state; return JSON.stringify([s.room?.phase, s.pins, s.away, s.bye, s.code, s.seat]) + cover(); };
  const net = () => t.nets.at(-1)!;
  const send = async (m: Parameters<typeof t.c.send>[0]) => { t.c.send(m); await flush(); };
  return { d, ...t, cover, drawn, net, send, reads: () => d.store.ops.filter((o) => o.startsWith('get')).length, room: d.rooms.at(-1)! };
}

describe('P3bE06 복원 뒤의 등록 실패(§8-19 ⓖ)', () => {
  /** ⓐ 판 중 복원 → offline → [게임 계속하기] → failed */
  async function gone() {
    const r = await restore('playing');
    expect(r.cover()).toBe('opening');
    r.net().state('offline');
    await r.send({ t: 'resume' });
    expect([r.c.state.room!.phase, r.cover()]).toEqual(['playing', null]);
    const before = r.drawn();
    r.net().state('failed');
    expect(r.drawn()).toBe(before);
    return { ...r, before };
  }

  it('P3bE06 ⓐⓑ 판을 이어 간 뒤의 failed: 화면 변화 0, 10초마다 같은 방으로 새 등록, 열리면 그만', async () => {
    expect(NET.reopenGapMs).toBe(10_000);
    const r = await gone();
    const reads = r.reads();
    for (let i = 1; i <= 2; i++) {
      const old = r.net();
      await tick(NET.reopenGapMs - 1);
      expect([r.nets.length, old.closes]).toEqual([i, 0]);
      await tick(1);
      expect([r.nets.length, old.closes, r.net().room === r.room, r.c.state.host!.net, r.drawn()]).toEqual([i + 1, 1, true, 'wait', r.before]);
      r.net().state(i === 1 ? 'failed' : 'open');
      expect(r.drawn()).toBe(r.before);
    }
    await tick(60_000);
    expect([r.nets.length, r.d.opened.length, r.reads() - reads, r.c.state.host!.net, r.cover()]).toEqual([3, 1, 0, 'open', null]);
  });

  it('P3bE06 ⓒ 그 뒤 방장이 판을 멈춤: 멈춤 모달이 뜨고 이어진다, 뒤쪽 등록은 계속', async () => {
    const r = await gone();
    await r.send({ t: 'pause' });
    expect([r.c.state.room!.phase, r.c.state.pins !== null, r.cover()]).toEqual(['paused', true, null]);
    await tick(NET.reopenGapMs);
    expect([r.nets.length, r.c.state.host!.net, r.cover()]).toEqual([2, 'wait', null]);
    r.net().state('failed');
    await tick(NET.reopenGapMs);
    expect([r.nets.length, r.cover()]).toEqual([3, null]);
    await r.send({ t: 'resume' });
    expect(r.c.state.room!.phase).toBe('playing');
  });

  for (const [name, phase] of [['ⓓ 아직 안 이은 멈춘 판', 'playing'], ['ⓔ 대기실', 'lobby']] as const) it(`P3bE06 ${name}: 지금처럼 다시 열지 못했어요, 저절로 다시 등록 0`, async () => {
    const r = await restore(phase);
    if (phase === 'playing') { r.net().state('offline'); expect(r.cover()).toBeNull(); }
    r.net().state('failed');
    expect([r.c.state.room!.phase, r.cover()]).toEqual([phase === 'playing' ? 'paused' : 'lobby', 'stuck']);
    await tick(60_000);
    expect([r.nets.length, r.net().closes, r.cover()]).toEqual([1, 0, 'stuck']);
    r.c.retryHost();
    expect([r.nets.length, r.nets[0].closes]).toEqual([2, 1]);
    r.net().state('open');
    expect(r.cover()).toBeNull();
  });

  it('P3bE06 ⓕ 끝난 판 복원: 결과 화면 그대로, 10초 뒤 저절로 다시 등록', async () => {
    const r = await restore('finished');
    const before = r.drawn();
    expect([r.c.state.room!.phase, r.cover()]).toEqual(['finished', null]);
    r.net().state('failed');
    await tick(NET.reopenGapMs);
    expect([r.nets.length, r.nets[0].closes, r.c.state.host!.net, r.drawn()]).toEqual([2, 1, 'wait', before]);
  });

  for (const [name, end] of [['끝내기', (r) => { r.c.endGame(); }], ['처음 화면으로', (r) => { r.c.leave(); }]] as [string, (r: Awaited<ReturnType<typeof gone>>) => void][]) it(`P3bE06 ⓖ ${name}: 걸어 둔 타이머가 지워진다`, async () => {
    const r = await gone();
    end(r);
    r.net().done();
    await flush();
    expect(vi.getTimerCount()).toBe(0);
    await tick(60_000);
    expect([r.nets.length, r.c.state.code]).toEqual([1, null]);
  });
});

describe('P3bE10 코드 다시 뽑기의 실패 길', () => {
  /** 새 방 만들기가 시험이 놓아줄 때까지 걸린다 */
  async function slow() {
    const d = device();
    await make(d, 0);
    const [old] = d.rooms;
    let go = () => {};
    const gate = new Promise<void>((ok) => { go = ok; });
    const request = d.locks.request.bind(d.locks);
    vi.spyOn(d.locks, 'request').mockImplementation(async (...a) => { await gate; return request(...a); });
    const keys = () => d.store.keys(old.code);
    const before = keys();
    const got = d.nets[0].o.repick!();
    return { d, old, go, got, kept: () => expect(keys()).toEqual(before), room: () => d.c.state.room!.code };
  }
  const roomKeys = (d: ReturnType<typeof device>) => [...d.store.data.keys()].filter((k) => k.endsWith('.room'));

  it('P3bE10 ⓐ 새 방 만들기가 null: 옛 방은 열려 있고 저장 키 그대로, onSwap 0', async () => {
    const d = device();
    await make(d, 0);
    const [old] = d.rooms;
    const keys = d.store.keys(old.code);
    const sock = (d.c as unknown as { sock: unknown }).sock;
    vi.spyOn(d.locks, 'request').mockImplementation(async (_n, _o, cb) => cb(null));
    expect(await d.nets[0].o.repick!()).toBeNull();
    expect([d.store.keys(old.code), d.rooms.length, (d.c as unknown as { sock: unknown }).sock === sock]).toEqual([keys, 1, true]); // 갈아타지 않았다
    expect(new Remote(old).closes).toEqual([]);
    expect(roomKeys(d)).toEqual([hostKey(old.code, 'room')]);
  });

  it('P3bE10 ⓑ 만드는 사이 출발: 새 방은 닫히고 키 0, 옛 방의 판 그대로 · ⓓ 이미 출발했으면 만들지 않는다', async () => {
    const r = await slow();
    r.d.c.send({ t: 'start' });
    await flush();
    r.go();
    expect(await r.got).toBeNull();
    await flush();
    expect(r.d.rooms).toHaveLength(2);
    expect([r.d.store.keys(r.d.rooms[1].code), new Remote(r.d.rooms[1]).closes]).toEqual([[], [1008]]);
    expect([r.room(), r.d.c.state.room!.phase, roomKeys(r.d)]).toEqual([r.old.code, 'playing', [hostKey(r.old.code, 'room')]]);
    expect(await r.d.nets[0].o.repick!()).toBeNull();
    expect(r.d.rooms).toHaveLength(2);
    expect([r.room(), r.d.c.state.room!.phase]).toEqual([r.old.code, 'playing']);
  });

  it('P3bE10 ⓒ 만드는 사이 HostNet 이 닫힘: 새 방은 닫히고 키 0, 옛 방 저장본 그대로', async () => {
    const r = await slow();
    r.d.c.home();
    r.go();
    expect(await r.got).toBeNull();
    await flush();
    expect([r.d.store.keys(r.d.rooms[1].code), new Remote(r.d.rooms[1]).closes]).toEqual([[], [1008]]);
    r.kept();
    expect([roomKeys(r.d), [...r.d.locks.held], r.d.c.state.code]).toEqual([[hostKey(r.old.code, 'room')], [], null]);
  });

  it('P3bE10 성공 길의 순서: 새 방이 생긴 뒤에 옛 방이 닫히고 지워진다', async () => {
    const d = device();
    await make(d, 0);
    const [old] = d.rooms;
    d.store.ops.length = 0;
    await d.nets[0].taken();
    const next = d.rooms[1];
    const made = d.store.ops.indexOf(`set ${hostKey(next.code, 'room')}`);
    const gone = d.store.ops.indexOf(`del ${hostKey(old.code, 'room')}`);
    expect(made).toBeGreaterThanOrEqual(0);
    expect(gone).toBeGreaterThan(made);
    expect(roomKeys(d)).toEqual([hostKey(next.code, 'room')]);
  });
});

describe('P3bE16 못 들어가거나 못 연 방의 [처음 화면으로](I-1)', () => {
  const mine = { roomCode: 'ABCDEF', seatNo: 2 as const, seatPin: '0420' };
  for (const [name, enter] of [['ⓐ 잘못 넣은 코드', (c) => c.open('ABCDEG')], ['ⓑ 자동 복귀', (c) => { c.resumeSaved(); }]] as [string, (c: GameClient) => void][]) it(`P3bE16 ${name}: 20초 안내 뒤 저장 자리는 남고 다시 잇지 않는다`, async () => {
    const d = device();
    saveSeat(mine);
    enter(d.c);
    d.socks[0].onclose?.({});
    await tick(LATE_MS);
    expect(d.c.state.late).toBe(true);
    d.c.home();
    const n = d.socks.length;
    await tick(60_000);
    expect([loadSeat(), d.c.state.code, d.c.state.late, d.socks.length - n]).toEqual([mine, null, false, 0]);
  });

  for (const net of ['failed', 'broken'] as const) for (const own of [true, false]) it(`P3bE16 ⓒ 방장 ${net}, 저장 자리가 ${own ? '이 방' : '다른 방'}: ${own ? '지운다' : '그대로'}, 방 저장본은 그대로`, async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = device();
    await make(d, 2);
    d.c.send({ t: 'start' });
    await flush();
    const code = d.rooms[0].code;
    d.rooms[0].close();
    await flush();
    if (net === 'broken') d.store.data.set(hostKey(code, 'log:000000'), '[{"ev"');
    const t = d.tab();
    t.c.open(code);
    await flush();
    if (net === 'failed') t.nets[0].state('failed');
    expect(hostCover(t.c.state)).toBe('stuck');
    if (!own) saveSeat(mine);
    const keys = d.store.keys(code);
    t.c.giveUp();
    await flush();
    expect([loadSeat(), t.c.state.code, t.c.state.host, d.store.keys(code)]).toEqual([own ? null : mine, null, null, keys]);
    expect([...d.locks.held]).toEqual([]);
  });
});

describe('P3bE18 만드는 사이 다른 일(I-3)', () => {
  /** 방 만들기가 2초 걸리는 기기 */
  function slow() {
    const d = device();
    const request = d.locks.request.bind(d.locks);
    vi.spyOn(d.locks, 'request').mockImplementation(async (...a) => { await new Promise((ok) => setTimeout(ok, 2_000)); return request(...a); });
    return { d, hostKeys: () => [...d.store.data.keys()].filter((k) => k.startsWith('tw.host.')), make: () => d.c.create({ totalMinutes: 40 }) };
  }
  /** 「새 방 만들기」 팝업의 뒤로(Entry.tsx) */
  const back = (d: ReturnType<typeof device>) => d.c.close();

  it('P3bE18 ⓐ 뒤로 가서 친구 방에 입장: 그 방에 그대로, 늦게 온 방은 닫히고 키 0, PeerHost 0', async () => {
    const { d, hostKeys, make: mk } = slow();
    const got = mk();
    await tick(500);
    back(d);
    d.c.open('ABCDEF');
    await tick(5_000);
    expect(await got).toBe(false);
    expect([d.c.state.code, d.c.state.host, d.socks.length, d.nets.length]).toEqual(['ABCDEF', null, 1, 0]);
    expect([d.rooms.length, hostKeys(), [...d.locks.held], new Remote(d.rooms[0]).closes]).toEqual([1, [], [], [1008]]);
    d.c.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('P3bE18 ⓑ 뒤로 갔다가 다시 만들기: 방은 하나, 앞 방 키 0', async () => {
    const { d, hostKeys, make: mk } = slow();
    const a = mk();
    await tick(500);
    back(d);
    const b = mk();
    await tick(5_000);
    expect([await a, await b, d.rooms.length, d.nets.length]).toEqual([false, true, 2, 1]);
    const code = d.c.state.room!.code;
    expect([d.rooms.map((r) => r.code).indexOf(code), hostKeys().every((k) => k.includes(code)), [...d.locks.held]]).toEqual([1, true, [`tw.host.${code}`]]);
    expect(d.store.keys(d.rooms[0].code)).toEqual([]);
  });

  it('P3bE18 ⓒ 뒤로만: 첫 화면 그대로, 키 0', async () => {
    const { d, hostKeys, make: mk } = slow();
    const before = d.c.state;
    const got = mk();
    await tick(500);
    back(d);
    await tick(5_000);
    expect([await got, d.c.state === before, hostKeys(), [...d.locks.held], vi.getTimerCount()]).toEqual([false, true, [], [], 0]);
  });
});

describe('P3bE19 복원한 대기실의 [다시 연결해 보기](M-1)', () => {
  it('P3bE19 offline 뒤의 등록 기다림은 대기실을 덮지 않는다: 15초면 다시 offline(§8-19 방장 대기실 문구), 출발이 된다', async () => {
    const r = await restore('lobby');
    expect(r.cover()).toBe('opening');
    r.net().state('offline');
    expect([r.cover(), r.c.state.host!.net]).toEqual([null, 'offline']);
    for (let i = 0; i < 2; i++) {
      r.c.retryHost();
      await tick(NET.registerMs);
      expect([r.cover(), r.c.state.host!.net, r.c.state.room!.phase]).toEqual([null, 'wait', 'lobby']);
      r.net().state('offline');
      expect([r.cover(), r.c.state.host!.net]).toEqual([null, 'offline']);
    }
    await r.send({ t: 'start' });
    expect(r.c.state.room!.phase).toBe('playing');
  });

  it('P3bE19 이미 쓰는 중 100초 동안에도 대기실 그대로. 한 번 열린 뒤도 같다', async () => {
    const r = await restore('lobby');
    r.net().state('open');
    r.c.retryHost();
    await tick(NET.retakeGiveUpMs);
    expect([r.cover(), r.c.state.host!.net, r.c.state.room!.phase]).toEqual([null, 'wait', 'lobby']);
    r.net().state('failed'); // ID 를 끝내 못 잡으면 대기실도 덮는다(§8-19 ⓖ)
    expect(r.cover()).toBe('stuck');
  });
});
