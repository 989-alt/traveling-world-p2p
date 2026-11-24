// 방장 기기 자리 비움(PRD §3.7 2026-11-24 P2P): Room.stall(from) — 진행 중인 판을 시각 from 에 자동 멈춤으로.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDice } from '../../src/engine/__tests__/helpers';
import type { Room } from '../room';
import { SHOWN_WAIT_MS } from '../room';
import { advance, connect, game, join, runUntil, say, setup, untilDeadline, type FakeCtx, type FakeWS } from './fakes';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const ack = (room: Room, ws: FakeWS[]) => { for (const w of ws) say(room, w, { t: 'shown', stepKey: room.rec!.stepKey }); };
const lastEx = (room: Room) => {
  const e = game(room).log.filter((x) => x.ev === 'explanation').at(-1);
  return e?.ev === 'explanation' ? e : undefined;
};
const stored = (ctx: FakeCtx) => JSON.parse(ctx.data.get('room') as string);

/** 0번 자리가 타이(2) 첫 방문 → 문항 */
async function atQuestion(n = 4) {
  const { ctx, room } = setup();
  const ws = join(room, ctx, n);
  say(room, ws[0], { t: 'start' });
  room.game = withDice(game(room), 1, 1);
  say(room, ws[0], { t: 'act', a: { type: 'roll' } });
  await advance(room, ctx, untilDeadline(room));
  expect(game(room).turn).toMatchObject({ seat: 0, step: 'question' });
  return { ctx, room, ws };
}

async function atExplanation() {
  const s = await atQuestion();
  say(s.room, s.ws[0], { t: 'act', a: { type: 'answer', choice: 0, ms: 1000 } });
  expect(game(s.room).turn.step).toBe('explanation');
  return s;
}

