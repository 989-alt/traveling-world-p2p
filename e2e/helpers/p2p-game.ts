// 기기 간 e2e 공용: 기기(브라우저 컨텍스트) 하나, 방 만들기·입장, 방장 탭의 Room 을 손잡이(window.__host)로 들여다보고 장면을 만든다.
import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { HostRoom } from '../../src/host/host-room';
import type { GameClient } from '../../src/state/client';
import { joinCode, openMake } from './entry';
import { recordOutside, recordRtc } from './p2p';
import { rngFor } from './room-server';

declare global {
  interface Window { __host: HostRoom; __client: GameClient; __accepts?: (number | null)[] }
}

export interface Dev { ctx: BrowserContext; page: Page; errors: string[]; net: Awaited<ReturnType<typeof recordOutside>>[] }

export async function device(browser: Browser, url: string, o: { viewport?: { width: number; height: number }; init?: (page: Page) => Promise<unknown>; go?: boolean } = {}): Promise<Dev> {
  const ctx = await browser.newContext({ baseURL: url, viewport: o.viewport ?? { width: 1366, height: 768 } });
  const dev: Dev = { ctx, page: null as unknown as Page, errors: [], net: [] };
  await tab(dev, o);
  return dev;
}

/** 같은 기기(저장소)의 새 탭. 그 뒤로 dev.page 는 이 탭 */
export async function tab(dev: Dev, o: { init?: (page: Page) => Promise<unknown>; go?: boolean } = {}) {
  const page = await dev.ctx.newPage();
  page.on('pageerror', (e) => dev.errors.push(e.message));
  await recordRtc(page);
  dev.net.push(await recordOutside(page));
  await o.init?.(page);
  dev.page = page;
  if (o.go !== false) await page.goto('/');
  return page;
}

/** 보고서 스크린숏(reports/P2P-3b-shots). P2P_SHOTS=폴더 일 때만 찍는다 */
export const shot = async (page: Page, name: string) => {
  const v = page.viewportSize()!;
  if (!process.env.P2P_SHOTS) return;
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.waitForTimeout(1_000);
  await page.screenshot({ path: `${process.env.P2P_SHOTS}/${name}-${v.width}x${v.height}.jpg`, type: 'jpeg', quality: 85 });
};

/** 새 방 → 대기실(캐릭터 고르기). 코드는 등록된 뒤에 readCode 로 */
export async function makeRoom(page: Page) {
  await openMake(page);
  await page.locator('[data-act="make"]').click();
  await expect(page.locator('.pick').first()).toBeVisible();
}
export async function readCode(page: Page) {
  await expect(page.locator('.code-box')).toHaveCount(6, { timeout: 15_000 });
  return (await page.locator('.code-box').allInnerTexts()).join('');
}
export const pick = async (page: Page, char: number) => {
  await page.locator(`.pick[data-char="${char}"]`).click();
  await expect(page.locator('.lb-slot.is-me')).toBeVisible();
};
/** 대기실 문서 높이(스크롤 상자는 .sc--lobby) */
export const tall = (page: Page) => page.evaluate(() => Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll('.sc--lobby, .lobby')].map((e) => e.scrollHeight)));
/** 코드로 들어가 자리에 앉는다 */
export async function sit(page: Page, code: string, char: number) {
  await joinCode(page, code);
  await expect(page.locator(`.pick[data-char="${char}"]`)).toBeEnabled({ timeout: 15_000 });
  await pick(page, char);
}

/** 방장 1 + 학생 n, 출발까지 */
export async function startGame(browser: Browser, url: string, n: number, o: Parameters<typeof device>[2] = {}) {
  const host = await device(browser, url, o);
  await makeRoom(host.page);
  await pick(host.page, 0);
  const code = await readCode(host.page);
  const guests: Dev[] = [];
  for (let i = 0; i < n; i++) {
    const g = await device(browser, url);
    await sit(g.page, code, i + 1);
    guests.push(g);
  }
  await expect(host.page.locator('.lb-slot-state', { hasText: '로봇이 함께해요' })).toHaveCount(3 - n);
  await host.page.locator('[data-act="start"]').click();
  for (const d of [host, ...guests]) await expect(d.page.locator('.board-root')).toBeVisible({ timeout: 15_000 });
  return { host, guests, code };
}
export const closeAll = async (devs: Dev[]) => { for (const d of devs) await d.ctx.close(); };

// ── 방장 탭의 Room ──────────────────────────────────────

