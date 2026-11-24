// 학생 쪽 연결: 닫힘·심박·못 붙음. PeerJS 는 가짜, RoomSocket·GameClient·방장 쪽(PeerHost·HostRoom)은 진짜.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('peerjs', async () => ({ default: (await import('./fakes')).FakePeer }));
import { GameClient } from '../../state/client';
import { Direct, fakeClock, flush, newHost, tick } from '../../host/__tests__/helpers';
import type { HostConn, HostPort } from '../../host/host-room';
import { OFFLINE_BOT_MS } from '../../../worker/room';
import { PeerHost } from '../peer-host';
import { peerMake } from '../peer-socket';
import { RoomSocket, type SocketLike } from '../socket';
import { fake, last, pair, type FakeDc } from './fakes';

beforeEach(() => { fakeClock(); fake.peers.length = 0; });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
/** 닫힘 확인이 안 오는 연결이 있으면 3초 뒤에 끝난다 */
const stop = async (n: PeerHost) => { const p = n.close(); await tick(3_000); await p; };

/** 학생 소켓 하나. 가짜 연결을 손으로 움직인다 */
function solo(onHostSilent?: (s: boolean) => void) {
  const make = peerMake({ onHostSilent });
  const s = make('ABCDEF');
  const got = { open: 0, closes: [] as (number | undefined)[], msgs: [] as unknown[] };
  s.onopen = () => { got.open++; };
  s.onclose = (e) => { got.closes.push(e.code); };
  s.onmessage = (e) => { got.msgs.push(e.data); };
  const peer = last(fake.peers);
  return { make, s, got, peer, dc: () => peer.dcs[0], up() { peer.ready(); const dc = peer.dcs[0]; dc.ready(); return dc; } };
}

/** 방장 PeerHost + 학생 make 를 가짜 연결 한 쌍으로 잇는다 */
function wire(host: PeerHost, make: (code: string) => SocketLike) {
  const hp = fake.peers.find((p) => String(p.id).startsWith('twj1-'))!;
  let n = 0;
  const links: { h: FakeDc; s: FakeDc }[] = [];
  return {
    host, links,
    make: (code: string) => {
      const s = make(code);
      const sp = last(fake.peers);
      queueMicrotask(() => {
        sp.ready(`stu-${n++}`);
        const h = hp.incoming(sp.id!, false);
        links.push({ h, s: sp.dcs[0] });
        pair(h, sp.dcs[0]);
      });
      return s;
    },
  };
}

describe('P2E07 닫힘 코드', () => {
  it('P2E07 방장 close(4000·4001·4002·1008) → 닫힘 프레임 → 학생 onclose 정확히 1번, RoomSocket 의 동작도 그대로', async () => {
    for (const [code, want] of [[4000, 'replaced'], [4001, 'final'], [4002, 'final'], [1008, 'retry']] as const) {
      fake.peers.length = 0;
      let conn!: HostConn;
      const port: HostPort = { message: () => {}, closed: () => {}, seated: () => false };
      const h = new PeerHost({ code: 'ABCDEF', accept: (c) => { conn = c; return port; } });
      fake.peers[0].ready();
      const w = wire(h, peerMake());
      const status: string[] = [];
      const finals: number[] = [];
      const closes: (number | undefined)[] = [];
      let made = 0;
      const rs = new RoomSocket({
        url: 'ABCDEF', greet: () => null, onMsg: () => {}, onStatus: (s) => status.push(s), onFinal: (c) => finals.push(c),
        make: (u) => {
          made++;
          const s = w.make(u);
          queueMicrotask(() => { const f = s.onclose; s.onclose = (e) => { closes.push(e.code); f?.(e); }; });
          return s;
        },
      });
      await flush();
      expect(status.at(-1)).toBe('open');
      conn.close(code, 'why');
      await flush();
      expect(w.links[0].h.of('c')).toEqual([{ t: 'c', code }]);
      expect(w.links[0].s.of('a')).toEqual([{ t: 'a' }]);
      expect(w.links[0].h.closes).toBe(1); // 확인을 받고 실제로 끊음
      expect(closes).toEqual([code]);
      await tick(499);
      expect(made).toBe(1);
      await tick(20_000);
      expect(closes.filter((c) => c === code)).toEqual([code]);
      if (want === 'replaced') expect([status.at(-1), finals.length, made]).toEqual(['replaced', 0, 1]);
      if (want === 'final') expect([finals, made]).toEqual([[code], 1]);
      if (want === 'retry') expect([finals.length, made]).toEqual([0, 2]);
      rs.close();
      await stop(h);
    }
  });
});