describe('stall', () => {
  it('진행 중: 시계는 from 까지만 줄고 pausedAt = from, 단계 시각은 그대로. 저장 → 방송, 자리마다 PIN', async () => {
    const { ctx, room, ws } = await atQuestion();
    const { deadlineAt, stepAt, showUntil, botAt, lastCut } = room.rec!;
    const left = game(room).clock.remainingMs;
    const len = game(room).log.length;
    const from = Date.now() + 3_000;
    vi.setSystemTime(Date.now() + 600_000); // 탭이 멈춰 있던 10분
    const seen: string[] = [];
    vi.spyOn(ws[1], 'send').mockImplementation((s) => { if (JSON.parse(s).t === 'state') seen.push(stored(ctx).game.phase); });
    room.stall(from);
    expect(game(room).phase).toBe('paused');
    expect(game(room).clock).toEqual({ remainingMs: left - 3_000, pausedAt: from });
    expect(room.rec).toMatchObject({ deadlineAt, stepAt, showUntil, botAt, lastCut, lastTickAt: null });
    expect(game(room).log.slice(len)).toEqual([{ ev: 'clock', kind: 'pause', remainingMs: left - 3_000, by: 'auto' }]);
    expect(seen).toEqual(['paused']); // 방송 때는 이미 저장돼 있다
    expect(ws[2].last('state')).toMatchObject({ phase: 'paused', deadlineAt, logFrom: len });
    expect(ws[2].last('pins')!.pins).toEqual([{ seat: 2, pin: room.rec!.seats[2].pin }]);
    expect(ctx.alarmAt).toBe(room.rec!.expiresAt); // 멈춘 판에 남는 알람은 만료뿐
  });

  it('놀이 시계가 from 안에서 끝나고 턴 시작이면 멈춤이 아니라 끝(시계가 정한 일은 그대로)', () => {
    const { ctx, room } = setup();
    const ws = join(room, ctx, 2);
    say(room, ws[0], { t: 'start' });
    room.game = { ...game(room), clock: { remainingMs: 2_000, pausedAt: null } };
    room.stall(Date.now() + 2_500);
    expect(game(room).phase).toBe('finished');
    expect(room.rec!.lastTickAt).toBeNull();
    expect(stored(ctx).game.phase).toBe('finished');
  });

  it('P1E04 대기실·멈춤·끝난 판·연속 두 번: 상태 변화 0, 로그 0, 저장 쓰기 0, pausedAt 그대로', async () => {
    const { ctx, room } = setup();
    const ws = join(room, ctx, 2);
    const still = (f: () => void) => {
      const put = vi.spyOn(ctx.storage.kv, 'put');
      const sent = ws.map((w) => w.sent.length);
      const before = JSON.stringify([room.rec, room.game]);
      f();
      expect(JSON.stringify([room.rec, room.game])).toBe(before);
      expect(put).not.toHaveBeenCalled();
      expect(ws.map((w) => w.sent.length)).toEqual(sent);
      put.mockRestore();
    };
    still(() => room.stall(Date.now() - 1_000)); // 대기실
    say(room, ws[0], { t: 'start' });
    const at = Date.now();
    room.stall(at);
    expect(game(room).clock.pausedAt).toBe(at);
    still(() => room.stall(at + 60_000)); // 연속 두 번
    say(room, ws[0], { t: 'resume' });
    await advance(room, ctx, 1_000);
    say(room, ws[0], { t: 'pause' });
    still(() => room.stall(Date.now() + 60_000)); // 방장이 멈춘 판
    say(room, ws[0], { t: 'resume' });
    await runUntil(room, ctx, () => game(room).phase === 'finished');
    still(() => room.stall(Date.now() + 60_000)); // 끝난 판
    say(room, ws[0], { t: 'end' });
    expect(() => room.stall(Date.now())).not.toThrow(); // 끝낸 방
  });

  it('P1E05 해설 중 stall → 재개: 받은 shown 이 새 단계 키로 남고 남은 표시 시간 그대로(timers.test U14 와 같은 단언)', async () => {
    const { ctx, room, ws } = await atExplanation();
    await advance(room, ctx, 6_000);
    ack(room, ws.slice(0, 2));
    room.stall(Date.now());
    expect(game(room).phase).toBe('paused');
    await advance(room, ctx, 30_000);
    expect(game(room).phase).toBe('paused');
    say(room, ws[0], { t: 'resume' });
    expect(game(room).turn.step).toBe('explanation');
    expect(room.rec!.stepKey).toBe(`${game(room).turn.seat}|explanation|${game(room).log.length}`);
    expect(room.rec!.deadlineAt! - Date.now()).toBe(1_000);
    expect(room.rec!.shown).toEqual([0, 1]);
    expect(room.rec!.shownKey).toBe(room.rec!.stepKey);
    ack(room, ws.slice(2));
    expect(room.rec!.shown).toEqual([0, 1, 2, 3]);
    await advance(room, ctx, 1_000);
    expect(game(room).turn.step).toBe('tf');
    expect(lastEx(room)!.shownTo).toEqual([true, true, true, true]);
  });

  it('P1E05 해설 shown 대기(SHOWN_WAIT_MS) 중 stall: 재개 뒤 남은 대기 그대로(timers.test U14 와 같은 단언)', async () => {
    const { ctx, room, ws } = await atExplanation();
    const t0 = Date.now();
    await advance(room, ctx, 7_000);
    expect(room.rec!.shownWait).toBe(true);
    await advance(room, ctx, 500);
    room.stall(Date.now());
    await advance(room, ctx, 60_000);
    say(room, ws[0], { t: 'resume' });
    expect(room.rec!.deadlineAt! - Date.now()).toBe(SHOWN_WAIT_MS - 500);
    expect(room.rec!.stepAt).toBe(t0 + 60_000);
    ack(room, ws);
    expect(game(room).turn.step).toBe('tf');
    expect(lastEx(room)!.shownTo).toEqual([true, true, true, true]);
  });

  it('P1E05 컷씬 중 stall → 재개: lastCut.at 이 Δ 밀려 남은 컷씬이 실린다(room.test U14 와 같은 단언)', async () => {
    const { ctx, room, ws } = await atQuestion();
    room.game = { ...game(room), log: [...game(room).log, { ev: 'build', seat: 0, tile: 2, level: 4, cost: 0 }] };
    say(room, ws[0], { t: 'sync' });
    const t0 = Date.now();
    expect(room.rec!.lastCut).toEqual({ tile: 2, seat: 0, at: t0 });
    await advance(room, ctx, 1_500);
    room.stall(Date.now());
    expect(room.rec!.lastCut!.at).toBe(t0);
    expect(ws[1].last('state')!.cutscene).toBeNull();
    await advance(room, ctx, 20_000);
    say(room, ws[0], { t: 'resume' });
    expect(room.rec!.lastCut!.at).toBe(t0 + 20_000);
    const st = ws[1].last('state')!;
    expect(st.cutscene).toEqual({ tile: 2, builder: 0, t0: t0 + 20_000 });
    expect(st.now - st.cutscene!.t0).toBe(1_500);
  });

  it('구경 소켓·봇 예정: 멈춘 동안 봇 행동 0, 재개 뒤 남은 봇 지연 그대로', async () => {
    const { ctx, room } = setup();
    const [host] = join(room, ctx, 1);
    const watcher = connect(room, ctx);
    say(room, host, { t: 'start' });
    say(room, host, { t: 'act', a: { type: 'roll' } });
    await runUntil(room, ctx, () => game(room).turn.seat !== 0 && room.rec!.botAt !== null && room.rec!.botAt > Date.now());
    const from = Date.now();
    const { botAt } = room.rec!;
    const len = game(room).log.length;
    vi.setSystemTime(from + 120_000);
    room.stall(from);
    expect(game(room).log.length).toBe(len + 1);
    expect(room.rec!.botAt).toBe(botAt);
    expect(watcher.last('pins')).toBeUndefined();
    say(room, host, { t: 'resume' });
    expect(room.rec!.botAt).toBe(botAt! + 120_000);
  });
});
