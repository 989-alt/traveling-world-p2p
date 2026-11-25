import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXPIRE_MS } from '../../../worker/room';
import { FakeLocks, FakeMirror, FakeStore, flush } from '../../host/__tests__/helpers';
import { openMirror, type MirrorBackend } from '../../host/mirror';
import { hostKey } from '../../host/storage';
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
    expect(sock.sent).toHaveLength(1); // P2P-7: 앉은 적 없는 기기는 저절로 다시 앉지 않는다
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
    expect(sock.sent.filter((m) => (m as { t: string }).t === 'hello')).toEqual([]); // P2P-7: 판 중
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

describe('P7E09 앱을 여는 순서(boot)', () => {
  afterEach(async () => { await openMirror(() => { throw new Error('끔'); }); });
  const seat = { roomCode: 'ABCDEF', seatNo: 2 as const, seatPin: '0420' };
  /** 만료된 방 하나와 저장 자리 2 가 있는 기기. 거울은 시험이 답한다 */
  function rigBoot() {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const store = new FakeStore();
    vi.stubGlobal('localStorage', store);
    vi.stubGlobal('navigator', { locks: new FakeLocks() });
    saveSeat(seat);
    const old = hostKey('BBBBBB', 'room');
    store.data.set(old, JSON.stringify({ expiresAt: 1 }));
    const socks: FakeSock[] = [];
    const opened: string[] = [];
    const c = new GameClient(() => { const s = new FakeSock(); socks.push(s); return s; }, undefined,
      async () => ({ createHost: async () => null, openHost: async (code: string) => { opened.push(code); return 'busy' as const; } }));
    const swept: boolean[] = [];
    const resume = c.resumeSaved.bind(c);
    c.resumeSaved = () => { swept.push(!store.data.has(old)); return resume(); };
    let answer: (v: Map<string, string>) => void = () => {};
    const mirror: MirrorBackend = { all: () => new Promise((ok) => { answer = ok; }), write: async () => {} };
    const p = c.boot(() => mirror);
    return { c, store, socks, opened, swept, old, p, answer: async (v = new Map<string, string>()) => { answer(v); await p; } };
  }

  it('P7E09 읽는 동안 사용자가 코드를 넣음: 자동 복귀를 건너뛰고 청소는 한다', async () => {
    const r = rigBoot();
    expect([r.c.state.code, r.store.data.has(r.old)]).toEqual([null, true]);
    r.c.open('GGGGGG');
    const { state } = r.c;
    await r.answer(new Map([['tw.seat', JSON.stringify({ ...seat, at: Date.now() + 1 })]]));
    expect([r.c.state === state, r.c.state.code, r.socks.length, r.swept, r.store.data.has(r.old)]).toEqual([true, 'GGGGGG', 1, [], false]);
    r.c.close();
  });

  it('P7E09 읽는 동안 사용자가 방을 만듦: 만든 방 그대로', async () => {
    const r = rigBoot();
    const sock = new FakeSock();
    const net = { restored: false, stalled: false, room: { code: 'HHHHHH', hostRejoin: () => null, loopback: () => sock }, bind() {}, start() {}, close() {} };
    (r.c as unknown as { loadHost: unknown }).loadHost = async () => ({ createHost: async () => net });
    expect(await r.c.create({ totalMinutes: 40 })).toBe(true);
    await r.answer();
    expect([r.c.state.code, r.c.state.host !== null, r.swept]).toEqual(['HHHHHH', true, []]);
    r.c.close();
  });

  it('P7E09 읽기가 시한을 넘김: 2초에 청소 → 자동 복귀', async () => {
    const r = rigBoot();
    await vi.advanceTimersByTimeAsync(1_999);
    expect([r.c.state.code, r.store.data.has(r.old)]).toEqual([null, true]);
    await vi.advanceTimersByTimeAsync(1);
    await r.p;
    expect([r.c.state.code, r.socks.length, r.swept]).toEqual(['ABCDEF', 1, [true]]);
    r.c.close();
  });

  it('P7E09 거울이 없어도 청소 → 자동 복귀', async () => {
    const r = rigBoot();
    await r.answer();
    expect([r.c.state.code, r.swept]).toEqual(['ABCDEF', [true]]);
    r.c.close();
    const c = new GameClient(() => new FakeSock());
    await c.boot(); // node 에는 indexedDB 가 없다
    expect(c.state.code).toBe('ABCDEF');
    c.close();
  });

  it('P7E09 거울의 방·자리가 먼저 들어와 방장으로 저절로 돌아온다', async () => {
    const r = rigBoot();
    const room = JSON.stringify({ code: 'KKKKKK', expiresAt: Date.now() + EXPIRE_MS, logChunks: 0, logLen: 0 });
    await r.answer(new Map([
      [hostKey('KKKKKK', 'room'), room], [hostKey('KKKKKK', 'alive'), '5'],
      ['tw.seat', JSON.stringify({ roomCode: 'KKKKKK', seatNo: 0, seatPin: '1234', at: Date.now() + 1 })],
    ]));
    await flush();
    expect([r.c.state.code, r.store.data.get(hostKey('KKKKKK', 'room')), r.opened, r.swept]).toEqual(['KKKKKK', room, ['KKKKKK'], [true]]);
    expect(loadSeat()).toEqual({ roomCode: 'KKKKKK', seatNo: 0, seatPin: '1234' });
    r.c.close();
  });
});