/** 지금 판. left = 단계 마감까지, play = 남은 놀이 시간(지금 값) */
export const look = (page: Page) => page.evaluate(() => {
  const { rec, game } = window.__host.room;
  const g = game!, r = rec!, now = Date.now();
  return {
    now, phase: g.phase, step: g.turn.step, seat: g.turn.seat, log: g.log.length, left: r.deadlineAt! - now,
    play: g.clock.remainingMs - (g.phase === 'playing' && r.lastTickAt ? now - r.lastTickAt : 0),
    seats: r.seats.map((s, i) => ({ claimed: s.claimed, connected: s.connected, isBot: g.seats[i].isBot, pin: s.pin, charId: s.charId })),
    players: g.players.map((p) => ({ coin: p.coin, pos: p.pos })),
    question: g.turn.question && { qid: g.turn.question.qid, answer: g.turn.question.answer },
    pausedAt: g.clock.pausedAt, deadlineAt: r.deadlineAt,
  };
});
/** 기기가 보는 판(GameClient) */
export const seen = (page: Page) => page.evaluate(() => {
  const s = window.__client.state, g = s.room?.game;
  return { seat: s.seat, phase: s.room?.phase, turn: g?.turn.seat, step: g?.turn.step, log: s.log, players: g?.players.map((p) => ({ coin: p.coin, pos: p.pos })) };
});

type Act = { run(f: null, b: () => void): void; act(a: unknown): boolean; dirty: boolean };

/** seat 가 tile 에 도착하도록 주사위(1, 2)를 맞춰 굴린다(flow.spec 의 Srv.arrive 와 같다) */
export const arrive = (page: Page, seat: number, tile: number) => page.evaluate(([seat, tile, rng]) => {
  const room = window.__host.room, r = room as unknown as Act;
  r.run(null, () => {
    const g = room.game!;
    g.players[seat].pos = (tile - 3 + 30) % 30;
    Object.assign(g.turn, { seat, step: 'roll', tile: null, correct: null, discount: false, rolledDouble: false, extraRoll: false, question: null, tf: null, missionId: null, missionSuccess: false, rewardOptions: [], takeoverCost: 0 });
    g.rngState = rng;
    r.act({ type: 'roll', seat });
    r.dirty = true;
  });
}, [seat, tile, rngFor(1, 2)] as const);

/** 지금 단계를 시간 초과로 넘긴다 */
export const timeout = (page: Page) => page.evaluate(() => { const r = window.__host.room as unknown as Act; r.run(null, () => { r.act({ type: 'timeout', shown: [0, 1, 2, 3] }); r.dirty = true; }); });
/** 지금 단계 마감을 ms 뒤로 */
export const hurry = (page: Page, ms: number) => page.evaluate((ms) => {
  const room = window.__host.room, r = room as unknown as Act;
  r.run(null, () => { room.rec!.deadlineAt = Date.now() + ms; r.dirty = true; });
}, ms);

/** seat 가 tile 의 문항에, 남은 시간 ms. 이 자리의 화면에 문항 창이 열릴 때까지 기다린다 */
export async function atQuestion(host: Page, seat: number, tile: number, ms: number, arriver: Page) {
  await arrive(host, seat, tile);
  await timeout(host);
  await hurry(host, 60_000);
  await expect(arriver.locator('.qs[data-role="player"]')).toBeVisible({ timeout: 15_000 });
  await hurry(host, ms);
}
/** 놀이 시간이 다 돼 판이 끝나고 이 기기들이 결과 화면을 본다 */
export async function finishGame(host: Page, pages: Page[]) {
  await host.evaluate(() => { const room = window.__host.room, r = room as unknown as Act; r.run(null, () => { room.game!.clock.remainingMs = 300; r.dirty = true; }); });
  await expect.poll(async () => { const v = await look(host); if (v.phase === 'playing' && v.play <= 0) await timeout(host); return v.phase; }, { timeout: 30_000 }).toBe('finished');
  for (const p of pages) await expect(p.locator('.rs[data-kind="final"]')).toBeVisible({ timeout: 15_000 });
}
/** 한 차례를 끝까지 넘긴다(시간 초과) */
export async function passTurn(host: Page) {
  const from = await look(host);
  for (let i = 0; i < 40; i++) {
    const v = await look(host);
    if (v.phase !== 'playing' || v.seat !== from.seat) return;
    await timeout(host);
  }
  throw new Error('차례가 안 넘어감');
}

export const pm = (page: Page, kind: string) => page.locator(`.pm[data-kind="${kind}"]`);
/** 화면의 문항 타이머 숫자 */
export const sec = async (page: Page) => Number(await page.locator('.qs .tm').getAttribute('data-sec'));
/** 이 기기의 tw.host.<코드>.* 키 */
export const hostKeys = (page: Page, code: string) => page.evaluate((p) => Object.keys(localStorage).filter((k) => k.startsWith(p)).sort(), `tw.host.${code}.`);
