// 방장 탭이 멈췄다 다시 돎·새로고침(PRD §3.7 방장 기기 자리 비움, S16)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { T0 } from '../../../worker/__tests__/fakes';
import { hostKey } from '../storage';
import { Direct, Remote, atQuestion, fakeClock, freeze, mustOpen, started, tick } from './helpers';

beforeEach(fakeClock);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const times = (r: { deadlineAt: number | null; stepAt: number; showUntil?: number; botAt: number | null; lastCut: { at: number } | null }) =>
  [r.deadlineAt, r.stepAt, r.showUntil, r.botAt, r.lastCut?.at];

describe('탭이 멈췄다 다시 돎', () => {
  it('P1E01 문항 남은 12초에 8초 멈춤 → alive 에 멈춘 판, 시계 감소 ≤ 1.2초, 재개 뒤 남은 마감 12초', async () => {
    const { host, direct, remotes } = await atQuestion(1);
    await tick(host.room.rec!.deadlineAt! - Date.now() - 12_000);
    const at = Date.now();
    const before = times(host.room.rec!);
    await direct.say({ t: 'sync' }); // 멈추기 직전 시계(tick 은 처리 때만 돈다)
    const left = host.room.game!.clock.remainingMs;
    freeze(8_000);
    await tick(1_000);
    expect(host.room.game!.phase).toBe('paused');
    expect(Math.abs(host.room.game!.clock.pausedAt! - at)).toBeLessThanOrEqual(1_200);
    expect(left - host.room.game!.clock.remainingMs).toBeLessThanOrEqual(1_200);
    expect(left - host.room.game!.clock.remainingMs).toBeGreaterThanOrEqual(0);
    expect(times(host.room.rec!)).toEqual(before);
    expect(host.room.game!.log.at(-1)).toMatchObject({ ev: 'clock', kind: 'pause', by: 'auto' });
    expect(remotes[0].last('state')!.phase).toBe('paused');
    await tick(30_000); // 멈춘 채로는 아무것도 안 흐른다
    expect(host.room.game!.turn.step).toBe('question');
    await direct.say({ t: 'resume' });
    expect(host.room.game!.phase).toBe('playing');
    expect(Math.abs(host.room.rec!.deadlineAt! - Date.now() - 12_000)).toBeLessThanOrEqual(1_500);
  });

  it('P1E01 깨어나자마자 타이머보다 먼저 온 원격 메시지도 멈춘 판에서 처리한다', async () => {
    const { host, remotes } = await atQuestion(1);
    freeze(60_000); // 문항 마감도 봇 시각도 다 지났다
    remotes[0].say({ t: 'sync' });
    expect(host.room.game!.phase).toBe('paused');
    expect(host.room.game!.turn.step).toBe('question');
    freeze(60_000); // 멈춘 판: 새 연결이 와도 그대로
    new Remote(host);
    expect(host.room.game!.turn.step).toBe('question');
  });

  it('P1E03 5초 이하로 늦은 알람은 그냥 흐른 시간', async () => {
    const { host, direct } = await atQuestion();
    await tick(1_000 - (Date.now() - T0) % 1_000); // 심박 시각에 맞춘다
    await direct.say({ t: 'sync' });
    const left = host.room.game!.clock.remainingMs;
    const len = host.room.game!.log.length;
    for (let i = 0; i < 3; i++) { // 심박 직후 멈춤 → 다음 타이머까지 딱 5초
      freeze(4_000);
      await tick(1_000);
      expect(host.room.game!.phase).toBe('playing');
    }
    await direct.say({ t: 'sync' });
    expect(left - host.room.game!.clock.remainingMs).toBe(15_000);
    expect(host.room.game!.log.length).toBe(len);
    freeze(4_001);
    await tick(1_000);
    expect(host.room.game!.phase).toBe('paused'); // 5.001초
  });

  it('P1E03 백그라운드(1초 간격 타이머): 늦은 알람은 심박이 다시 확인해 울린다', async () => {
    const { host } = await atQuestion();
    const dl = host.room.rec!.deadlineAt!;
    for (let i = 0; i < 25; i++) { freeze(500); await tick(1_000); } // 타이머마다 0.5초씩 늦는다
    expect(Date.now()).toBeGreaterThan(dl);
    expect(host.room.game!.phase).toBe('playing');
    expect(host.room.game!.turn.step).not.toBe('question');
  });
});

