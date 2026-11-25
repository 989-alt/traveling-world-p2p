// 방장 쪽 연결: 틀 검사·상한·등록·되부름 경계. PeerJS 는 가짜, HostRoom·Room 은 진짜(P2E06·09·10 은 가짜 방).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('peerjs', async () => ({ default: (await import('./fakes')).FakePeer }));
import { Direct, fakeClock, flush, newHost, tick } from '../../host/__tests__/helpers';
import type { HostConn, HostPort } from '../../host/host-room';
import { PeerHost, type HostNetState, type RemoteRoom } from '../peer-host';
import { fake, last, type FakeDc } from './fakes';

beforeEach(() => { fakeClock(); fake.peers.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
/** 닫힘 확인이 안 오는 연결이 있으면 3초 뒤에 끝난다 */
const stop = async (n: PeerHost) => { const p = n.close(); await tick(3_000); await p; };

class FakeRoom implements RemoteRoom {
  got: string[] = [];
  conns: HostConn[] = [];
  closed = 0;
  isSeated = false;
  constructor(public code = 'ABCDEF') {}
  accept(c: HostConn): HostPort {
    this.conns.push(c);
    return { message: (d) => { this.got.push(d); }, closed: () => { this.closed++; }, seated: () => this.isSeated };
  }
}
const hello = (dc: FakeDc, code: string) => { dc.emit('data', { t: 'h', v: 1, code }); };
const say = (dc: FakeDc, m: unknown) => { dc.emit('data', { t: 'm', d: JSON.stringify(m) }); };
const msgs = (dc: FakeDc) => dc.of('m').map((f) => JSON.parse(f.d));

/** 방장이 앉은 진짜 방 + PeerHost */
async function real() {
  const h = await newHost();
  const direct = new Direct(h.host);
  await direct.say({ t: 'hello', charId: 0 });
  const net = new PeerHost(h.host);
  const peer = last(fake.peers);
  peer.ready();
  let n = 0;
  const join = async (id = `s${n++}`) => { const dc = peer.incoming(id); hello(dc, h.code); await flush(); return dc; };
  const seat = async (charId: number, id?: string) => { const dc = await join(id); say(dc, { t: 'hello', charId }); await flush(); return dc; };
  const beat = async (ms: number, ...dcs: FakeDc[]) => { for (let t = 0; t < ms; t += 2_000) { for (const d of dcs) d.emit('data', { t: 'b' }); await tick(2_000); } };
  return { ...h, room: h.host.room, direct, net, peer, join, seat, beat };
}
function rig(opts: ConstructorParameters<typeof PeerHost>[1] = {}) {
  const room = new FakeRoom();
  const states: HostNetState[] = [];
  const net = new PeerHost(room, { onState: (s) => states.push(s), ...opts });
  return { room, states, net, peer: fake.peers[0] };
}

describe('P2E03 틀 검사', () => {
  it('P2E03 조각 · 2,049자 · 모르는 종류 · JSON 아닌 것 · 두 번째 인사 = 닫힘 1008, Room 에 아무것도 안 넘어간다', async () => {
    const bad: unknown[] = [
      { t: 'p', id: 1, i: 0, n: 1, d: '{"t":"sync"}' }, { t: 'm', d: 'x'.repeat(2_049) }, { t: 'zz' }, { t: 'm', d: 5 }, { t: 'c', code: 4001 },
      'text', 0, null, [1], { t: 'h', v: 1, code: 'ABCDEF' },
    ];
    for (const x of bad) {
      const r = await real();
      const dc = await r.join();
      const into = vi.spyOn(r.room, 'webSocketMessage');
      const closed = vi.spyOn(r.room, 'webSocketClose');
      dc.emit('data', x);
      dc.emit('data', { t: 'm', d: '{"t":"sync"}' }); // 닫는 중에 온 것도 안 넘어간다
      await flush();
      expect(dc.of('c')).toEqual([{ t: 'c', code: 1008 }]);
      expect([into.mock.calls.length, closed.mock.calls.length]).toEqual([0, 1]);
      await tick(3_000);
      expect([dc.closes, closed.mock.calls.length]).toEqual([1, 1]);
      await stop(r.net);
      r.host.close();
    }
  });

  it('P2E03 2,048자는 넘어간다. JSON 채널이 아닌 연결은 받지 않는다', async () => {
    const r = rig();
    r.peer.ready();
    const dc = r.peer.incoming('s');
    hello(dc, 'ABCDEF');
    dc.emit('data', { t: 'm', d: 'x'.repeat(2_048) });
    await flush();
    expect(r.room.got.length).toBe(1);
    const raw = r.peer.incoming('t', false);
    raw.emit('close');
    const { FakeDc } = await import('./fakes');
    const bin = new FakeDc('u');
    bin.serialization = 'binary';
    r.peer.emit('connection', bin);
    expect(bin.closes).toBe(1);
    await stop(r.net);
  });
});

describe('P2E04 인사', () => {
  it('P2E04 5초 안에 인사 없음 · 틀린 코드 · 판 번호 다름 · 인사 전 게임 메시지 = 1008, Room 연결에 안 들어간다', async () => {
    const bad: ((dc: FakeDc) => unknown)[] = [
      async (dc) => { await tick(4_999); expect(dc.of('c')).toEqual([]); await tick(1); },
      (dc) => hello(dc, 'ZZZZZZ'),
      (dc) => { dc.emit('data', { t: 'h', v: 2, code: 'ABCDEF' }); },
      (dc) => { dc.emit('data', { t: 'h', v: 1 }); },
      (dc) => say(dc, { t: 'hello', charId: 1 }),
      (dc) => { dc.emit('data', { t: 'b' }); },
    ];
    for (const f of bad) {
      fake.peers.length = 0;
      const r = rig();
      r.peer.ready();
      const dc = r.peer.incoming('s');
      await f(dc);
      await flush();
      expect([dc.of('c'), r.room.conns.length]).toEqual([[{ t: 'c', code: 1008 }], 0]);
      await stop(r.net);
    }
  });
  it('P2E04 열리지 않는 연결은 20초 뒤 버린다', async () => {
    const r = rig();
    r.peer.ready();
    const dc = r.peer.incoming('s', false);
    await tick(20_000);
    expect(dc.closes).toBe(1);
    await stop(r.net);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('P2E05 연결 수·낡은 연결', () => {
  it('P2E05 원격 7번째는 1008, 하나가 빠지면 받는다', async () => {
    const r = rig();
    r.peer.ready();
    const dcs = Array.from({ length: 7 }, (_, i) => { const dc = r.peer.incoming(`s${i}`); hello(dc, 'ABCDEF'); return dc; });
    await flush();
    expect(dcs.map((d) => d.of('c').length)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(dcs[6].of('c')).toEqual([{ t: 'c', code: 1008 }]);
    expect(r.room.conns.length).toBe(6);
    dcs[0].cut();
    await flush();
    const again = r.peer.incoming('s8');
    hello(again, 'ABCDEF');
    await flush();
    expect([again.of('c').length, r.room.conns.length]).toEqual([0, 7]);
    await stop(r.net);
  });

  it('P2E05 같은 기기 ID 의 새 연결: 옛 연결은 조용히 끊고, 새 연결이 자리를 되찾으면 끊김 처리(markOff)가 없다', async () => {
    const r = await real();
    const a = await r.seat(1, 'same');
    await r.direct.say({ t: 'start' });
    const pin = msgs(a).find((m) => m.t === 'welcome').pin;
    const closed = vi.spyOn(r.room, 'webSocketClose');
    const log = r.room.game!.log.length;
    const sent = a.sent.length;
    const b = r.peer.incoming('same');
    hello(b, r.code);
    await flush();
    expect([a.closes, a.of('c').length, a.sent.length]).toEqual([1, 0, sent]);
    expect(r.room.rec!.seats[1].connected).toBe(true);
    say(b, { t: 'rejoin', seat: 1, pin });
    await r.beat(30_000, b);
    expect(msgs(b).some((m) => m.t === 'welcome' && m.seat === 1)).toBe(true);
    expect([r.room.rec!.seats[1].connected, r.room.game!.seats[1].isBot, closed.mock.calls.length]).toEqual([true, false, 0]);
    expect(r.room.game!.log.slice(log).filter((e) => JSON.stringify(e).includes('"connected":false'))).toEqual([]);
    await stop(r.net);
    r.host.close();
  });

  it('P2E05 같은 기기 ID 의 새 연결이 자리를 되찾지 않으면 옛 자리는 10초 뒤 끊김 1회', async () => {
    const r = await real();
    const a = await r.seat(1, 'same');
    const closed = vi.spyOn(r.room, 'webSocketClose');
    const b = await r.join('same');
    await r.beat(8_000, b);
    expect([r.room.rec!.seats[1].connected, closed.mock.calls.length]).toEqual([true, 0]);
    await r.beat(2_000, b);
    expect([r.room.rec!.seats[1].connected, closed.mock.calls.length, a.closes > 0]).toEqual([false, 1, true]);
    await stop(r.net);
    r.host.close();
  });

  it('P2E05 자리 없는 연결은 120초 뒤 1008 + webSocketClose 1회, 앉은 연결은 그대로', async () => {
    const r = await real();
    const sit = await r.seat(1);
    const idle = await r.join();
    const closed = vi.spyOn(r.room, 'webSocketClose');
    await r.beat(118_000, sit, idle);
    expect(idle.of('c')).toEqual([]);
    await r.beat(4_000, sit, idle);
    expect([idle.of('c'), sit.of('c'), closed.mock.calls.length]).toEqual([[{ t: 'c', code: 1008 }], [], 1]);
    await r.beat(6_000, sit);
    expect([idle.closes, closed.mock.calls.length, r.room.rec!.seats[1].connected]).toEqual([1, 1, true]);
    await stop(r.net);
    r.host.close();
  });

  it('P2E05 10초 무신호 연결은 끊고 webSocketClose 1회', async () => {
    const r = await real();
    const a = await r.seat(1);
    const closed = vi.spyOn(r.room, 'webSocketClose');
    await tick(9_000);
    a.emit('data', { t: 'b' });
    await flush();
    await tick(9_999);
    expect([a.closes, closed.mock.calls.length]).toEqual([0, 0]);
    await tick(1);
    expect([a.closes, closed.mock.calls.length, r.room.rec!.seats[1].connected]).toEqual([1, 1, false]);
    await stop(r.net);
    r.host.close();
  });

  it('P2E05 방장은 2초마다 심박을 보낸다', async () => {
    const r = rig();
    r.peer.ready();
    const dc = r.peer.incoming('s');
    hello(dc, 'ABCDEF');
    await tick(8_000);
    expect(dc.of('b').length).toBe(4);
    await stop(r.net);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('P2E06 메시지 폭주', () => {
  it('P2E06 2초에 41번째에서 1008(심박 30개는 안 센다)', async () => {
    const r = rig();
    r.peer.ready();
    const dc = r.peer.incoming('s');
    hello(dc, 'ABCDEF');
    for (let i = 0; i < 40; i++) { say(dc, { t: 'sync' }); if (i < 30) dc.emit('data', { t: 'b' }); await tick(49); }
    expect([r.room.got.length, dc.of('c').length]).toEqual([40, 0]);
    say(dc, { t: 'sync' });
    await flush();
    expect([r.room.got.length, dc.of('c')]).toEqual([40, [{ t: 'c', code: 1008 }]]);
    await stop(r.net);
  });
  it('P2E06 초당 5개 30초는 통과', async () => {
    const r = rig();
    r.peer.ready();
    const dc = r.peer.incoming('s');
    hello(dc, 'ABCDEF');
    for (let i = 0; i < 150; i++) { say(dc, { t: 'sync' }); await tick(200); }
    expect([r.room.got.length, dc.of('c').length]).toEqual([150, 0]);
    await stop(r.net);
  });
});

describe('P5E05 심박도 크기·폭주 검사', () => {
  const live = async () => {
    const r = rig();
    r.room.isSeated = true;
    r.peer.ready();
    const dc = r.peer.incoming('s');
    hello(dc, 'ABCDEF');
    await flush();
    /** 선에서 온 글(PeerJS 가 해석하기 전) */
    const wire = (text: string) => dc.emit('data', (dc as unknown as { parse(d: ArrayBuffer): unknown }).parse(new TextEncoder().encode(text).buffer as ArrayBuffer));
    return { ...r, dc, wire };
  };
  it('P5E05 심박만 2초에 41번째에서 1008, 방에는 0건', async () => {
    const r = await live();
    for (let i = 0; i < 40; i++) { r.dc.emit('data', { t: 'b' }); await tick(49); }
    expect(r.dc.of('c')).toEqual([]);
    r.dc.emit('data', { t: 'b' });
    await flush();
    expect([r.dc.of('c'), r.room.got, r.room.closed]).toEqual([[{ t: 'c', code: 1008 }], [], 1]);
    await stop(r.net);
  });
  it('P5E05 300KB 심박은 JSON 으로 풀지 않고 1008, 방에는 0건', async () => {
    const r = await live();
    const parse = vi.spyOn(JSON, 'parse');
    r.wire(JSON.stringify({ t: 'b', x: 'a'.repeat(300_000) }));
    await flush();
    expect(parse.mock.calls.filter(([t]) => t.length > 1_000)).toEqual([]);
    expect([r.dc.of('c'), r.room.got, r.room.closed]).toEqual([[{ t: 'c', code: 1008 }], [], 1]);
    await stop(r.net);
  });
  it('P5E05 가장 긴 게임 메시지(2,048자, 글자마다 6바이트로 감긴 것)는 선의 크기 검사를 지난다', async () => {
    const r = await live();
    const d = '\u0001'.repeat(2_048);
    r.wire(JSON.stringify({ t: 'm', d }));
    await flush();
    expect([r.room.got, r.dc.of('c')]).toEqual([[d], []]);
    await stop(r.net);
  });
  it('P5E05 정상 심박 2초에 1개 10분은 통과', async () => {
    const r = await live();
    for (let i = 0; i < 300; i++) { r.wire('{"t":"b"}'); await tick(2_000); }
    expect([r.dc.of('c'), r.dc.closes, r.room.got, r.room.closed]).toEqual([[], 0, [], 0]);
    await stop(r.net);
  });
});

describe('P2E09 연결 ID 를 남이 쓰는 중', () => {
  it('P2E09 새 방: 코드 다시 뽑기 신호 최대 5회, 넘으면 실패', async () => {
    let n = 0;
    const r = rig({ repick: async () => new FakeRoom(`CODE2${++n}`) });
    for (let i = 0; i < 5; i++) {
      last(fake.peers).fail('unavailable-id');
      await flush();
      expect([n, last(fake.peers).id, r.states]).toEqual([i + 1, `twj1-CODE2${i + 1}`, []]);
    }
    last(fake.peers).fail('unavailable-id');
    await tick(120_000);
    expect([n, r.states, fake.peers.length, vi.getTimerCount()]).toEqual([5, ['failed'], 6, 0]);
  });
  it('P2E09 새 방: 다시 뽑은 코드로 열리면 그 코드의 인사만 받는다. 새 방을 못 만들면 실패', async () => {
    const next = new FakeRoom('NEWCDE');
    const r = rig({ repick: async () => next });
    fake.peers[0].fail('unavailable-id');
    await flush();
    const peer = last(fake.peers);
    peer.ready();
    const dc = peer.incoming('s');
    hello(dc, 'NEWCDE');
    await flush();
    expect([r.states, next.conns.length, r.room.conns.length]).toEqual([['open'], 1, 0]);
    await stop(r.net);
    fake.peers.length = 0;
    const q = rig({ repick: async () => null });
    fake.peers[0].fail('unavailable-id');
    await flush();
    expect(q.states).toEqual(['failed']);
  });
  it('P2E09 복원: 같은 ID 로 2초마다, 150초 넘으면 실패', async () => {
    const r = rig();
    for (let i = 1; i <= 75; i++) {
      last(fake.peers).fail('unavailable-id');
      await tick(1_999);
      expect(fake.peers.length).toBe(i);
      await tick(1);
      expect([fake.peers.length, last(fake.peers).id, r.states]).toEqual([i + 1, 'twj1-ABCDEF', []]);
    }
    last(fake.peers).fail('unavailable-id'); // 150초
    await tick(60_000);
    expect([r.states, fake.peers.length, fake.peers.every((p) => p.destroyed), vi.getTimerCount()]).toEqual([['failed'], 76, true, 0]);
  });
  it('P2E09 복원: 그 사이 성공하면 열림', async () => {
    const r = rig();
    fake.peers[0].fail('unavailable-id');
    await tick(2_000);
    last(fake.peers).fail('unavailable-id');
    await tick(2_000);
    last(fake.peers).ready();
    await tick(60_000);
    expect([r.states, fake.peers.length]).toEqual([['open'], 3]);
    await stop(r.net);
  });
});

describe('P2E10 시그널링', () => {
  it('P2E10 network · server-error · 15초 무응답 = offline 1번, 방장 Room 은 그대로', async () => {
    for (const f of [() => fake.peers[0].drop('network'), () => fake.peers[0].fail('server-error'), () => tick(15_000)]) {
      fake.peers.length = 0;
      const { host } = await newHost();
      const direct = new Direct(host);
      const states: HostNetState[] = [];
      const net = new PeerHost(host, { onState: (s) => states.push(s), repick: async () => null });
      await tick(14_000);
      expect(states).toEqual([]);
      await f();
      await tick(60_000);
      expect([states, fake.peers.length, fake.peers[0].destroyed, fake.peers[0].reconnects]).toEqual([['offline'], 1, true, 0]);
      await direct.say({ t: 'hello', charId: 0 });
      await direct.say({ t: 'start' });
      expect(direct.last('state')!.phase).toBe('playing');
      await stop(net);
      host.close();
    }
  });
  it('P2E10 붙었다가 시그널링만 끊기면 맺은 연결은 유지, 1·2·4…30초로 재등록, 다시 열리면 1초부터', async () => {
    const r = rig();
    r.peer.ready();
    r.room.isSeated = true;
    const dc = r.peer.incoming('s');
    hello(dc, 'ABCDEF');
    const beat = setInterval(() => dc.emit('data', { t: 'b' }), 2_000);
    await flush();
    r.peer.drop();
    for (const ms of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const n = r.peer.reconnects;
      await tick(ms - 1);
      expect(r.peer.reconnects).toBe(n);
      await tick(1);
      expect(r.peer.reconnects).toBe(n + 1);
      r.peer.drop(n % 2 ? 'network' : 'unavailable-id');
    }
    await tick(30_000);
    r.peer.ready();
    r.peer.drop();
    await tick(1_000);
    expect(r.peer.reconnects).toBe(9);
    say(dc, { t: 'sync' });
    await flush();
    expect([dc.closes, r.room.got.length, r.room.closed, r.states]).toEqual([0, 1, 0, ['open']]);
    clearInterval(beat);
    r.peer.drop();
    await stop(r.net);
    await tick(120_000);
    expect([r.peer.reconnects, r.peer.destroyed, vi.getTimerCount()]).toEqual([9, true, 0]);
  });
});

describe('P2E16 되부름 경계', () => {
  it('P2E16 방송 도중 send() 안에서 error·close 를 내는 연결: 되부름 0, 나머지는 같은 state, webSocketClose 는 처리 뒤 1회', async () => {
    const r = await real();
    const [a, bad, c] = [await r.seat(1), await r.seat(2), await r.seat(3)];
    const closedAt: boolean[] = [];
    let inRoom = false;
    const orig = r.room.webSocketMessage.bind(r.room);
    vi.spyOn(r.room, 'webSocketMessage').mockImplementation((ws, raw) => { inRoom = true; try { orig(ws, raw); } finally { inRoom = false; } });
    const close = r.room.webSocketClose.bind(r.room);
    vi.spyOn(r.room, 'webSocketClose').mockImplementation((ws) => { closedAt.push(inRoom); close(ws); });
    const na = a.sent.length;
    const nc = c.sent.length;
    bad.onSend = () => { bad.emit('error', { type: 'negotiation-failed' }); bad.cut(); bad.emit('close'); };
    expect(() => r.direct.sock.send(JSON.stringify({ t: 'start' }))).not.toThrow();
    expect(closedAt).toEqual([]); // 아직 같은 호출 안: 알림은 microtask 뒤
    // 방송 한 번이 나머지 모두에게 같은 state 로
    const full = (dc: FakeDc, n: number) => { const ps = dc.sent.slice(n); return ps[0].t === 'm' ? ps[0].d : ps.filter((f) => f.t === 'p' && f.id === ps[0].id).map((f) => f.d).join(''); };
    expect(JSON.parse(full(a, na)).phase).toBe('playing');
    expect(full(c, nc) === full(a, na)).toBe(true);
    await flush();
    expect(closedAt).toEqual([false]);
    expect(r.room.rec!.seats.map((s) => s.connected)).toEqual([true, true, false, true]);
    await tick(5_000);
    expect(closedAt).toEqual([false]);
    await stop(r.net);
    r.host.close();
  });

  it('P2E16 close() 안에서 곧바로 data·close 를 내도, 닫힘 확인 대기 중 data 도 Room 에 안 넘어간다', async () => {
    const r = await real();
    const a = await r.seat(1);
    await r.direct.say({ t: 'start' });
    const into = vi.spyOn(r.room, 'webSocketMessage');
    const closed = vi.spyOn(r.room, 'webSocketClose');
    a.onSend = (f) => { if (f.t === 'c') say(a, { t: 'sync' }); };
    a.onClose = () => { say(a, { t: 'sync' }); a.emit('close'); };
    say(a, { t: 'leave' });
    await flush();
    expect(into).toHaveBeenCalledTimes(1);
    expect(a.of('c')).toEqual([{ t: 'c', code: 4002 }]);
    say(a, { t: 'act', a: { type: 'roll' } });
    await tick(3_000);
    expect([a.closes, into.mock.calls.length, closed.mock.calls.length]).toEqual([1, 1, 0]); // Room 이 먼저 닫은 연결이라 webSocketClose 는 없다
    await stop(r.net);
    r.host.close();
  });

  it('P2E16 HostConn.send·close 가 돌아오기 전 HostPort 호출 0, 끝나면 closed 정확히 1번', async () => {
    const r = rig();
    r.peer.ready();
    const a = r.peer.incoming('a');
    const b = r.peer.incoming('b');
    hello(a, 'ABCDEF'); hello(b, 'ABCDEF');
    await flush();
    const worst = (dc: FakeDc) => () => { say(dc, { t: 'sync' }); dc.emit('error', { type: 'connection-closed' }); dc.emit('close'); };
    a.onSend = worst(a);
    b.onClose = worst(b);
    b.onSend = (f) => { if (f.t === 'c') b.close(); };
    r.room.conns[0].send('{"t":"x"}');
    r.room.conns[1].close(4000);
    expect([r.room.got.length, r.room.closed]).toEqual([0, 0]);
    await flush();
    await tick(10_000);
    expect(r.room.closed).toBe(2);
    await stop(r.net);
  });

  it('P2E16 끝난 방(accept 안에서 1008)도 예외 없이 닫힘 프레임을 보낸다', async () => {
    const r = await real();
    await r.direct.say({ t: 'end' });
    const dc = await r.join();
    expect(dc.of('c')).toEqual([{ t: 'c', code: 1008 }]);
    await tick(3_000);
    expect(dc.closes).toBe(1);
    await stop(r.net);
  });
});

/** n 번째부터 보낸 프레임에서 첫 게임 메시지(조각이면 이어 붙여) */
const firstMsg = (dc: FakeDc, n: number): string => {
  const fs = dc.sent.slice(n).filter((f) => f.t === 'm' || f.t === 'p');
  return fs[0].t === 'm' ? fs[0].d : fs.filter((f) => f.id === fs[0].id).map((f) => f.d).join('');
};
const alive = () => fake.peers.filter((p) => !p.destroyed).length;

describe('P2bE03 복원: 이미 쓰는 중', () => {
  it('P2bE03 2초 간격 같은 ID, 149초까지 failed 0, 150초에 failed 1번, 살아 있는 Peer ≤ 1', async () => {
    const r = rig();
    for (let t = 0; t <= 148; t += 2) {
      last(fake.peers).fail('unavailable-id');
      expect(alive()).toBe(0);
      await tick(1_000);
      expect([r.states, alive()]).toEqual([[], 0]);
      await tick(1_000);
      expect([last(fake.peers).id, alive()]).toEqual(['twj1-ABCDEF', 1]);
    }
    last(fake.peers).fail('unavailable-id');
    const n = fake.peers.length;
    await tick(300_000);
    expect([r.states, fake.peers.length, vi.getTimerCount()]).toEqual([['failed'], n, 0]);
  });

  it('P2bE03 만든 지 200초 뒤 처음 나오면 그때부터 150초', async () => {
    const r = rig();
    const t0 = Date.now();
    while (Date.now() - t0 < 200_000) { last(fake.peers).fail('network'); while (!alive()) await tick(500); await tick(5_000); }
    const t1 = Date.now();
    while (!r.states.includes('failed')) {
      last(fake.peers).fail('unavailable-id');
      if (r.states.includes('failed')) break;
      await tick(2_000);
      expect(alive()).toBe(1);
    }
    expect([Date.now() - t1, r.states]).toEqual([150_000, ['offline', 'failed']]);
  });

  it('P2bE03 50초 이어지다 다른 오류가 끼면 150초를 다시 잰다', async () => {
    const r = rig();
    for (let i = 0; i < 25; i++) { last(fake.peers).fail('unavailable-id'); await tick(2_000); }
    last(fake.peers).fail('network');
    await tick(1_000);
    for (let i = 0; i < 75; i++) { last(fake.peers).fail('unavailable-id'); expect(r.states).toEqual(['offline']); await tick(2_000); }
    last(fake.peers).fail('unavailable-id');
    expect([r.states, vi.getTimerCount()]).toEqual([['offline', 'failed'], 0]);
  });
});

describe('P2bE04 복원: 시그널링에 못 붙음', () => {
  const ways: [string, number, () => unknown][] = [
    ['network', 0, () => last(fake.peers).drop('network')],
    ['server-error', 0, () => last(fake.peers).fail('server-error')],
    ['15초 답 없음', 15_000, () => {}],
  ];
  for (const [name, hang, fail] of ways) {
    it(`P2bE04 ${name}: offline 1번, 1·2·4…30초로 끝없이, 열리면 open 1번`, async () => {
      const r = rig();
      const gaps = [1_000, 2_000, 4_000, 8_000, 16_000, ...Array<number>(10).fill(30_000)]; // 5분 넘게
      for (const [i, gap] of gaps.entries()) {
        expect([fake.peers.length, alive()]).toEqual([i + 1, 1]);
        await fail();
        if (hang) { await tick(hang - 1); expect(alive()).toBe(1); await tick(1); }
        expect([r.states, alive()]).toEqual([['offline'], 0]);
        await tick(gap - 1);
        expect(fake.peers.length).toBe(i + 1);
        await tick(1);
      }
      last(fake.peers).ready();
      await tick(300_000);
      expect([r.states, fake.peers.length, vi.getTimerCount()]).toEqual([['offline', 'open'], gaps.length + 1, 0]);
      await stop(r.net);
    });
  }

  it('P2bE04 offline 뒤에도 방장은 출발한다', async () => {
    const { host } = await newHost();
    const direct = new Direct(host);
    const states: HostNetState[] = [];
    const net = new PeerHost(host, { onState: (s) => states.push(s) });
    last(fake.peers).drop('network');
    await direct.say({ t: 'hello', charId: 0 });
    await direct.say({ t: 'start' });
    await tick(20_000);
    expect([states, direct.last('state')!.phase]).toEqual([['offline'], 'playing']);
    await stop(net);
    host.close();
  });

  it('P2bE04 새 방은 offline 1번이고 다시 등록하지 않는다', async () => {
    for (const [, hang, fail] of ways) {
      fake.peers.length = 0;
      const r = rig({ repick: async () => null });
      await fail();
      await tick(hang + 300_000);
      expect([r.states, fake.peers.length, alive(), vi.getTimerCount()]).toEqual([['offline'], 1, 0, 0]);
    }
  });
});

describe('P2bE05 열리기 전·부순 뒤', () => {
  it('P2bE05 open 전 연결은 닫기만 한다(복원·새 방 둘 다, 타이머 0). open 뒤에는 받는다', async () => {
    for (const opts of [{}, { repick: async () => null }]) {
      fake.peers.length = 0;
      const r = rig(opts);
      const timers = vi.getTimerCount();
      const early = Array.from({ length: 30 }, (_, i) => r.peer.incoming(`e${i}`));
      for (const dc of early) hello(dc, 'ABCDEF');
      await flush();
      expect([early.every((d) => d.closes === 1 && !d.sent.length), r.room.conns.length, vi.getTimerCount()]).toEqual([true, 0, timers]);
      r.peer.ready();
      const ok = Array.from({ length: 6 }, (_, i) => { const dc = r.peer.incoming(`s${i}`); hello(dc, 'ABCDEF'); return dc; });
      await flush();
      expect([ok.map((d) => d.closes), r.room.conns.length]).toEqual([[0, 0, 0, 0, 0, 0], 6]);
      await stop(r.net);
    }
  });

  it('P2bE05 부순 Peer 의 늦은 사건은 무시한다', async () => {
    const r = rig();
    r.peer.fail('unavailable-id');
    await tick(2_000);
    const second = last(fake.peers);
    const before = [fake.peers.length, vi.getTimerCount()];
    const late = () => {
      r.peer.emit('open', 'twj1-ABCDEF');
      r.peer.emit('error', { type: 'unavailable-id' });
      r.peer.emit('error', { type: 'network' });
      r.peer.emit('disconnected', 'twj1-ABCDEF');
      return r.peer.incoming('late');
    };
    let dc!: FakeDc;
    expect(() => { dc = late(); }).not.toThrow();
    await flush();
    expect([r.states, fake.peers.length, vi.getTimerCount(), dc.closes, second.destroyed]).toEqual([[], ...before, 1, false]);
    second.ready();
    late();
    await tick(60_000);
    expect([r.states, fake.peers.length, r.peer.reconnects, r.room.conns.length]).toEqual([['open'], before[0], 0, 0]);
    await stop(r.net);
  });

  it('P2bE05 다시 시도를 기다리는 도중 close(): 그 뒤 새 Peer 0, 타이머 0. 늦은 오류도 무시', async () => {
    for (const type of ['unavailable-id', 'network']) {
      fake.peers.length = 0;
      const r = rig();
      r.peer.fail(type);
      await r.net.close();
      r.peer.emit('error', { type });
      await tick(300_000);
      expect([fake.peers.length, vi.getTimerCount()]).toEqual([1, 0]);
    }
    fake.peers.length = 0;
    const net: PeerHost = new PeerHost(new FakeRoom(), { onState: () => void net.close() }); // 알림 안에서 닫아도
    fake.peers[0].fail('network');
    await tick(300_000);
    expect([fake.peers.length, vi.getTimerCount()]).toEqual([1, 0]);
  });
});

describe('P2bE06 열리지 않은 연결 상한', () => {
  it('P2bE06 24개까지만 받고 25번째부터 닫는다. 열린 학생은 영향 0, 20초 뒤 다시 받는다', async () => {
    const r = rig();
    r.peer.ready();
    const player = r.peer.incoming('player');
    hello(player, 'ABCDEF');
    await flush();
    const base = vi.getTimerCount();
    const stuck = Array.from({ length: 30 }, (_, i) => r.peer.incoming(`x${i}`, false));
    expect([stuck.map((d) => d.closes), vi.getTimerCount()]).toEqual([[...Array(24).fill(0), ...Array(6).fill(1)], base + 24]);
    say(player, { t: 'sync' });
    await flush();
    expect([player.closes, r.room.got.length]).toEqual([0, 1]);
    for (let t = 0; t < 20_000; t += 2_000) { player.emit('data', { t: 'b' }); await tick(2_000); }
    expect([stuck.every((d) => d.closes === 1), vi.getTimerCount(), r.room.closed]).toEqual([true, base, 0]);
    const next = r.peer.incoming('next');
    hello(next, 'ABCDEF');
    await flush();
    expect([next.closes, r.room.conns.length]).toEqual([0, 2]);
    await stop(r.net);
  });
});

describe('P2bE07 보내기 밀림', () => {
  it('P2bE07 2,048 은 보낸다. 2,049 는 그 연결만 microtask 뒤 끝: 닫힘 프레임 0, close 1, webSocketClose 1회, 되부름 0', async () => {
    const r = await real();
    const [a, slow, c] = [await r.seat(1), await r.seat(2), await r.seat(3)];
    slow.bufferSize = 2_048;
    const ns = slow.sent.length;
    await r.direct.say({ t: 'start' });
    expect([slow.closes, JSON.parse(firstMsg(slow, ns)).phase]).toEqual([0, 'playing']);
    let inRoom = false;
    const closedAt: boolean[] = [];
    const orig = r.room.webSocketMessage.bind(r.room);
    vi.spyOn(r.room, 'webSocketMessage').mockImplementation((ws, raw) => { inRoom = true; try { orig(ws, raw); } finally { inRoom = false; } });
    const close = r.room.webSocketClose.bind(r.room);
    vi.spyOn(r.room, 'webSocketClose').mockImplementation((ws) => { closedAt.push(inRoom); close(ws); });
    const [na, nc] = [a.sent.length, c.sent.length];
    slow.onSend = () => { slow.bufferSize = 2_049; }; // 방송 도중에 넘는다
    r.direct.sock.send(JSON.stringify({ t: 'pause' }));
    expect([closedAt, slow.closes]).toEqual([[], 0]);
    // 멈춤은 자리별 PIN 이 먼저 가고 state 가 뒤따른다
    const state = (dc: FakeDc, n: number) => firstMsg(dc, n + dc.sent.slice(n).findIndex((f) => f.t === 'p' || f.d.startsWith('{"t":"state"')));
    expect(JSON.parse(state(a, na)).phase).toBe('paused');
    expect(state(c, nc) === state(a, na)).toBe(true);
    await flush();
    expect([closedAt, slow.closes, slow.of('c').length]).toEqual([[false], 1, 0]);
    expect(r.room.rec!.seats.map((s) => s.connected)).toEqual([true, true, false, true]);
    await tick(5_000);
    expect(closedAt).toEqual([false]);
    await stop(r.net);
    r.host.close();
  });

  it('P2bE07 닫힘 확인을 기다리는 연결도 넘으면 끝나고 PeerHost.close() 가 풀린다', async () => {
    const r = rig();
    r.peer.ready();
    const dc = r.peer.incoming('s');
    hello(dc, 'ABCDEF');
    await flush();
    dc.bufferSize = 2_049;
    r.room.conns[0].close(4001);
    let done = false;
    void r.net.close().then(() => { done = true; });
    expect([dc.closes, r.room.closed]).toEqual([0, 0]);
    await flush();
    expect([dc.closes, r.room.closed, done, vi.getTimerCount()]).toEqual([1, 1, true, 0]);
  });
});

describe('P2bE10 close() 두 번', () => {
  it('P2bE10 같은 promise 이고 연결이 다 끝난 뒤 둘 다 풀린다. Peer destroy 1번', async () => {
    const r = rig();
    r.peer.ready();
    const dc = r.peer.incoming('s');
    hello(dc, 'ABCDEF');
    await flush();
    const destroy = vi.spyOn(r.peer, 'destroy');
    r.room.conns[0].close(4001);
    const p = r.net.close();
    const q = r.net.close();
    expect(p === q).toBe(true);
    const done: string[] = [];
    void p.then(() => done.push('p'));
    void q.then(() => done.push('q'));
    await tick(2_999);
    expect([done, destroy.mock.calls.length]).toEqual([[], 0]);
    await tick(1);
    expect([done, destroy.mock.calls.length, vi.getTimerCount()]).toEqual([['p', 'q'], 1, 0]);
    expect(r.net.close()).toBe(p);
  });
  it('P2bE10 연결이 없을 때 · 닫는 도중(closed 안에서) 다시 불러도', async () => {
    const a = rig();
    const destroy = vi.spyOn(a.peer, 'destroy');
    expect(a.net.close()).toBe(a.net.close());
    await a.net.close();
    expect(destroy).toHaveBeenCalledTimes(1);
    fake.peers.length = 0;
    let inner: Promise<void> | undefined;
    const net: PeerHost = new PeerHost({ code: 'ABCDEF', accept: () => ({ message: () => {}, closed: () => { inner = net.close(); }, seated: () => true }) });
    fake.peers[0].ready();
    hello(fake.peers[0].incoming('s'), 'ABCDEF');
    await flush();
    const outer = net.close();
    expect(inner).toBe(outer);
    await outer;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('P2bE11 다른 기기 ID 로 되찾기(우리 클라이언트의 길)', () => {
  it('P2bE11 옛 연결은 4000 닫힘 프레임 1번 뒤 확인 또는 3초에 끊기고, 자리는 줄곧 이어진다', async () => {
    for (const ack of [true, false]) {
      fake.peers.length = 0;
      const r = await real();
      const a = await r.seat(1, 'A');
      await r.direct.say({ t: 'start' });
      const pin = msgs(a).find((m) => m.t === 'welcome').pin;
      const closed = vi.spyOn(r.room, 'webSocketClose');
      const log = r.room.game!.log.length;
      const b = await r.join('B');
      say(b, { t: 'rejoin', seat: 1, pin });
      await flush();
      expect([a.of('c'), a.closes]).toEqual([[{ t: 'c', code: 4000 }], 0]);
      expect(msgs(b).find((m) => m.t === 'welcome')).toMatchObject({ seat: 1 });
      if (ack) { a.emit('data', { t: 'a' }); await flush(); expect(a.closes).toBe(1); }
      else { await tick(2_999); expect(a.closes).toBe(0); await tick(1); expect(a.closes).toBe(1); }
      const on: boolean[] = [];
      for (let t = 0; t < 32_000; t += 2_000) { await r.beat(2_000, b); on.push(r.room.rec!.seats[1].connected); }
      expect([on.every(Boolean), closed.mock.calls.length, a.of('c').length, r.room.game!.seats[1].isBot]).toEqual([true, 0, 1, false]);
      expect(r.room.game!.log.slice(log).filter((e) => JSON.stringify(e).includes('"connected":false'))).toEqual([]);
      await stop(r.net);
      r.host.close();
    }
  });
});

describe('P3E27 등록이 열리기 전의 webrtc 오류', () => {
  for (const [name, opts] of [['새 방', { repick: async () => null }], ['복원', {}]] as const) it(`P3E27 ${name}: 거절한 연결의 실패는 등록 실패가 아니다 — 알림 0, 뒤늦은 open 에 열린다. 15초 답 없음은 그대로`, async () => {
    const a = rig(opts);
    a.peer.incoming('s0', false);
    for (let i = 0; i < 3; i++) a.peer.emit('error', { type: 'webrtc' });
    await tick(14_000);
    expect([a.states, fake.peers.length, a.peer.destroyed]).toEqual([[], 1, false]);
    a.peer.ready();
    expect(a.states).toEqual(['open']);
    await stop(a.net);
    fake.peers.length = 0;
    const b = rig(opts);
    b.peer.emit('error', { type: 'webrtc' });
    await tick(14_999);
    expect(b.states).toEqual([]);
    await tick(1);
    expect(b.states).toEqual(['offline']);
    await stop(b.net);
  });
});
