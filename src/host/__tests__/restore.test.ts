// 저장된 방을 다시 열 때(PRD §3.7 확정 넷, §9.5 '방을 다시 열 때'): 멈춘 판 → 사람 자리 전부 끊김 → 알람
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPIRE_MS, OFFLINE_BOT_MS, type RoomRec } from '../../../worker/room';
import { hostKey, sweepRooms } from '../storage';
import { Direct, Remote, atQuestion, fakeClock, fakeDeps, freeze, mustOpen, newHost, quotaError, reopen, started, tick, type FakeStore } from './helpers';
import type { HostRoom } from '../host-room';

beforeEach(fakeClock);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const saved = (store: FakeStore, code: string) => JSON.parse(store.data.get(hostKey(code, 'room'))!) as RoomRec;
const connected = (r: RoomRec) => r.seats.map((s) => s.connected);
const times = (r: RoomRec) => [r.deadlineAt, r.stepAt, r.showUntil, r.botAt, r.lastCut];

/** 새 탭에서 다시 열고 방장이 자리 0 으로 */
async function back(code: string, deps: ReturnType<typeof fakeDeps>) {
  const host = await mustOpen(code, deps);
  const direct = new Direct(host);
  await direct.say({ t: 'rejoin', ...host.hostRejoin()! });
  return { host, direct };
}
function rejoin(host: HostRoom, seat: 1 | 2 | 3) {
  const r = new Remote(host);
  r.say({ t: 'rejoin', seat, pin: host.room.rec!.seats[seat].pin });
  return r;
}

describe('사람 자리 끊김 처리', () => {
  it('P1bE01 복원 직후 전원 끊김. 돌아오지 않은 자리는 resume 30초 뒤 봇, 그 PIN 으로 복귀된다', async () => {
    const s = await atQuestion(2);
    s.host.close();
    freeze(600_000);
    const again = await mustOpen(s.code, s.deps);
    expect(again.room.game!.phase).toBe('paused');
    expect(connected(again.room.rec!)).toEqual([false, false, false, false]);
    expect(again.room.rec!.seats.slice(0, 3).map((x) => x.lastSeen)).toEqual(Array(3).fill(Date.now()));
    expect(again.room.game!.seats.map((x) => x.connected)).toEqual([false, false, false, true]);
    expect(connected(saved(s.store, s.code))).toEqual([false, false, false, false]);
    const direct = new Direct(again);
    await direct.say({ t: 'rejoin', ...again.hostRejoin()! });
    rejoin(again, 1);
    expect(connected(again.room.rec!)).toEqual([true, true, false, false]);
    await tick(20_000);
    await direct.say({ t: 'resume' });
    expect(Math.abs(again.room.rec!.seats[2].offSince! - Date.now())).toBeLessThanOrEqual(50);
    await tick(OFFLINE_BOT_MS - 100);
    expect(again.room.game!.seats[2].isBot).toBe(false);
    await tick(200);
    expect(again.room.game!.seats.map((x) => x.isBot)).toEqual([false, false, true, true]);
    expect(again.room.rec!.seats[2].claimed).toBe(true);
    expect(rejoin(again, 2).last('welcome')!.seat).toBe(2);
    expect(again.room.rec!.seats[2].connected).toBe(true);
  });

  it('P1bE01 30초 안에 돌아오면 봇이 되지 않는다', async () => {
    const s = await atQuestion(2);
    s.host.close();
    freeze(600_000);
    const { host, direct } = await back(s.code, s.deps);
    rejoin(host, 1);
    await direct.say({ t: 'resume' });
    await tick(20_000);
    rejoin(host, 2);
    await tick(40_000);
    expect(host.room.game!.seats.map((x) => x.isBot)).toEqual([false, false, false, true]);
  });

  it('P1bE02 해설 단계: 돌아오지 않은 자리의 shown 을 기다리지 않는다', async () => {
    const s = await atQuestion(2);
    await s.direct.say({ t: 'act', a: { type: 'answer', choice: 0, ms: 1_000 } });
    expect(s.host.room.game!.turn.step).toBe('explanation');
    const closed = Date.now();
    s.host.close();
    freeze(600_000);
    const { host, direct } = await back(s.code, s.deps);
    const kid = rejoin(host, 1);
    await direct.say({ t: 'resume' });
    const left = host.room.rec!.deadlineAt! - Date.now();
    expect(Math.abs(left - (s.host.room.rec!.deadlineAt! - closed))).toBeLessThanOrEqual(1_200);
    await tick(left - 500);
    await direct.say({ t: 'shown', stepKey: host.room.rec!.stepKey });
    kid.say({ t: 'shown', stepKey: host.room.rec!.stepKey });
    expect(host.room.rec!.shown).toEqual([0, 1]);
    await tick(499);
    expect(host.room.game!.turn.step).toBe('explanation');
    await tick(1);
    expect(host.room.rec!.shownWait).toBe(false);
    expect(host.room.game!.turn.step).toBe('tf');
  });

  it('P1bE03 남은 12초에 새로고침, 3초 뒤 다시 엶: 5초 아래여도 멈춘 판 + 끊김 처리', async () => {
    const s = await atQuestion(1);
    await tick(s.host.room.rec!.deadlineAt! - Date.now() - 12_000);
    await s.direct.say({ t: 'sync' });
    const at = Date.now();
    const before = times(s.host.room.rec!);
    const left = s.host.room.game!.clock.remainingMs;
    const log = [...s.host.room.game!.log];
    s.host.close();
    freeze(3_000);
    const again = await mustOpen(s.code, s.deps);
    const g = again.room.game!;
    expect(g.phase).toBe('paused');
    expect(Math.abs(g.clock.pausedAt! - at)).toBeLessThanOrEqual(1_200);
    expect(left - g.clock.remainingMs).toBeLessThanOrEqual(1_200);
    expect(times(again.room.rec!)).toEqual(before);
    expect(g.log.slice(0, -1)).toEqual(log);
    expect(g.log.at(-1)).toMatchObject({ ev: 'clock', kind: 'pause', by: 'auto' });
    expect(connected(again.room.rec!)).toEqual([false, false, false, false]);
    const direct = new Direct(again);
    await direct.say({ t: 'rejoin', ...again.hostRejoin()! });
    await direct.say({ t: 'resume' });
    expect(again.room.game!.turn.step).toBe('question');
    expect(Math.abs(again.room.rec!.deadlineAt! - Date.now() - 12_000)).toBeLessThanOrEqual(1_500);
  });

  it('P1bE04 꺼져 있던 10분 + 사람 셋: 끊김 처리가 시계·마감·봇·컷씬을 건드리지 않고 로그는 clock pause 하나', async () => {
    const s = await started(2);
    s.host.room.game = { ...s.host.room.game!, log: [...s.host.room.game!.log, { ev: 'build', seat: 0, tile: 2, level: 4, cost: 0 }] };
    await s.direct.say({ t: 'sync' });
    while (!(s.host.room.game!.turn.seat === 3 && s.host.room.rec!.botAt! > Date.now() + 1_000)) await tick(250);
    await s.direct.say({ t: 'sync' });
    const before = times(s.host.room.rec!);
    expect(before[3]).not.toBeNull();
    expect(before[4]).not.toBeNull();
    const left = s.host.room.game!.clock.remainingMs;
    const log = [...s.host.room.game!.log];
    s.host.close();
    freeze(600_000);
    const again = await mustOpen(s.code, s.deps);
    expect(left - again.room.game!.clock.remainingMs).toBeLessThanOrEqual(1_200);
    expect(times(again.room.rec!)).toEqual(before);
    expect(again.room.game!.log.length).toBe(log.length + 1);
    await tick(120_000);
    expect(again.room.game!.log.length).toBe(log.length + 1);
    expect(left - again.room.game!.clock.remainingMs).toBeLessThanOrEqual(1_200);
    expect(again.room.game!.seats.map((x) => x.isBot)).toEqual([false, false, false, true]);
  });
});