describe('P2E08 닫힘 경합', () => {
  it('P2E08 방장은 확인 a 를 받기 전에는 실제 연결을 끊지 않는다. 확인이 안 오면 3초 뒤', async () => {
    let conn!: HostConn;
    const h = new PeerHost({ code: 'ABCDEF', accept: (c) => { conn = c; return { message: () => {}, closed: () => {}, seated: () => false }; } });
    fake.peers[0].ready();
    const dc = fake.peers[0].incoming('s1');
    dc.emit('data', { t: 'h', v: 1, code: 'ABCDEF' });
    await flush();
    conn.send('{"t":"ended","by":"host"}');
    conn.close(4001, 'ended');
    await tick(2_999);
    expect(dc.closes + dc.flushes).toBe(0);
    expect(dc.sent.slice(-2)).toEqual([{ t: 'm', d: '{"t":"ended","by":"host"}' }, { t: 'c', code: 4001 }]);
    await tick(1);
    expect(dc.closes).toBe(1);
    // 확인이 오면 바로
    const dc2 = fake.peers[0].incoming('s2');
    dc2.emit('data', { t: 'h', v: 1, code: 'ABCDEF' });
    await flush();
    conn.close(4001);
    await tick(100);
    expect(dc2.closes).toBe(0);
    dc2.emit('data', { t: 'a' });
    await flush();
    expect(dc2.closes).toBe(1);
    await stop(h);
  });

  it('P2E08 방 전체 끝내기: 저장본은 먼저 지워져도 ended·닫힘 프레임은 확인까지 간다. close() 는 다 끊긴 뒤 ID 를 놓는다', async () => {
    const { host: room, store, code } = await newHost();
    const direct = new Direct(room);
    await direct.say({ t: 'hello', charId: 0 });
    const h = new PeerHost(room);
    fake.peers[0].ready();
    const dc = fake.peers[0].incoming('s1');
    dc.emit('data', { t: 'h', v: 1, code });
    dc.emit('data', { t: 'm', d: '{"t":"hello","charId":1}' });
    await flush();
    await direct.say({ t: 'end' });
    expect(store.keys(code)).toEqual([]);
    let done = false;
    void h.close().then(() => { done = true; });
    const late = fake.peers[0].incoming('s2', false); // 닫는 중에 온 새 연결은 받지 않는다
    expect(late.closes).toBe(1);
    await tick(2_999);
    expect([dc.closes, done, fake.peers[0].destroyed]).toEqual([0, false, false]);
    expect(dc.sent.slice(-2)).toEqual([{ t: 'm', d: '{"t":"ended","by":"host"}' }, { t: 'c', code: 4001 }]);
    await tick(1);
    expect([dc.closes, done, fake.peers[0].destroyed]).toEqual([1, true, true]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('P2E08 ended 만 받고 코드 없이 끊겨도 GameClient 는 첫 화면으로. 코드 없는 끊김의 onclose 는 1번·undefined', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const c = new GameClient(peerMake(), (code) => code);
    c.open('ABCDEF');
    const peer = last(fake.peers);
    peer.ready();
    const dc = peer.dcs[0];
    dc.ready();
    dc.emit('data', { t: 'm', d: '{"t":"ended","by":"host"}' });
    dc.cut();
    await tick(30_000);
    expect(c.state.bye).toBe('ended');
    expect(fake.peers.length).toBe(1); // 다시 잇지 않음

    const r = solo();
    r.up();
    r.dc().cut();
    r.dc().emit('close');
    await flush();
    expect(r.got.closes).toEqual([undefined]);
    vi.unstubAllGlobals();
  });

  it('P2E08 닫힘 프레임 뒤에 실제 끊김이 와도, 실제 끊김 뒤에 닫힘 프레임이 와도 onclose 는 1번', async () => {
    const a = solo();
    a.up();
    a.dc().emit('data', { t: 'c', code: 4002 });
    a.dc().cut();
    await tick(10_000);
    expect(a.got.closes).toEqual([4002]);
    const b = solo();
    b.up();
    b.dc().cut();
    b.dc().emit('data', { t: 'c', code: 4002 });
    await tick(10_000);
    expect(b.got.closes).toEqual([undefined]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('P2E08 닫기 직전에 보낸 leave 는 flush 로 남긴다. leave 가 못 닿고 끊기면 방장은 보통 끊김(30초 뒤 봇)', async () => {
    const r = solo();
    r.up();
    r.s.send('{"t":"leave"}');
    r.s.close(1000);
    await flush();
    expect(last(r.dc().sent)).toEqual({ t: 'm', d: '{"t":"leave"}' });
    expect([r.dc().flushes, r.peer.destroyed]).toEqual([1, false]);
    await tick(3_000);
    expect([r.peer.destroyed, vi.getTimerCount()]).toEqual([true, 0]);
    expect(r.got.closes).toEqual([1000]);

    fake.peers.length = 0;
    const { host: room, code } = await newHost();
    const direct = new Direct(room);
    await direct.say({ t: 'hello', charId: 0 });
    const h = new PeerHost(room);
    fake.peers[0].ready();
    const dc = fake.peers[0].incoming('s1');
    dc.emit('data', { t: 'h', v: 1, code });
    dc.emit('data', { t: 'm', d: '{"t":"hello","charId":1}' });
    await flush();
    await direct.say({ t: 'start' });
    dc.cut();
    await flush();
    expect([room.room.rec!.seats[1].connected, room.room.game!.seats[1].isBot]).toEqual([false, false]);
    await tick(OFFLINE_BOT_MS + 1_000);
    expect(room.room.game!.seats[1].isBot).toBe(true);
    await stop(h);
    room.close();
  });
});

describe('P2E11 못 붙음·무신호', () => {
  it('P2E11 열리면 첫 프레임이 인사, 그다음 onopen. 심박은 2초마다', async () => {
    const r = solo();
    r.s.onopen = () => r.s.send('{"t":"sync"}');
    const dc = r.up();
    expect(dc.sent).toEqual([{ t: 'h', v: 1, code: 'ABCDEF' }, { t: 'm', d: '{"t":"sync"}' }]);
    await tick(4_000);
    expect(dc.of('b').length).toBe(2);
    r.s.close();
    await flush();
  });

  it('P2E11 peer-unavailable · 시그널링 오류 · 20초 안에 안 열림 = onclose(code 없음) 1번, 남는 것 0', async () => {
    const cases: ((r: ReturnType<typeof solo>) => unknown)[] = [
      (r) => { r.peer.ready(); r.peer.emit('error', { type: 'peer-unavailable' }); },
      (r) => { r.peer.fail('server-error'); },
      (r) => { r.peer.ready(); r.dc().emit('error', { type: 'negotiation-failed' }); },
      async (r) => { r.peer.ready(); await tick(19_999); expect(r.got.closes).toEqual([]); await tick(1); },
    ];
    for (const f of cases) {
      const r = solo();
      await f(r);
      await flush();
      expect(r.got).toEqual({ open: 0, closes: [undefined], msgs: [] });
      expect([r.peer.destroyed, vi.getTimerCount()]).toEqual([true, 0]);
    }
  });

  it('P2E11 시그널링 ID 를 받기 전에 그만두면 ID 를 받는 순간 부순다(소켓이 남지 않게)', async () => {
    const r = solo();
    await tick(20_000);
    expect([r.got.closes, r.peer.destroyed]).toEqual([[undefined], false]);
    r.peer.ready();
    expect([r.peer.destroyed, r.peer.dcs.length]).toEqual([true, 0]);
  });

  it('P2E11 붙은 뒤 시그널링만 끊기는 것은 무시한다', async () => {
    const r = solo();
    r.up();
    r.peer.drop();
    await flush();
    expect(r.got.closes).toEqual([]);
    r.s.close();
  });

  it('P2E11 6초 무신호는 hostSilent 알림만(연결 유지), 프레임이 오면 풀리고, 10초 무신호면 onclose', async () => {
    const silent: boolean[] = [];
    const r = solo((s) => silent.push(s));
    r.up();
    await tick(5_999);
    expect(silent).toEqual([]);
    await tick(1);
    expect([silent, r.got.closes, r.s.readyState]).toEqual([[true], [], 1]);
    r.dc().emit('data', { t: 'b' });
    expect(silent).toEqual([true, false]);
    await tick(9_999);
    expect(r.got.closes).toEqual([]);
    await tick(1);
    expect([silent, r.got.closes]).toEqual([[true, false, true], [undefined]]);
    expect([r.peer.destroyed, r.dc().closes, vi.getTimerCount()]).toEqual([true, 1, 0]);
  });

  it('P2E11 보내기 오류(message-too-big·not-open-yet)는 채널을 닫지 않는다', async () => {
    const r = solo();
    r.up();
    for (const type of ['message-too-big', 'not-open-yet']) r.dc().emit('error', { type });
    await flush();
    expect([r.got.closes, r.s.readyState]).toEqual([[], 1]);
    r.s.close();
  });

  it('P2E11 재시도 20번 동안 살아 있는 연결 ≤ 1, 남는 타이머 ≤ RoomSocket 재시도 하나', async () => {
    const rs = new RoomSocket({ url: 'ABCDEF', greet: () => null, onMsg: () => {}, onStatus: () => {}, make: peerMake() });
    for (let i = 0; i < 20; i++) {
      const peer = last(fake.peers);
      peer.ready(`s${i}`);
      if (i % 3 === 0) peer.emit('error', { type: 'peer-unavailable' });
      else {
        peer.dcs[0].ready();
        peer.dcs[0].emit('data', i % 3 === 1 ? { t: 'c', code: 1008 } : { t: 'b' });
        if (i % 3 === 2) await tick(10_000);
      }
      await flush();
      const n = fake.peers.length;
      while (fake.peers.length === n) await tick(500);
      expect(fake.peers.filter((p) => !p.destroyed).length).toBe(1);
      expect(fake.peers.flatMap((p) => p.dcs).filter((d) => d.open).length).toBeLessThanOrEqual(1);
      expect(vi.getTimerCount()).toBe(1); // 새 시도의 20초 시한
    }
    rs.close();
    last(fake.peers).ready('end');
    await tick(3_000);
    expect([fake.peers.filter((p) => !p.destroyed).length, vi.getTimerCount()]).toEqual([0, 0]);
  });

  it('P2E11 조립을 버리면 sync 를 보내고 이어 온 전체 상태를 받는다. 모르는 프레임은 무시', async () => {
    const r = solo();
    const dc = r.up();
    dc.emit('data', { t: 'zz' });
    dc.emit('data', 0);
    dc.emit('data', { t: 'p', id: 1, i: 0, n: 2_049, d: 'x' });
    dc.emit('data', { t: 'p', id: 1, i: 1, n: 2_049, d: 'x' });
    expect(dc.of('m')).toEqual([{ t: 'm', d: '{"t":"sync"}' }]);
    dc.emit('data', { t: 'p', id: 2, i: 0, n: 2, d: '{"t":' });
    dc.emit('data', { t: 'p', id: 2, i: 1, n: 2, d: '"x"}' });
    expect(r.got.msgs).toEqual(['{"t":"x"}']);
    r.s.close();
  });
});

describe('P2bE01 시그널링이 끊긴 뒤 버리기', () => {
  it('P2bE01 가짜 Peer 는 진짜처럼 끊기면 id 가 비고 disconnected 에 옛 id 를 싣는다', () => {
    const r = solo();
    r.up();
    const ids: unknown[] = [];
    r.peer.on('disconnected', (id) => ids.push(id));
    r.peer.drop();
    expect([r.peer.id, r.peer.disconnected, r.peer.destroyed, ids]).toEqual([null, true, false, ['stu']]);
    r.peer.ready();
    expect(r.peer.id).toBe('stu');
    r.s.close();
  });

  it('P2bE01 10초 무신호 · 닫힘 프레임 4001 · RoomSocket.close(): Peer 와 연결이 부서지고 onclose 1번, 남는 타이머 0', async () => {
    const ends: [(r: ReturnType<typeof solo>, rs: RoomSocket) => unknown, number | undefined][] = [
      [() => tick(10_000), undefined],
      [(r) => r.dc().emit('data', { t: 'c', code: 4001 }), 4001],
      [(_, rs) => rs.close(), 1000],
    ];
    for (const [end, code] of ends) {
      const r = solo();
      const rs = new RoomSocket({ url: 'ABCDEF', greet: () => null, onMsg: () => {}, onStatus: () => {}, make: () => r.s, timers: { set: () => 0, clear: () => {} } });
      const f = r.s.onclose;
      const closes: (number | undefined)[] = [];
      r.s.onclose = (e) => { closes.push(e.code); f?.(e); };
      r.up();
      r.peer.drop();
      expect([r.peer.id, r.peer.disconnected]).toEqual([null, true]);
      await end(r, rs);
      await tick(3_000);
      expect([closes, r.peer.destroyed, r.dc().open, vi.getTimerCount()]).toEqual([[code], true, false, 0]);
    }
  });
});

describe('P2bE09 맺는 중의 webrtc 오류', () => {
  it('P2bE09 webrtc 오류로 시도를 버리지 않는다. 채널이 열리면 인사 → onopen 1번', async () => {
    const r = solo();
    r.peer.ready();
    r.peer.emit('error', { type: 'webrtc' });
    await flush();
    expect([r.got.closes, r.peer.destroyed]).toEqual([[], false]);
    r.dc().ready();
    expect([r.got.open, r.dc().sent]).toEqual([1, [{ t: 'h', v: 1, code: 'ABCDEF' }]]);
    r.s.close();
  });
  it('P2bE09 끝내 안 열리면 20초에 onclose(code 없음) 1번. peer-unavailable·network 는 곧바로', async () => {
    const r = solo();
    r.peer.ready();
    r.peer.emit('error', { type: 'webrtc' });
    await tick(19_999);
    expect(r.got.closes).toEqual([]);
    await tick(1);
    expect([r.got.closes, r.peer.destroyed, vi.getTimerCount()]).toEqual([[undefined], true, 0]);
    for (const type of ['peer-unavailable', 'network']) {
      const q = solo();
      q.peer.ready();
      q.peer.emit('error', { type });
      await flush();
      expect([q.got.closes, q.peer.destroyed, vi.getTimerCount()]).toEqual([[undefined], true, 0]);
    }
  });
});
