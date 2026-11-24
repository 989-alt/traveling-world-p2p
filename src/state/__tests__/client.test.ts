import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SocketLike } from '../../net/socket';
import { PIN_TRY_MS } from '../../shared/protocol';
import { GameClient } from '../client';
import type { HostNet } from '../host-net';
import { loadSeat, saveSeat } from '../seat-store';

class FakeSock implements SocketLike {
  readyState = 1;
  sent: unknown[] = [];
  onopen: SocketLike['onopen'] = null;
  onclose: SocketLike['onclose'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null;
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
  msg(m: unknown) { this.onmessage?.({ data: JSON.stringify(m) }); }
}

function rig() {
  const m = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
  saveSeat({ roomCode: 'ABCDEF', seatNo: 2, seatPin: '0420' });
  const socks: FakeSock[] = [];
  const c = new GameClient(() => { const s = new FakeSock(); socks.push(s); return s; }, () => 'ws://x');
  expect(c.resumeSaved()).toBe(true);
  socks[0].onopen?.({});
  expect(socks[0].sent[0]).toEqual({ t: 'rejoin', seat: 2, pin: '0420' });
  return { c, sock: socks[0] };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('GameClient 저장된 자리', () => {
  it("'locked'(PIN 확인 안 한 거부)엔 저장된 자리를 남기고 PIN_TRY_MS 뒤 같은 PIN 을 다시 보낸다", () => {
    vi.useFakeTimers();
    const { c, sock } = rig();
    sock.msg({ t: 'error', code: 'locked' });
    expect(c.state.error).toBe('locked');
    expect(loadSeat()).toEqual({ roomCode: 'ABCDEF', seatNo: 2, seatPin: '0420' });
    vi.advanceTimersByTime(PIN_TRY_MS - 1);
    expect(sock.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sock.sent).toEqual([{ t: 'rejoin', seat: 2, pin: '0420' }, { t: 'rejoin', seat: 2, pin: '0420' }]);
    sock.msg({ t: 'error', code: 'locked' }); // 또 잠김 → 또 한 번
    vi.advanceTimersByTime(PIN_TRY_MS);
    expect(sock.sent).toHaveLength(3);
    sock.msg({ t: 'error', code: 'locked' });
    c.close(); // 닫으면 다시 보내지 않는다
    vi.advanceTimersByTime(PIN_TRY_MS);
    expect(sock.sent).toHaveLength(3);
  });
  it("'pin'(틀린 PIN)엔 저장된 자리를 지운다", () => {
    const { c, sock } = rig();
    sock.msg({ t: 'error', code: 'pin' });
    expect(c.state.error).toBe('pin');
    expect(loadSeat()).toBeNull();
  });
});

describe('GameClient 끝내기·나가기 (U14, PRD §9.4)', () => {
  const st = (phase: string) => ({ t: 'state', code: 'ABCDEF', phase, settings: { totalMinutes: 40, touristQuiz: false }, hostSeat: 0, seats: [], game: null, deadlineAt: null, stepAt: 0, now: 0, cards: [], notice: null, cutscene: null, logFrom: 0, log: [] });

  it('ended 를 받으면(방장 아닌 기기) 저장 자리 삭제 → 첫 화면 + 안내 띠, 다시 잇지 않는다', () => {
    vi.useFakeTimers();
    const { c, sock } = rig();
    sock.msg(st('playing'));
    expect(c.state.room).not.toBeNull();
    sock.msg({ t: 'ended', by: 'host' });
    expect(c.state.code).toBeNull();
    expect(c.state.room).toBeNull();
    expect(c.state.bye).toBe('ended');
    expect(loadSeat()).toBeNull();
    sock.onclose?.({ code: 4001 }); // 뒤이은 닫힘은 이미 버린 소켓
    vi.advanceTimersByTime(20_000);
    expect(c.state.code).toBeNull();
    c.dismissBye();
    expect(c.state.bye).toBeNull();
  });

  it('메시지 없이 4001 로 닫혀도 같은 길. 방장이 끝내기를 보낸 기기는 띠 없음', () => {
    const a = rig();
    a.sock.onclose?.({ code: 4001 });
    expect(a.c.state.code).toBeNull();
    expect(a.c.state.bye).toBe('ended');
    expect(loadSeat()).toBeNull();
    const b = rig();
    expect(b.c.endGame()).toBe(true);
    expect(b.sock.sent.at(-1)).toEqual({ t: 'end' });
    b.sock.msg({ t: 'ended', by: 'host' });
    expect(b.c.state.code).toBeNull();
    expect(b.c.state.bye).toBeNull();
  });

  it('나가기: leave 를 보내고 바로 첫 화면·저장 자리 삭제. 그 소켓의 늦은 상태·4002 닫힘은 무시', () => {
    vi.useFakeTimers();
    const { c, sock } = rig();
    sock.msg(st('playing'));
    c.leaveGame();
    expect(sock.sent.at(-1)).toEqual({ t: 'leave' });
    expect(c.state.code).toBeNull();
    expect(c.state.bye).toBeNull();
    expect(loadSeat()).toBeNull();
    sock.msg(st('playing')); // 서버가 닫기 전 방송
    expect(c.state.room).toBeNull();
    vi.advanceTimersByTime(3_000);
    expect(sock.readyState).toBe(3); // 3초 안에 서버가 안 닫으면 이쪽에서
    sock.onclose?.({ code: 4002 });
    expect(c.state.code).toBeNull();
  });

  it('멈춤 PIN 은 판이 다시 돌면 버린다(멈춤 모달 ↔ 이어 하기 화면 가름)', () => {
    const { c, sock } = rig();
    sock.msg(st('playing'));
    sock.msg({ t: 'pins', pins: [{ seat: 2, pin: '0420' }] });
    sock.msg(st('paused'));
    expect(c.state.pins).toEqual([{ seat: 2, pin: '0420' }]);
    sock.msg(st('playing'));
    expect(c.state.pins).toBeNull();
  });
});

describe('P3E17 새 연결의 첫 state 는 전체여야 한다(되돌아간 판)', () => {
  const ev = (n: number, who: string) => Array.from({ length: n }, (_, i) => ({ ev: 'clock', kind: 'start', remainingMs: i, by: 'host', who }));
  const st = (logFrom: number, log: unknown[], phase = 'playing') => ({ t: 'state', code: 'ABCDEF', phase, settings: { totalMinutes: 40, touristQuiz: false }, hostSeat: 0, seats: [], game: null, deadlineAt: null, stepAt: 0, now: 0, cards: [], notice: null, cutscene: null, logFrom, log });
  /** 로그 100개를 가진 학생이 끊겼다 다시 붙은 새 소켓 */
  function back() {
    vi.useFakeTimers();
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    saveSeat({ roomCode: 'ABCDEF', seatNo: 2, seatPin: '0420' });
    const socks: FakeSock[] = [];
    const c = new GameClient(() => { const s = new FakeSock(); socks.push(s); return s; });
    c.resumeSaved();
    socks[0].onopen?.({});
    socks[0].msg({ t: 'welcome', seat: 2, pin: '0420' });
    socks[0].msg(st(0, ev(100, '옛')));
    expect(c.state.log).toHaveLength(100);
    const fresh: number[] = [];
    c.subscribe((s) => fresh.push(s.fresh.length));
    socks[0].onclose?.({});
    vi.advanceTimersByTime(500);
    expect(socks).toHaveLength(2);
    socks[1].onopen?.({});
    return { c, sock: socks[1], fresh };
  }
  const host = [...ev(90, '옛'), ...ev(2, '새')];

  it('P3E17 ⓐ rejoin 답보다 증분 state(logFrom 91)가 먼저: 붙이지 않고 sync 한 번, 끝에는 방장 로그와 같다', () => {
    const { c, sock, fresh } = back();
    sock.msg(st(91, host.slice(91)));
    sock.msg(st(92, []));
    expect(c.state.log).toEqual(ev(100, '옛'));
    expect(sock.sent).toEqual([{ t: 'rejoin', seat: 2, pin: '0420' }, { t: 'sync' }]);
    sock.msg({ t: 'welcome', seat: 2, pin: '0420' });
    sock.msg(st(0, host, 'paused'));
    sock.msg(st(0, host, 'paused')); // sync 의 답
    expect(c.state.log).toEqual(host);
    expect(Math.max(...fresh)).toBe(0);
    // 판에 있던 기기가 다시 붙어 보니 멈춘 판 → 멈춤 모달(자기 PIN)
    expect(c.state.pins).toEqual([{ seat: 2, pin: '0420' }]);
    sock.msg(st(92, ev(1, '다음'))); // 전체를 받은 뒤의 증분은 지금대로
    expect([c.state.log.length, c.state.fresh.length, sock.sent.length]).toEqual([93, 1, 2]);
  });

  it('P3E17 ⓑ 저장 멈춤 뒤에 앉은 자리(rejoin 이 error pin): 저장 자리를 지우고 PIN 길로, 로그는 방장과 같다', () => {
    const { c, sock, fresh } = back();
    sock.msg(st(91, host.slice(91)));
    sock.msg({ t: 'error', code: 'pin' });
    sock.msg(st(0, host, 'paused'));
    expect(c.state.log).toEqual(host);
    expect(Math.max(...fresh)).toBe(0);
    expect([c.state.seat, c.state.pin, c.state.pins, c.state.error, loadSeat()]).toEqual([null, null, null, 'pin', null]);
    sock.onclose?.({});
    expect(c.state.conn).toBe('retrying');
  });
});

describe('저장 자리로 들어가기(기기 간 통신)', () => {
  it('첫 화면으로 갔다가(방장 기다림) 같은 코드를 넣으면 저장 자리로 돌아온다', () => {
    const { c } = rig();
    c.home();
    expect([c.state.code, loadSeat()?.roomCode]).toEqual([null, 'ABCDEF']);
    const socks: FakeSock[] = [];
    const d = new GameClient(() => { const s = new FakeSock(); socks.push(s); return s; });
    d.open('ABCDEF');
    socks[0].onopen?.({});
    expect(socks[0].sent).toEqual([{ t: 'rejoin', seat: 2, pin: '0420' }]);
    d.close();
  });
  it('저장된 방이 없는 자리 0(저장이 막힌 방장 기기)은 다시 잇지 않고 첫 화면', () => {
    rig().c.close();
    saveSeat({ roomCode: 'ABCDEF', seatNo: 0, seatPin: '0420' });
    const d = new GameClient(() => { throw new Error('붙지 않는다'); });
    expect([d.resumeSaved(), d.state.code, loadSeat()]).toEqual([false, null, null]);
  });
  it('방장 기다림: 끊긴 채 6초면 뜨고, 다시 받은 상태에서 걷힌다. 잠깐 끊긴 것은 안 뜬다', () => {
    vi.useFakeTimers();
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    const st = { t: 'state', code: 'ABCDEF', phase: 'lobby', settings: {}, hostSeat: 0, seats: [], game: null, deadlineAt: null, stepAt: 0, now: 0, cards: [], notice: null, cutscene: null, logFrom: 0, log: [] };
    const socks: FakeSock[] = [];
    const c = new GameClient(() => { const s = new FakeSock(); socks.push(s); return s; });
    c.open('ABCDEF');
    const join = () => { socks.at(-1)!.onopen?.({}); socks.at(-1)!.msg(st); };
    join();
    socks[0].onclose?.({});
    vi.advanceTimersByTime(5_000);
    join();
    vi.advanceTimersByTime(20_000);
    expect([c.state.away, c.state.late]).toEqual([null, false]);
    socks.at(-1)!.onclose?.({});
    vi.advanceTimersByTime(5_999);
    expect(c.state.away).toBeNull();
    vi.advanceTimersByTime(1);
    expect(c.state.away).toBe(Date.now());
    const at = c.state.away;
    vi.advanceTimersByTime(30_000);
    expect(c.state.away).toBe(at);
    socks.at(-1)!.onopen?.({}); // 열린 것만으로는 걷히지 않는다
    expect(c.state.away).toBe(at);
    socks.at(-1)!.msg(st);
    expect(c.state.away).toBeNull();
    c.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});

/** 저장 자리 2 로 붙은 학생. phase 의 상태까지 받았다 */
function seated(phase: string, Client = GameClient) {
  vi.useFakeTimers();
  const m = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
  const saved = { roomCode: 'ABCDEF', seatNo: 2 as const, seatPin: '0420' };
  saveSeat(saved);
  const socks: FakeSock[] = [];
  const c = new Client(() => { const s = new FakeSock(); socks.push(s); return s; });
  c.resumeSaved();
  const log = Array.from({ length: 30 }, (_, i) => ({ ev: 'clock', kind: 'start', remainingMs: i, by: 'host' }));
  const state = (p: string) => ({ t: 'state', code: 'ABCDEF', phase: p, settings: { totalMinutes: 40, touristQuiz: false }, hostSeat: 0, seats: [], game: null, deadlineAt: null, stepAt: 0, now: Date.now(), cards: [], notice: null, cutscene: null, logFrom: 0, log });
  const join = (p = phase) => { const s = socks.at(-1)!; s.onopen?.({}); s.msg({ t: 'welcome', seat: 2, pin: '0420' }); s.msg(state(p)); };
  /** 연결 층이 알리는 방장 신호 끊김(심박 6초) */
  const silent = () => (c as unknown as { goAway(): void }).goAway();
  /** app.tsx 의 끊김 띠 조건 */
  const band = () => ['connecting', 'retrying'].includes(c.state.conn);
  return { c, socks, saved, state, join, silent, band };
}

describe('P3bE07 끝난 판은 다시 잇지 않는다(§8-18)', () => {
  const ways: [string, (r: ReturnType<typeof seated>) => void][] = [
    ['ⓐ 코드 없이', (r) => r.socks[0].onclose?.({})],
    ['ⓑ 1008', (r) => r.socks[0].onclose?.({ code: 1008 })],
    ['ⓑ 1001', (r) => r.socks[0].onclose?.({ code: 1001 })],
    ['ⓒ 심박 6초·10초', (r) => { r.silent(); expect(r.c.state.away).toBeNull(); vi.advanceTimersByTime(4_000); r.socks[0].onclose?.({}); }],
  ];
  for (const [name, cut] of ways) it(`P3bE07 ${name}: 다시 잇기 0 · 띠 0 · 방장 기다림 0 · 결과는 그대로 · 저장 자리 그대로`, async () => {
    const r = seated('finished');
    r.join();
    const { room, log } = r.c.state;
    cut(r);
    await Promise.resolve();
    const seen: unknown[] = [];
    r.c.subscribe((s) => seen.push(s));
    vi.advanceTimersByTime(60_000);
    expect([r.socks.length, r.c.state.conn, r.band(), r.c.state.away, r.c.state.late, r.c.state.bye, seen.length]).toEqual([1, 'idle', false, null, false, null, 0]);
    expect([r.c.state.room === room, r.c.state.log === log, log.length, r.c.state.seat]).toEqual([true, true, 30, 2]);
    expect(loadSeat()).toEqual(r.saved);
    expect(vi.getTimerCount()).toBe(0);
    r.c.leave(); // 결과 화면의 [처음으로]
    expect([r.c.state.code, loadSeat()]).toEqual([null, null]);
  });

  it('P3bE07 ⓓ 독점 끝 연출 중(진행 중이던 기기가 막 finished 를 받음)에 끊겨도 같다', async () => {
    const r = seated('playing');
    r.join();
    r.socks[0].msg({ ...JSON.parse(JSON.stringify({ t: 'state', code: 'ABCDEF', phase: 'finished', settings: {}, hostSeat: 0, seats: [], game: null, deadlineAt: null, stepAt: 0, now: 0, cards: [], notice: null, cutscene: null })), logFrom: 30, log: [{ ev: 'event', kind: 'monopoly' }] });
    const { room, seq, fresh } = r.c.state;
    r.socks[0].onclose?.({});
    await Promise.resolve();
    vi.advanceTimersByTime(60_000);
    expect([r.socks.length, r.c.state.conn, r.c.state.away, r.c.state.room === room, r.c.state.seq, r.c.state.fresh === fresh]).toEqual([1, 'idle', null, true, seq, true]);
  });

  it('P3bE07 ⓔ 끝나기 전에 끊긴 학생: 방장 기다림, 다시 잇기 계속', () => {
    const r = seated('playing');
    r.join();
    r.socks[0].onclose?.({});
    expect(r.band()).toBe(true);
    vi.advanceTimersByTime(6_000);
    expect(r.c.state.away).not.toBeNull();
    const n = r.socks.length;
    for (let i = 0; i < 3; i++) { r.socks.at(-1)!.onclose?.({}); vi.advanceTimersByTime(10_000); }
    expect(r.socks.length).toBeGreaterThan(n);
    r.c.home();
    expect(loadSeat()).toEqual(r.saved);
  });

  it('P3bE07 ⓕ ws 빌드는 끝난 판에서도 다시 잇는다', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_TW_NET', 'ws');
    vi.stubGlobal('location', { protocol: 'http:', host: 'x' });
    const ws = await import('../client');
    await import('../../net/ws');
    const r = seated('finished', ws.GameClient as unknown as typeof GameClient);
    await vi.advanceTimersByTimeAsync(0);
    r.join();
    r.socks[0].onclose?.({});
    expect(r.c.state.conn).toBe('retrying');
    await vi.advanceTimersByTimeAsync(500);
    expect(r.socks).toHaveLength(2);
    r.c.close();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe('P5E03 끝난 방의 자리 번호 화면', () => {
  it('P5E03 자리 없는 기기는 끊겨도 다시 잇고, 방장이 다시 열려 자리 번호를 넣으면 앉는다. 앉은 뒤에는 다시 잇지 않는다', async () => {
    const r = seated('finished');
    saveSeat(null);
    r.c.open('ABCDEF');
    const enter = () => { const s = r.socks.at(-1)!; s.onopen?.({}); s.msg(r.state('finished')); };
    enter();
    expect([r.c.state.seat, r.c.state.room?.phase]).toEqual([null, 'finished']);
    const n = r.socks.length;
    r.silent();
    expect(r.c.state.away).not.toBeNull(); // 끊김 띠(app.tsx)
    r.socks.at(-1)!.onclose?.({});
    await Promise.resolve();
    expect([r.c.state.conn, r.band()]).toEqual(['retrying', true]);
    vi.advanceTimersByTime(60_000);
    expect(r.socks.length).toBeGreaterThan(n);
    enter();
    expect([r.c.state.conn, r.c.state.away]).toEqual(['open', null]);
    r.c.claim(2, '0420');
    r.socks.at(-1)!.msg({ t: 'welcome', seat: 2, pin: '0420' });
    expect([r.c.state.seat, r.c.state.room?.phase]).toEqual([2, 'finished']);
    const sat = r.socks.length;
    r.socks.at(-1)!.onclose?.({});
    await Promise.resolve();
    vi.advanceTimersByTime(60_000);
    expect([r.socks.length, r.c.state.conn]).toEqual([sat, 'idle']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('P3bE09 닫힘 코드의 화면(§9.5)', () => {
  it('P3bE09 ⓐ 판에 앉아 있던 학생의 1008: 띠 → 6초 뒤 방장 기다림, 늘어난 간격으로 계속, late 0, 저장 자리 그대로', () => {
    const r = seated('playing');
    r.join();
    const t0 = Date.now();
    r.socks[0].onclose?.({ code: 1008 });
    expect(r.band()).toBe(true);
    const at: number[] = [];
    let away: number | null = null;
    for (let n = 1; Date.now() - t0 < 60_000; vi.advanceTimersByTime(100)) {
      if (r.socks.length > n) { n = r.socks.length; at.push(Date.now() - t0); r.socks[n - 1].onopen?.({}); r.socks[n - 1].onclose?.({ code: 1008 }); }
      away ??= r.c.state.away && r.c.state.away - t0;
    }
    expect(away).toBe(6_000);
    expect([0, ...at].slice(1).map((x, i) => Math.round((x - [0, ...at][i]) / 500) * 500).slice(0, 7)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
    expect([r.c.state.late, r.c.state.room!.phase, loadSeat()]).toEqual([false, 'playing', r.saved]);
    r.c.close();
  });

  it('P3bE09 ⓑ 대기실 학생의 1001: 띠 → 방장 기다림, 저장 자리 그대로', () => {
    const r = seated('lobby');
    r.join();
    r.socks[0].onclose?.({ code: 1001 });
    expect(r.band()).toBe(true);
    vi.advanceTimersByTime(5_999);
    expect(r.c.state.away).toBeNull();
    vi.advanceTimersByTime(1);
    expect([r.c.state.away, r.c.state.bye, r.c.state.late, loadSeat()]).toEqual([Date.now(), null, false, r.saved]);
    r.c.close();
  });

  it('P3bE09 ⓒ 방장 기기의 직결이 1001(만료): 첫 화면, 띠 0, 저장 자리 삭제, PeerHost.close 1번', async () => {
    vi.useFakeTimers();
    rig().c.close();
    const sock = new FakeSock();
    let closes = 0;
    const net = { restored: false, stalled: false, room: { code: 'ABCDEG', hostRejoin: () => null, loopback: () => sock }, bind() {}, start() {}, close() { closes++; } };
    const c = new GameClient(undefined, undefined, async () => ({ createHost: async () => net as unknown as HostNet, openHost: async () => 'none' as const }));
    expect(await c.create({ totalMinutes: 40 })).toBe(true);
    sock.onopen?.({});
    sock.msg({ t: 'welcome', seat: 0, pin: '1234' });
    expect(loadSeat()).toMatchObject({ roomCode: 'ABCDEG', seatNo: 0 });
    sock.onclose?.({ code: 1001 });
    await Promise.resolve();
    expect([c.state.code, c.state.bye, c.state.host, loadSeat(), closes]).toEqual([null, null, null, null, 1]);
    vi.advanceTimersByTime(60_000);
    expect([closes, vi.getTimerCount()]).toEqual([1, 0]);
  });
});