it('P1bE07 살아 있는 탭이 늦은 경우엔 멈추든 안 멈추든 사람 자리를 끊김으로 두지 않는다', async () => {
  const { host, store, code } = await atQuestion(2);
  for (const [late, phase] of [[4_000, 'playing'], [8_000, 'paused']] as const) {
    freeze(late);
    await tick(1_000);
    expect(host.room.game!.phase).toBe(phase);
    expect(connected(host.room.rec!)).toEqual([true, true, true, false]);
    expect(connected(saved(store, code))).toEqual([true, true, true, false]);
    expect(host.room.rec!.seats.map((s) => s.offSince)).toEqual([null, null, null, null]);
    expect(host.room.game!.seats.map((s) => s.connected)).toEqual([true, true, true, true]);
  }
});

describe('P1bE05 진행 중이 아닌 방', () => {
  it('P1bE05 대기실: 끊김만. 방장만 돌아와 출발하면 나머지는 30초 뒤 봇', async () => {
    const { host, deps, code } = await newHost();
    await new Direct(host).say({ t: 'hello', charId: 0 });
    new Remote(host).say({ t: 'hello', charId: 1 });
    host.close();
    freeze(60_000);
    const b = await mustOpen(code, deps);
    expect(b.room.game).toBeNull();
    expect(connected(b.room.rec!)).toEqual([false, false, false, false]);
    expect(b.room.rec!.seats.map((s) => s.offSince)).toEqual([null, null, null, null]);
    const direct = new Direct(b);
    await direct.say({ t: 'rejoin', ...b.hostRejoin()! });
    await direct.say({ t: 'start' });
    expect(b.room.rec!.seats[1].offSince).toBe(Date.now());
    await tick(OFFLINE_BOT_MS - 100);
    expect(b.room.game!.seats[1].isBot).toBe(false);
    await tick(200);
    expect(b.room.game!.seats[1].isBot).toBe(true);
  });

  it('P1bE05 멈춰 둔 판: pausedAt·로그 그대로, resume 때부터 30초', async () => {
    const s = await started(1);
    await s.direct.say({ t: 'pause' });
    const { pausedAt } = s.host.room.game!.clock;
    const len = s.host.room.game!.log.length;
    s.host.close();
    freeze(600_000);
    const { host, direct } = await back(s.code, s.deps);
    expect(host.room.game!.clock.pausedAt).toBe(pausedAt);
    expect(host.room.game!.log.length).toBe(len);
    expect(connected(host.room.rec!)).toEqual([true, false, false, false]);
    await direct.say({ t: 'resume' });
    await tick(OFFLINE_BOT_MS - 100);
    expect(host.room.game!.seats[1].isBot).toBe(false);
    await tick(200);
    expect(host.room.game!.seats[1].isBot).toBe(true);
  });

  it('P1bE05 끝난 판: 로그·phase 그대로, 봇 대체 0', async () => {
    const s = await started(1);
    s.host.room.game = { ...s.host.room.game!, clock: { remainingMs: 1, pausedAt: null } };
    await tick(1_000);
    await s.direct.say({ t: 'sync' });
    expect(s.host.room.game!.phase).toBe('finished');
    const len = s.host.room.game!.log.length;
    s.host.close();
    freeze(600_000);
    const again = await mustOpen(s.code, s.deps);
    await tick(120_000);
    expect(again.room.game!.phase).toBe('finished');
    expect(again.room.game!.log.length).toBe(len);
    expect(connected(again.room.rec!)).toEqual([false, false, false, false]);
    expect(again.room.game!.seats.map((x) => x.isBot)).toEqual([false, false, true, true]);
  });
});

