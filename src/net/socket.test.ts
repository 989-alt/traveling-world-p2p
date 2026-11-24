import { describe, expect, it } from 'vitest';
import { backoff, RoomSocket, type SocketLike } from './socket';

class FakeSock implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  onopen: SocketLike['onopen'] = null;
  onclose: SocketLike['onclose'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  send(d: string) { this.sent.push(d); }
  close(code?: number) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.({}); }
}

function rig(greet: () => unknown = () => null) {
  const socks: FakeSock[] = [];
  const timers: { f: () => void; ms: number }[] = [];
  const status: string[] = [];
  const msgs: unknown[] = [];
  const rs = new RoomSocket({
    url: 'ws://x', greet: greet as never, onMsg: (m) => msgs.push(m), onStatus: (s) => status.push(s),
    make: () => { const s = new FakeSock(); socks.push(s); return s; },
    timers: { set: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clear: () => {} },
  });
  return { rs, socks, timers, status, msgs };
}

describe('backoff', () => {
  it('첫 재시도는 2초 안, 두 배씩, 상한 10초', () => {
    expect(backoff(0)).toBeLessThanOrEqual(2000);
    expect([0, 1, 2, 3, 4, 5, 6].map(backoff)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
  });
});

describe('RoomSocket', () => {
  it('열리면 자리 되찾기 메시지를 먼저 보낸다', () => {
    const r = rig(() => ({ t: 'rejoin', seat: 1, pin: '1234' }));
    r.socks[0].open();
    expect(JSON.parse(r.socks[0].sent[0])).toEqual({ t: 'rejoin', seat: 1, pin: '1234' });
    expect(r.status.at(-1)).toBe('open');
  });

  it('끊기면 백오프로 다시 열고, 열리면 시도 횟수를 0 으로', () => {
    const r = rig();
    r.socks[0].open();
    r.socks[0].close();
    expect(r.status.at(-1)).toBe('retrying');
    expect(r.timers[0].ms).toBe(500);
    r.timers[0].f(); // 재시도 1: 새 소켓
    expect(r.socks).toHaveLength(2);
    r.socks[1].close(); // 열리기 전에 또 실패
    expect(r.timers[1].ms).toBe(1000);
    r.timers[1].f();
    r.socks[2].open();
    r.socks[2].close();
    expect(r.timers[2].ms).toBe(500);
  });

  it('P3E26 열림 → 곧 1008 이 이어지면 간격이 늘고 0.5초로 돌아가지 않는다. 열려서 유지되면 그 뒤 첫 끊김만 늘어난 간격, 다시 열리면 0.5초부터', () => {
    const r = rig();
    const gaps = () => r.timers.map((t) => t.ms);
    for (let i = 0; i < 10; i++) {
      r.socks[i].open();
      r.socks[i].close(1008);
      r.timers[i].f();
    }
    expect(gaps()).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000, 10000, 10000, 10000]);
    r.socks[10].open(); // 1008 뒤에 열려서 유지
    r.socks[10].close(); // 한참 뒤 코드 없이 끊김
    expect(gaps().at(-1)).toBe(10000);
    r.timers[10].f();
    r.socks[11].open(); // 1008 이 아닌 닫힘을 거쳐 열림
    r.socks[11].close();
    expect(gaps().at(-1)).toBe(500);
  });

  it('P3E26 열리지 않는 닫힘은 지금과 같고, 1008 뒤의 4000·4001·4002 도 다시 잇지 않는다', () => {
    const r = rig();
    for (let i = 0; i < 4; i++) { r.socks[i].close(); r.timers[i].f(); }
    expect(r.timers.map((t) => t.ms)).toEqual([500, 1000, 2000, 4000]);
    r.socks[4].open();
    r.socks[4].close();
    expect(r.timers.at(-1)!.ms).toBe(500);
    for (const code of [4000, 4001, 4002]) {
      const q = rig();
      q.socks[0].open();
      q.socks[0].close(1008);
      q.timers[0].f();
      q.socks[1].open();
      q.socks[1].close(code);
      expect(q.timers, String(code)).toHaveLength(1);
    }
  });

  it('4000(다른 기기가 자리를 가져감)으로 닫히면 다시 잇지 않는다', () => {
    const r = rig();
    r.socks[0].open();
    r.socks[0].close(4000);
    expect(r.status.at(-1)).toBe('replaced');
    expect(r.timers).toHaveLength(0);
  });

  it('(U14) 4001 ended · 4002 left 로 닫히면 다시 잇지 않고 onFinal 로 알린다', () => {
    for (const code of [4001, 4002]) {
      const finals: number[] = [];
      const socks: FakeSock[] = [];
      const timers: unknown[] = [];
      const rs = new RoomSocket({
        url: 'ws://x', greet: () => null, onMsg: () => {}, onStatus: () => {}, onFinal: (c) => finals.push(c),
        make: () => { const s = new FakeSock(); socks.push(s); return s; },
        timers: { set: (f) => { timers.push(f); return timers.length; }, clear: () => {} },
      });
      socks[0].open();
      socks[0].close(code);
      expect(finals).toEqual([code]);
      expect(timers).toHaveLength(0);
      expect(socks).toHaveLength(1);
      void rs;
    }
  });

  it('close() 뒤에는 다시 잇지 않는다', () => {
    const r = rig();
    r.socks[0].open();
    r.rs.close();
    expect(r.timers).toHaveLength(0);
  });

  it('처리 중 오류는 console.error 로 남기고 다시 던진다(삼키지 않음)', () => {
    const socks: FakeSock[] = [];
    const errs: unknown[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errs.push(a); };
    try {
      new RoomSocket({ url: 'ws://x', greet: () => null, onStatus: () => {}, onMsg: () => { throw new Error('boom'); },
        make: () => { const s = new FakeSock(); socks.push(s); return s; }, timers: { set: () => 0, clear: () => {} } });
      socks[0].open();
      expect(() => socks[0].onmessage?.({ data: '{"t":"x"}' })).toThrow('boom');
      expect(errs).toHaveLength(1);
    } finally { console.error = orig; }
  });

  it('열리지 않은 소켓으로는 보내지 않는다, 깨진 메시지는 버린다', () => {
    const r = rig();
    expect(r.rs.send({ t: 'sync' })).toBe(false);
    r.socks[0].open();
    r.socks[0].onmessage?.({ data: '{깨짐' });
    r.socks[0].onmessage?.({ data: '{"t":"error","code":"bad"}' });
    expect(r.msgs).toEqual([{ t: 'error', code: 'bad' }]);
  });
});
