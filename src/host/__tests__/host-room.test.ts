// 방장 기기 방: 만들기·끝내기·직결 연결(PRD §9.4·§9.5)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withDice } from '../../engine/__tests__/helpers';
import { CODE_RE, type ServerMsg } from '../../shared/protocol';
import { RoomSocket } from '../../net/socket';
import { SETTINGS } from '../../../worker/__tests__/fakes';
import { createHostRoom } from '../host-room';
import { hostKey } from '../storage';
import { Direct, Remote, fakeClock, fakeDeps, flush, freeze, newHost, reopen, started, tick } from './helpers';

beforeEach(fakeClock);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('끝내기', () => {
  it('P1E14 방장 end: 전 연결 ended → 4001, 키 전부 삭제, 알람·심박 정지, 잠금 해제. 끝난 뒤 메시지·새 연결은 1008', async () => {
    const { host, deps, store, code, direct, remotes } = await started(2);
    await tick(5_000);
    expect(store.keys(code).length).toBeGreaterThan(2);
    const order: string[] = [];
    vi.spyOn(remotes[0], 'send').mockImplementation((s) => { order.push(JSON.parse(s).t); });
    vi.spyOn(remotes[0], 'close').mockImplementation((c) => { order.push(String(c)); });
    await direct.say({ t: 'end' });
    expect(order).toEqual(['ended', '4001']);
    expect(remotes[1].last('ended')).toEqual({ t: 'ended', by: 'host' });
    expect(remotes[1].closes).toEqual([4001]);
    expect(direct.sent.at(-1)).toEqual({ t: 'ended', by: 'host' });
    expect(direct.closes).toEqual([4001]);
    expect(store.keys(code)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    await flush();
    expect(deps.locks!.held.size).toBe(0);
    remotes[1].say({ t: 'sync' });
    expect(remotes[1].closes).toEqual([4001, 1008]);
    remotes[1].port.closed();
    expect(new Remote(host).closes).toEqual([1008]);
    expect(await reopen(code, deps)).toBe('none');
    expect(store.keys(code)).toEqual([]);
  });

  it('P1E14 원격이 끊기면 그 자리만 끊김, 닫은 연결의 늦은 메시지는 버린다', async () => {
    const { host, remotes } = await started(2);
    remotes[0].port.closed();
    expect(host.room.rec!.seats.map((s) => s.connected)).toEqual([true, false, true, false]);
    remotes[0].say({ t: 'leave' });
    expect(host.room.game!.seats[1].isBot).toBe(false);
    remotes[1].say({ t: 'leave' });
    expect(remotes[1].closes).toEqual([4002]);
    expect(host.room.game!.seats[2].isBot).toBe(true);
    const n = remotes[1].sent.length;
    remotes[1].say({ t: 'hello', charId: 0 });
    remotes[1].port.closed(); // 방장이 닫은 뒤 실제 끊김
    await tick(60_000); // 닫은 연결엔 방송도 안 간다
    expect(remotes[1].sent.length).toBe(n);
  });
});

describe('P1bE15 방어', () => {
  it('P1bE15 알람이 30일 뒤면 setTimeout 지연을 2^31-1 로 자르고 되풀이해 걸지 않는다', async () => {
    const { host } = await newHost();
    const set = vi.spyOn(globalThis, 'setTimeout');
    vi.setSystemTime(Date.now() - 16 * 86_400_000); // 기기 시계가 뒤로 보정
    new Remote(host);
    await tick(60_000);
    const delays = set.mock.calls.map((c) => c[1]!);
    set.mockRestore();
    expect(delays.length).toBe(1);
    expect(delays[0]).toBe(2 ** 31 - 1);
    expect(host.room.rec).not.toBeNull();
  });

  it('P1bE15 원격 send 가 던져도 HostPort.message 밖으로 새지 않고 alive 가 갱신된다', async () => {
    const { host } = await started(1);
    const bad = new Remote(host);
    vi.spyOn(bad, 'send').mockImplementation(() => { throw new Error('not open'); });
    freeze(4_000);
    expect(() => bad.say({ t: 'rejoin', seat: 0, pin: '0000' })).not.toThrow();
    freeze(4_000); // 위에서 alive 가 갱신됐으므로 아직 자리 비움이 아니다
    expect(() => bad.say({ t: 'sync' })).not.toThrow();
    expect(host.room.game!.phase).toBe('playing');
  });

  it('P1bE15 만들다 예외가 나면 잠금·타이머를 남기지 않는다', async () => {
    const deps = fakeDeps();
    vi.mocked(crypto.getRandomValues).mockImplementationOnce(() => { throw new Error('x'); });
    await expect(createHostRoom(SETTINGS, deps as never, () => 'AAAAAA')).rejects.toThrow();
    await flush();
    expect(deps.locks!.held.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect((await createHostRoom(SETTINGS, deps as never, () => 'AAAAAA'))!.code).toBe('AAAAAA');
  });
});

describe('직결 연결', () => {
  it('P1E15 방장 화면이 받는 state 에도 문항 단계 answer·cardId·cards 없음, 해설부터 있음', async () => {
    const { host, direct } = await started(1);
    host.room.game = withDice(host.room.game!, 1, 1);
    await direct.say({ t: 'act', a: { type: 'roll' } });
    await tick(host.room.rec!.deadlineAt! - Date.now());
    await direct.say({ t: 'act', a: { type: 'answer', choice: 1, ms: 1_000 } });
    await tick(20_000);
    const at = (st: string) => direct.of('state').filter((m) => m.game?.turn.step === st);
    expect(at('question').length).toBeGreaterThanOrEqual(1);
    for (const m of at('question')) {
      const q = m.game!.turn.question!;
      expect('cardId' in q).toBe(false);
      expect('answer' in q).toBe(false);
      expect(m.cards).toEqual([]);
    }
    expect(at('explanation').length).toBeGreaterThan(0);
    for (const m of at('explanation')) expect(m.cards.map((c) => c.id)).toEqual([m.game!.turn.question!.cardId]);
    for (const m of direct.of('state')) for (const e of m.log) if (e.ev === 'question') expect(e.mTags).toEqual([]);
    for (const m of at('tf')) expect(m.game!.turn.tf).toEqual({ stmtId: expect.any(String) });
    expect(direct.of('state').some((m) => m.game && ('rngSeed' in m.game || 'rngState' in m.game))).toBe(false);
  });

  it('직결은 RoomSocket 에 그대로 꽂힌다: 열림 → greet → 자리, 다시 부르기는 처리가 끝난 뒤(되부름 없음)', async () => {
    const { host } = await newHost();
    const got: ServerMsg[] = [];
    const status: string[] = [];
    let inRun = false;
    const run = host.room.webSocketMessage.bind(host.room);
    vi.spyOn(host.room, 'webSocketMessage').mockImplementation((ws, raw) => { expect(inRun).toBe(false); inRun = true; run(ws, raw); inRun = false; });
    const sock: RoomSocket = new RoomSocket({
      url: '', make: () => host.loopback(), greet: () => ({ t: 'hello', charId: 3 }),
      onStatus: (s) => status.push(s), onMsg: (m) => { got.push(m); if (m.t === 'welcome') sock.send({ t: 'sync' }); },
    });
    await flush();
    expect(status).toEqual(['connecting', 'open']);
    expect(got.map((m) => m.t)).toEqual(['state', 'welcome', 'state', 'state', 'state']); // 열림 · 입장 방송·전체 · sync 답
    expect(host.room.rec!.seats[0]).toMatchObject({ claimed: true, charId: 3, connected: true });
    sock.close();
    await flush();
    expect(host.room.rec!.seats[0].connected).toBe(false);
  });
});

describe('방 만들기', () => {
  it('P1E16 코드는 crypto 로 뽑고 CODE_RE 통과, 저장 객체에 자유 문자열 0(S10)', async () => {
    const rnd = vi.spyOn(Math, 'random');
    const { store, code, host, direct } = await started(1);
    expect(code).toMatch(CODE_RE);
    expect(host.room.rec!.code).toBe(code);
    expect(vi.mocked(crypto.getRandomValues)).toHaveBeenCalled();
    expect(rnd).not.toHaveBeenCalled();
    await direct.say({ t: 'act', a: { type: 'roll' } });
    for (let i = 0; i < 20; i++) await tick(30_000);
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    for (const k of store.keys(code)) walk(JSON.parse(store.data.get(k)!));
    expect(strings.length).toBeGreaterThan(100);
    expect([...new Set(strings)].filter((s) => !/^[A-Za-z0-9_.|-]{0,40}$/.test(s))).toEqual([]);
  });

  it('P1E16 이 기기에 같은 코드의 방이 있거나 다른 탭이 쥔 코드면 다시 뽑는다. 다섯 번 다 겹치면 null', async () => {
    const deps = fakeDeps();
    deps.store.data.set(hostKey('AAAAAA', 'room'), 'x');
    deps.locks!.held.add('tw.host.BBBBBB');
    const seq = ['AAAAAA', 'BBBBBB', 'CCCCCC'];
    const host = (await createHostRoom(SETTINGS, deps as never, () => seq.shift()!))!;
    expect(host.code).toBe('CCCCCC');
    expect(deps.store.data.get(hostKey('AAAAAA', 'room'))).toBe('x');
    let tries = 0;
    expect(await createHostRoom(SETTINGS, deps as never, () => { tries++; return 'AAAAAA'; })).toBeNull();
    expect(tries).toBe(5);
    expect([...deps.locks!.held].sort()).toEqual(['tw.host.BBBBBB', 'tw.host.CCCCCC']);
  });

  it('만들자마자 새로고침해도 방이 있다(첫 room·alive 가 바로 쓰인다)', async () => {
    const { host, deps, store, code } = await newHost();
    expect(store.keys(code)).toEqual([hostKey(code, 'alive'), hostKey(code, 'room')]);
    host.close();
    expect(typeof await reopen(code, deps)).toBe('object');
  });

  it('원격 연결은 방장 자리 밖에 아무도 못 앉은 방을 시작·끝낼 수 없다', async () => {
    const { host, direct, remotes } = await started(1);
    for (const t of ['pause', 'end']) { remotes[0].say({ t }); expect(remotes[0].last('error')!.code).toBe('notHost'); }
    expect(host.room.rec).not.toBeNull();
    expect(direct.closes).toEqual([]);
  });
});