describe('P1bE06 섞인 자리', () => {
  it('P1bE06 저장이 멈춘 판: 끊김 처리가 새 저장(ok)에 들어간다', async () => {
    const s = await atQuestion(1);
    s.store.fail = (k) => (k.includes('.log:') ? quotaError() : null);
    await s.direct.say({ t: 'act', a: { type: 'answer', choice: 0, ms: 1_000 } });
    expect(s.host.storage.status).toBe('stopped');
    await tick(60_000);
    s.host.close();
    s.store.fail = () => null;
    const again = await mustOpen(s.code, s.deps);
    expect(again.storage.status).toBe('ok');
    expect(again.room.game!.turn.step).toBe('question');
    expect(connected(saved(s.store, s.code))).toEqual([false, false, false, false]);
  });

  it('P1bE06 시작부터 봇인 자리는 그대로, 끊김 대체 봇은 connected false·offSince null·정답률 그대로', async () => {
    const s = await started(1);
    s.remotes[0].say({ t: 'leave' });
    expect(s.host.room.game!.seats[1].isBot).toBe(true);
    const { botAccuracy, seats } = JSON.parse(JSON.stringify(s.host.room.rec)) as RoomRec;
    s.host.close();
    freeze(600_000);
    const again = await mustOpen(s.code, s.deps);
    expect(again.room.rec!.seats[1]).toMatchObject({ claimed: true, connected: false, offSince: null, returning: false });
    expect(again.room.game!.seats[1].isBot).toBe(true);
    expect(again.room.rec!.seats.slice(2)).toEqual(seats.slice(2));
    expect(again.room.rec!.botAccuracy).toEqual(botAccuracy);
  });
});

describe('P1bE10 로그 조각이 깨진 방', () => {
  for (const [tag, bad] of [['잘린 문자열', '[{"ev":"dice","se'], ['배열이 아님', 'null']] as const) {
    it(`P1bE10 ${tag}: broken, 잠금·타이머를 남기지 않고 저장본 그대로`, async () => {
      const s = await atQuestion(1);
      s.host.close();
      const k = hostKey(s.code, 'log:000001');
      expect(s.store.data.has(k)).toBe(true);
      s.store.data.set(k, bad);
      const before = [...s.store.data];
      const n = s.store.touched(s.code);
      for (let i = 0; i < 2; i++) expect(await reopen(s.code, s.deps)).toBe('broken');
      expect(vi.getTimerCount()).toBe(0);
      await tick(5_000);
      expect([...s.store.data]).toEqual(before);
      expect(s.store.touched(s.code)).toBe(n);
      sweepRooms(s.store as never);
      expect([...s.store.data]).toEqual(before);
      freeze(EXPIRE_MS + 1);
      sweepRooms(s.store as never);
      expect(s.store.keys(s.code)).toEqual([]);
    });
  }
});