describe('P7E10 되돌아간 대기실의 학생', () => {
  const seatsOf = (chars: (number | null)[]) => chars.map((c) => ({ taken: c !== null, charId: c ?? 0 }));
  const st = (chars: (number | null)[], phase = 'lobby') => ({ t: 'state', code: 'ABCDEF', phase, settings: { totalMinutes: 40, touristQuiz: false }, hostSeat: 0, seats: seatsOf(chars), game: null, deadlineAt: null, stepAt: 0, now: 0, cards: [], notice: null, cutscene: null, logFrom: 0, log: [] });
  /** 코드로 들어와 캐릭터 3 으로 자리 1 에 앉은 학생 */
  function sat(Client = GameClient) {
    vi.useFakeTimers();
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    const socks: FakeSock[] = [];
    const c = new Client(() => { const s = new FakeSock(); socks.push(s); return s; }, () => 'ws://x');
    const join = () => {
      c.open('ABCDEF');
      const s = socks.at(-1)!;
      s.onopen?.({});
      s.msg(st([0, null, null, null]));
      c.join(3);
      s.msg({ t: 'welcome', seat: 1, pin: '0420' });
      s.msg(st([0, 3, null, null]));
    };
    /** 끊겼다 다시 붙음: 방이 chars·phase 로 보인다 */
    const again = (chars: (number | null)[], phase = 'lobby') => {
      socks.at(-1)!.onclose?.({});
      vi.advanceTimersByTime(10_000);
      const s = socks.at(-1)!;
      s.onopen?.({});
      s.msg(st(chars, phase));
      return s;
    };
    const back = (chars: (number | null)[], phase = 'lobby') => { const s = again(chars, phase); s.msg({ t: 'error', code: 'pin' }); return s; };
    return { c, socks, join, again, back };
  }
  const hellos = (s: FakeSock) => s.sent.filter((x) => (x as { t: string }).t === 'hello');
  const HELLO = { t: 'hello', charId: 3 };
  const REJOIN = { t: 'rejoin', seat: 1, pin: '0420' };

  it('P7E10 같은 캐릭터로 hello 한 번. 그 전에 자리·저장 자리를 비우고, 받아 주면 새 번호로 앉는다. 또 되돌아가면 또 한 번', () => {
    const r = sat();
    r.join();
    const seen: unknown[] = [];
    r.c.subscribe((s) => seen.push([s.seat, loadSeat()]));
    const s = r.back([0, null, null, null]);
    expect(s.sent).toEqual([REJOIN, HELLO]);
    expect(seen.at(-1)).toEqual([null, null]);
    s.msg({ t: 'welcome', seat: 1, pin: '7777' });
    s.msg(st([0, 3, null, null]));
    expect([r.c.state.seat, r.c.state.pin, r.c.state.error, loadSeat()]).toEqual([1, '7777', null, { roomCode: 'ABCDEF', seatNo: 1, seatPin: '7777' }]);
    const t = r.back([0, null, null, null]);
    expect(t.sent).toEqual([{ ...REJOIN, pin: '7777' }, HELLO]);
    r.c.close();
  });

  const none: [string, (number | null)[], string][] = [
    ['캐릭터를 남이 씀', [3, null, null, null], 'lobby'],
    ['빈자리 없음', [0, 1, 2, 4], 'lobby'],
    ['하는 중', [0, null, null, null], 'playing'],
    ['멈춤', [0, null, null, null], 'paused'],
  ];
  for (const [name, chars, phase] of none) it(`P7E10 ${name}: hello 0`, () => {
    const r = sat();
    r.join();
    const s = r.back(chars, phase);
    expect([s.sent, r.c.state.seat, r.c.state.error, loadSeat()]).toEqual([[REJOIN], null, 'pin', null]);
    r.c.close();
  });

  it('P7E10 저장 자리로만 들어온 기기: hello 0', () => {
    const r = sat();
    saveSeat({ roomCode: 'ABCDEF', seatNo: 1, seatPin: '0420' });
    r.c.resumeSaved();
    r.socks[0].onopen?.({});
    r.socks[0].msg({ t: 'welcome', seat: 1, pin: '0420' });
    r.socks[0].msg(st([0, 3, null, null]));
    expect(r.c.state.seat).toBe(1);
    expect(r.back([0, null, null, null]).sent).toEqual([REJOIN]);
    r.c.close();
  });

  it('P7E10 캐릭터를 골랐지만 못 앉고 자리 번호로 앉은 기기(rejoin 의 welcome): 그 캐릭터를 기억하지 않는다', () => {
    const r = sat();
    r.c.open('ABCDEF');
    const s = r.socks[0];
    s.onopen?.({});
    s.msg(st([0, 1, null, null]));
    r.c.join(3);
    s.msg({ t: 'error', code: 'started' });
    r.c.claim(1, '0420');
    s.msg({ t: 'welcome', seat: 1, pin: '0420' });
    expect(hellos(r.back([0, null, null, null]))).toEqual([]);
    r.c.close();
  });

  it('P7E10 앉은 뒤 rejoin 으로 받은 welcome 은 기억을 지우지 않는다', () => {
    const r = sat();
    r.join();
    const s = r.again([0, 3, null, null]);
    s.msg({ t: 'welcome', seat: 1, pin: '0420' });
    expect(r.back([0, null, null, null]).sent).toEqual([REJOIN, HELLO]);
    r.c.close();
  });

  for (const code of ['full', 'started', null] as const) it(`P7E10 보낸 hello 가 ${code ?? '답이 없음'}: 다시 붙어도 두 번째 hello 0, 고르기 단추는 살아 있다`, () => {
    const r = sat();
    r.join();
    const s = r.back([0, null, null, null]);
    if (code) s.msg({ t: 'error', code });
    vi.advanceTimersByTime(60_000);
    s.msg({ t: 'error', code: 'pin' });
    expect(hellos(s)).toEqual([HELLO]);
    expect(r.c.state.error).not.toBeNull(); // Lobby: 고른 적 있는 기기의 단추는 error 가 있어야 눌린다
    const t = r.back([0, null, null, null]);
    expect(t.sent).toEqual([]);
    expect(r.c.state.error).not.toBeNull();
    r.c.join(4); // 손으로는 다시 고를 수 있다
    expect(hellos(t)).toEqual([{ t: 'hello', charId: 4 }]);
    r.c.close();
  });

  for (const [name, go] of [['home', (c) => c.home()], ['leave', (c) => c.leave()], ['finish', (c) => c.leaveGame()]] as [string, (c: GameClient) => void][]) it(`P7E10 ${name} 뒤 새 방에서는 기억 0`, () => {
    const r = sat();
    r.join();
    go(r.c);
    saveSeat({ roomCode: 'ABCDEF', seatNo: 1, seatPin: '0420' });
    r.c.open('ABCDEF');
    const s = r.socks.at(-1)!;
    s.onopen?.({});
    s.msg({ t: 'welcome', seat: 1, pin: '0420' });
    s.msg(st([0, 3, null, null]));
    expect(hellos(r.back([0, null, null, null]))).toEqual([]);
    r.c.close();
  });

  it('P7E10 대기실에서 끊긴 사이 시작된 판(증분 state 만 옴): 옛 대기실을 보고 hello 를 보내지 않는다', () => {
    const r = sat();
    r.join();
    r.socks[0].onclose?.({});
    vi.advanceTimersByTime(10_000);
    const s = r.socks.at(-1)!;
    s.onopen?.({});
    s.msg({ ...st([0, null, null, null], 'playing'), logFrom: 5 });
    s.msg({ t: 'error', code: 'pin' });
    expect(hellos(s)).toEqual([]);
    r.c.close();
  });

  it('P7E10 ws 빌드도 같다', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_TW_NET', 'ws');
    vi.stubGlobal('location', { protocol: 'http:', host: 'x' });
    const ws = await import('../client');
    await import('../../net/ws');
    const r = sat(ws.GameClient as unknown as typeof GameClient);
    r.c.open('ABCDEF');
    await vi.advanceTimersByTimeAsync(0);
    const s0 = r.socks[0];
    s0.onopen?.({});
    s0.msg(st([0, null, null, null]));
    r.c.join(3);
    s0.msg({ t: 'welcome', seat: 1, pin: '0420' });
    s0.onclose?.({});
    await vi.advanceTimersByTimeAsync(10_000);
    const s = r.socks.at(-1)!;
    s.onopen?.({});
    s.msg(st([0, null, null, null]));
    s.msg({ t: 'error', code: 'pin' });
    expect(s.sent).toEqual([REJOIN, HELLO]);
    r.c.close();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