describe('방장 새로고침', () => {
  it('P1E02 꺼져 있던 10분이 시계·마감·봇·컷씬에 들어가지 않는다. 로그는 clock pause 하나만 는다', async () => {
    const { host, deps, store, code, direct } = await started();
    await direct.say({ t: 'act', a: { type: 'roll' } });
    while (!(host.room.game!.turn.seat !== 0 && host.room.rec!.botAt! > Date.now() + 1_000)) await tick(250);
    const at = Date.now();
    const before = times(host.room.rec!);
    const { lastTickAt } = host.room.rec!;
    const left = host.room.game!.clock.remainingMs - (at - lastTickAt!);
    const log = [...host.room.game!.log];
    const turn = structuredClone(host.room.game!.turn);
    host.close();
    freeze(600_000);
    const again = await mustOpen(code, deps);
    const g = again.room.game!;
    expect(g.phase).toBe('paused');
    expect(Math.abs(g.clock.pausedAt! - at)).toBeLessThanOrEqual(1_200);
    expect(Math.abs(g.clock.remainingMs - left)).toBeLessThanOrEqual(1_200);
    expect(times(again.room.rec!)).toEqual(before);
    expect(g.turn).toEqual(turn);
    expect(g.log.slice(0, -1)).toEqual(log);
    expect(g.log.at(-1)).toEqual({ ev: 'clock', kind: 'pause', remainingMs: g.clock.remainingMs, by: 'auto' });
    await tick(120_000); // 멈춘 동안 봇 행동 0
    expect(again.room.game!.log.length).toBe(log.length + 1);
    expect(JSON.parse(store.data.get(hostKey(code, 'room'))!).game.phase).toBe('paused'); // 저장까지
    const d = new Direct(again);
    await d.say({ t: 'rejoin', ...again.hostRejoin()! });
    expect(d.last('welcome')).toMatchObject({ seat: 0 });
    await d.say({ t: 'resume' });
    expect(Math.abs(again.room.rec!.botAt! - Date.now() - (before[3]! - at))).toBeLessThanOrEqual(1_200);
  });

  it('P1E02 5초 안에 새로고침해도 멈춘 판으로 열리고, 재개하면 남은 마감 그대로 알람도 다시 걸린다', async () => {
    const { host, deps, code } = await atQuestion();
    const left = host.room.rec!.deadlineAt! - Date.now();
    const clock = host.room.game!.clock.remainingMs;
    host.close();
    freeze(3_000);
    const again = await mustOpen(code, deps);
    expect(again.room.game!.phase).toBe('paused');
    expect(clock - again.room.game!.clock.remainingMs).toBeLessThanOrEqual(1_200);
    const d = new Direct(again);
    await d.say({ t: 'rejoin', ...again.hostRejoin()! });
    await d.say({ t: 'resume' });
    expect(Math.abs(again.room.rec!.deadlineAt! - Date.now() - left)).toBeLessThanOrEqual(1_500);
    await tick(again.room.rec!.deadlineAt! - Date.now() + 10);
    expect(again.room.game!.turn.step).not.toBe('question');
  });

  it('P1E02 마지막 처리가 마지막 alive 기록보다 늦으면 그 처리 시각에 멈춘다(시계·단계 시각이 거꾸로 가지 않게)', async () => {
    const { host, deps, code, direct } = await atQuestion();
    await tick(400);
    await direct.say({ t: 'act', a: { type: 'answer', choice: 0, ms: 100 } });
    const at = Date.now();
    expect(host.room.rec!.stepAt).toBe(at);
    host.close();
    freeze(600_000);
    const again = await mustOpen(code, deps);
    expect(again.room.game!.clock.pausedAt).toBe(at);
  });

  it('P1E02 대기실은 새로고침해도 그대로', async () => {
    const { host, deps, code } = await started(0);
    const lobby = JSON.parse(deps.store.data.get(hostKey(code, 'room'))!);
    host.close();
    deps.store.data.set(hostKey(code, 'room'), JSON.stringify({ ...lobby, game: null, logChunks: 0, logLen: 0, logBytes: 0 }));
    freeze(600_000);
    const again = await mustOpen(code, deps);
    expect(again.room.rec!.seats[0].claimed).toBe(true);
    expect(again.room.game).toBeNull();
  });
});
