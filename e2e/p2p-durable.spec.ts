// P2P-7(PRD §9.5 거울): 브라우저 프로세스를 정말로 강제 종료(SIGKILL)한 뒤 같은 프로필로 다시 연다. 진짜 앱 + 로컬 시그널링 + 진짜 IndexedDB.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { joinCode } from './helpers/entry';
import { serveApp, startSignaling } from './helpers/p2p';
import { closeAll, device, hostKeys, look, makeRoom, mirror, passTurn, pick, pm, readCode, seen, shot, sit, startGame, tab, tall, type Dev } from './helpers/p2p-game';

test.describe.configure({ mode: 'serial' });
test.skip(() => test.info().project.name === 'tablet-touch', '기기 크기와 무관 — 데스크톱 한 번');
test.setTimeout(180_000);

let signal: Awaited<ReturnType<typeof startSignaling>>;
let site: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  signal = await startSignaling();
  site = await serveApp(signal.port);
});
test.afterAll(async () => { await site?.close(); await signal?.stop(); });

const profiles: string[] = [];
test.afterEach(() => { for (const p of profiles.splice(0)) { kill(p); rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } });

const clean = (devs: Dev[]) => { for (const d of devs) { expect(d.errors).toEqual([]); for (const n of d.net) expect(n.outside).toEqual([]); } };
const note = (type: string, v: unknown) => { test.info().annotations.push({ type, description: JSON.stringify(v) }); };

/** 지속 프로필 브라우저 하나 = 강제 종료할 기기 */
async function launch(dir: string, o: { go?: boolean } = {}): Promise<Dev> {
  const ctx = await chromium.launchPersistentContext(dir, { baseURL: site.url, viewport: { width: 1366, height: 768 } });
  const dev: Dev = { ctx, page: null as unknown as Page, errors: [], net: [] };
  await tab(dev, o);
  return dev;
}
function profile() {
  const dir = mkdtempSync(join(tmpdir(), 'tw-durable-'));
  profiles.push(dir);
  return dir;
}
/** 이 임시 프로필로 뜬 프로세스만 SIGKILL(Playwright 1.64 의 Browser 에는 process() 가 없다). 죽인 수를 돌려준다 */
function kill(dir: string): number {
  let pids: number[] = [];
  try { pids = execFileSync('pgrep', ['-f', `user-data-dir=${dir}`], { encoding: 'utf8' }).trim().split('\n').map(Number); } catch { /* 없음 */ }
  for (const p of pids) try { process.kill(p, 'SIGKILL'); } catch { /* 이미 죽음 */ }
  return pids.length;
}
async function sigkill(d: Dev, dir: string) {
  const gone = new Promise((ok) => { d.ctx.once('close', ok); });
  const n = kill(dir);
  expect(n).toBeGreaterThan(0);
  await gone;
  return n;
}
/** 앱을 열기 전(같은 출처의 그림): localStorage 와 거울에 남은 것 */
async function left(page: Page, code: string) {
  await page.goto(`${site.url}webp/UI-logo.webp`);
  const of = (kv: Record<string, string>) => {
    const r = JSON.parse(kv[`tw.host.${code}.room`] ?? 'null') as { logLen: number; seats: { claimed: boolean }[]; game: { phase: string } | null } | null;
    return { logLen: r?.logLen ?? null, alive: Number(kv[`tw.host.${code}.alive`] ?? 0), phase: r ? r.game?.phase ?? 'lobby' : null, seats: r ? r.seats.filter((s) => s.claimed).length : null, keys: Object.keys(kv).filter((k) => k.startsWith(`tw.host.${code}.`)).length, seat: kv['tw.seat'] ?? null };
  };
  const ls = of(await page.evaluate(() => ({ ...localStorage })));
  const db = of(await mirror(page));
  return { ls, db, behindMs: db.alive - ls.alive };
}
/** 기기가 받은 오류를 전부 적는다 */
const watchErrors = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __errs: string[] };
  w.__errs = [];
  window.__client.subscribe((s) => { if (s.error) w.__errs.push(s.error); });
});
const errs = (page: Page) => page.evaluate(() => (window as unknown as { __errs: string[] }).__errs);

test('P7E13 대기실에서 방장 브라우저 강제 종료: 다시 열면 학생 자리가 그대로, 학생은 자기 자리로 이어진다', async ({ browser }) => {
  const dir = profile();
  let host = await launch(dir);
  await makeRoom(host.page);
  await pick(host.page, 0);
  const code = await readCode(host.page);
  const g = await device(browser, site.url);
  await sit(g.page, code, 1);
  await watchErrors(g.page);
  await host.page.waitForTimeout(3_000);
  const n = await sigkill(host, dir);
  host = await launch(dir, { go: false });
  const at = await left(host.page, code);
  const t0 = Date.now();
  await host.page.goto('/');
  await expect(host.page.locator('.lb-slot.is-me')).toHaveAttribute('data-seat', '0', { timeout: 20_000 });
  const openMs = Date.now() - t0;
  await expect(host.page.locator('.lb-slot[data-seat="1"] .lb-slot-state')).toHaveText('준비됐어요', { timeout: 30_000 });
  note('P7E13', { killed: n, ...at, openMs, guestBackMs: Date.now() - t0 });
  expect([at.db.seats, at.db.phase]).toEqual([2, 'lobby']);
  await expect(g.page.locator('.lb-slot.is-me')).toHaveAttribute('data-seat', '1');
  await expect(g.page.locator('.lobby-pick')).toHaveCount(0);
  expect(await errs(g.page)).toEqual([]);
  clean([host, g]);
  await closeAll([host, g]);
});

/** 시점마다 localStorage 가 거울보다 얼마나 뒤처졌나 */
const behind: number[] = [];
for (const sec of [10, 30]) {
  test(`P7E14 판 시작 ${sec}초에 방장 브라우저 강제 종료, 학생 2: 마지막 1초 안의 멈춘 판으로 돌아와 이어진다`, async ({ browser }) => {
    const dir = profile();
    let host = await launch(dir);
    await makeRoom(host.page);
    await pick(host.page, 0);
    const code = await readCode(host.page);
    const guests: Dev[] = [];
    for (const char of [1, 2]) { const g = await device(browser, site.url); await sit(g.page, code, char); guests.push(g); }
    await host.page.locator('[data-act="start"]').click();
    for (const d of [host, ...guests]) await expect(d.page.locator('.board-root')).toBeVisible({ timeout: 15_000 });
    const start = Date.now();
    for (let i = 0; i < 3; i++) { await passTurn(host.page); await host.page.waitForTimeout(1_000); } // 로그가 쌓이게
    await host.page.waitForTimeout(Math.max(0, start + sec * 1_000 - Date.now()));
    const atKill = await Promise.all(guests.map((g) => g.page.evaluate(() => {
      const s = window.__client.state, c = s.room!.game!.clock;
      return { log: s.log.length, play: c.remainingMs - (s.room!.phase === 'playing' ? Date.now() - s.clockAt : 0) };
    })));
    const n = await sigkill(host, dir);
    const sawLog = await Promise.all(guests.map(async (g) => (await seen(g.page)).log.length)); // 죽기 직전까지 받은 것
    host = await launch(dir, { go: false });
    const at = await left(host.page, code);
    behind.push(at.behindMs);
    const t0 = Date.now();
    await host.page.goto('/');
    await expect(pm(host.page, 'P-H')).toBeVisible({ timeout: 20_000 });
    const openMs = Date.now() - t0;
    const back = await look(host.page);
    note(`P7E14 ${sec}초`, { killed: n, ...at, atKill, sawLog, hostLog: back.log - 1, hostPlay: back.play, openMs });
    expect((await seen(host.page)).log.at(-1)).toMatchObject({ ev: 'clock', kind: 'pause', by: 'auto' });
    const short = Math.max(...sawLog) - (back.log - 1); // 자동 멈춤 하나를 뺀 길이
    expect(short).toBeGreaterThanOrEqual(0);
    expect(short).toBeLessThanOrEqual(1);
    for (const a of atKill) expect(Math.abs(a.play - back.play)).toBeLessThanOrEqual(2_000);
    for (const g of guests) {
      await expect(pm(g.page, 'P-S')).toBeVisible({ timeout: 30_000 });
      await expect(g.page.locator('.pin-box')).toHaveCount(0);
      expect((await seen(g.page)).log.length).toBe(back.log);
    }
    await pm(host.page, 'P-H').locator('[data-act="resume"]').click();
    for (const g of guests) { await expect(pm(g.page, 'P-S')).toHaveCount(0); expect((await seen(g.page)).phase).toBe('playing'); }
    clean([host, ...guests]);
    await closeAll([host, ...guests]);
    // 전제: 강제 종료가 localStorage 를 정말로 되돌린다(두 시점 가운데 하나 이상). 아니면 이 시험은 아무것도 재지 않은 것
    if (sec === 30) expect(Math.max(...behind)).toBeGreaterThan(0);
  });
}

test('P7E15 학생 브라우저 강제 종료: 다시 열면 첫 화면이 아니라 저절로 자기 자리', async ({ browser }) => {
  const host = await device(browser, site.url);
  await makeRoom(host.page);
  await pick(host.page, 0);
  const code = await readCode(host.page);
  const dir = profile();
  let g = await launch(dir);
  await sit(g.page, code, 1);
  await g.page.waitForTimeout(3_000);
  const n = await sigkill(g, dir);
  g = await launch(dir, { go: false });
  const { ls, db } = await left(g.page, code);
  note('P7E15', { killed: n, lsSeat: ls.seat, mirrorSeat: db.seat });
  expect(JSON.parse(db.seat!)).toMatchObject({ roomCode: code, seatNo: 1 });
  const t0 = Date.now();
  await g.page.goto('/');
  await expect(g.page.locator('.lb-slot.is-me')).toHaveAttribute('data-seat', '1', { timeout: 30_000 });
  note('P7E15 openMs', Date.now() - t0);
  clean([host, g]);
  await closeAll([host, g]);
});

test('P7E16 거울 = localStorage. [게임 끝내기] 뒤 거울에 그 방 0, 자리는 묘비, 새로고침해도 되살아나지 않는다', async ({ browser }) => {
  const { host, guests: [g], code } = await startGame(browser, site.url, 1);
  const p = host.page;
  await passTurn(p);
  const local = () => p.evaluate((c) => Object.fromEntries(Object.entries({ ...localStorage }).filter(([k]) => k.startsWith(`tw.host.${c}.`))), code);
  const stored = async () => Object.fromEntries(Object.entries(await mirror(p)).filter(([k]) => k.startsWith(`tw.host.${code}.`)));
  await expect(async () => {
    const [a, b] = [await local(), await stored()];
    const alive = `tw.host.${code}.alive`;
    expect(Math.abs(Number(a[alive]) - Number(b[alive]))).toBeLessThanOrEqual(1_000);
    expect({ ...b, [alive]: '' }).toEqual({ ...a, [alive]: '' });
    expect(Object.keys(a).length).toBeGreaterThan(2);
  }).toPass({ timeout: 10_000 });
  expect((await mirror(p))['tw.seat']).toBe(await p.evaluate(() => localStorage.getItem('tw.seat')));
  await p.locator('[data-act="pause"]').click();
  await p.locator('.pm [data-act="ask-end"]').click();
  await p.locator('.pm [data-act="end"]').click();
  await expect(p.locator('.app')).toHaveAttribute('data-phase', 'entry');
  await expect.poll(stored).toEqual({});
  expect(Object.keys(JSON.parse((await mirror(p))['tw.seat']))).toEqual(['at']);
  await p.reload();
  await expect(p.locator('[data-act="intro-start"]')).toBeVisible();
  await p.waitForTimeout(2_500); // 거울 읽기 시한보다 길게
  await expect(p.locator('[data-act="intro-start"]')).toBeVisible();
  expect(await hostKeys(p, code)).toEqual([]);
  clean([host, g]);
  await closeAll([host, g]);
});

test('P7E16 나가기·끝내기 직후 탭을 닫아도 거울의 지움이 끝까지 간다: 다시 열면 첫 화면', async ({ browser }) => {
  const { host, guests: [g], code } = await startGame(browser, site.url, 1);
  await g.page.locator('[data-act="leave-sign"]').click();
  await g.page.locator('.pm [data-act="leave"]').click();
  await expect(g.page.locator('.app')).toHaveAttribute('data-phase', 'entry');
  await g.page.close();
  await host.page.locator('[data-act="pause"]').click();
  await host.page.locator('.pm [data-act="ask-end"]').click();
  await host.page.locator('.pm [data-act="end"]').click();
  await expect(host.page.locator('.app')).toHaveAttribute('data-phase', 'entry');
  await host.page.close();
  for (const d of [host, g]) {
    await tab(d, { go: false });
    await d.page.goto(`${site.url}webp/UI-logo.webp`);
    const db = await mirror(d.page);
    expect(Object.keys(db)).toEqual(['tw.seat']);
    expect(Object.keys(JSON.parse(db['tw.seat']))).toEqual(['at']);
    await d.page.goto('/');
    await expect(d.page.locator('[data-act="intro-start"]')).toBeVisible();
  }
  expect(await hostKeys(host.page, code)).toEqual([]);
  clean([host, g]);
  await closeAll([host, g]);
});

/** 이 페이지의 첫 거울 넣기 한 번만 실패한다 → 그 세션의 거울이 꺼진다 */
const firstPutFails = (p: Page) => p.addInitScript(() => {
  const put = IDBObjectStore.prototype.put;
  let n = 0;
  IDBObjectStore.prototype.put = function (...a: Parameters<typeof put>) {
    if (n++ === 0) throw new DOMException('시험', 'UnknownError');
    return put.apply(this, a);
  };
});

test('P7bE08 거울이 꺼진 세션의 [게임 끝내기]·[나가기]: 새 연결로 묘비가 들어가고 새로고침해도 첫 화면', async ({ browser }) => {
  const host = await device(browser, site.url, { init: firstPutFails });
  await makeRoom(host.page);
  await pick(host.page, 0);
  const code = await readCode(host.page);
  const g = await device(browser, site.url, { init: firstPutFails });
  await sit(g.page, code, 1);
  await host.page.locator('[data-act="start"]').click();
  for (const d of [host, g]) await expect(d.page.locator('.board-root')).toBeVisible({ timeout: 15_000 });
  for (let i = 0; i < 2; i++) { await passTurn(host.page); await host.page.waitForTimeout(600); }
  const roomKeys = async () => Object.keys(await mirror(host.page)).filter((k) => k.startsWith(`tw.host.${code}.`));
  expect(await roomKeys()).toEqual([]); // 거울이 꺼졌다
  expect((await hostKeys(host.page, code)).length).toBeGreaterThan(2);
  const tomb = async (p: Page) => Object.keys(JSON.parse((await mirror(p))['tw.seat'] ?? '{}'));
  const first = async (p: Page) => {
    await p.reload();
    await p.waitForTimeout(3_000); // 거울 읽기 시한보다 길게
    await expect(p.locator('[data-act="intro-start"]')).toBeVisible();
    expect(await p.evaluate(() => localStorage.getItem('tw.seat'))).toBeNull();
  };
  const soft = expect.configure({ soft: true });
  // 학생 나가기
  await g.page.locator('[data-act="leave-sign"]').click();
  await g.page.locator('.pm [data-act="leave"]').click();
  await expect(g.page.locator('.app')).toHaveAttribute('data-phase', 'entry');
  await soft.poll(() => tomb(g.page)).toEqual(['at']);
  await first(g.page);
  // 방장 끝내기
  await host.page.locator('[data-act="pause"]').click();
  await host.page.locator('.pm [data-act="ask-end"]').click();
  await host.page.locator('.pm [data-act="end"]').click();
  await expect(host.page.locator('.app')).toHaveAttribute('data-phase', 'entry');
  await soft.poll(() => tomb(host.page)).toEqual(['at']);
  expect(await roomKeys()).toEqual([]);
  await first(host.page);
  expect(await hostKeys(host.page, code)).toEqual([]);
  clean([host, g]);
  await closeAll([host, g]);
});

// ── 되돌아간 대기실(거울이 안 되는 브라우저) ────────────

const noMirror = (p: Page) => p.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { configurable: true, get() { throw new DOMException('막힘', 'SecurityError'); } }); });
const snap = (p: Page) => p.evaluate(() => Object.fromEntries(Object.entries({ ...localStorage }).filter(([k]) => k.startsWith('tw.'))));
/** 앱이 안 도는 같은 출처 그림에서 localStorage 를 되돌린다 */
async function rollback(p: Page, to: Record<string, string>) {
  await p.goto(`${site.url}webp/UI-logo.webp`);
  await p.evaluate((to) => {
    for (const k of Object.keys(localStorage).filter((k) => k.startsWith('tw.'))) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(to)) localStorage.setItem(k, v);
  }, to);
}
/** 방장(거울 막힘)과 앉은 학생. before 는 학생이 앉기 전(sat: 방장이 앉은 뒤, 아니면 앉기 전)의 저장본 */
async function rolled(browser: Browser, sat: boolean) {
  const host = await device(browser, site.url, { init: noMirror });
  await makeRoom(host.page);
  let before = sat ? null : await snap(host.page);
  await pick(host.page, 0);
  const code = await readCode(host.page);
  before ??= await snap(host.page);
  const g = await device(browser, site.url);
  await sit(g.page, code, 1);
  const pin = await g.page.evaluate(() => window.__client.state.pin);
  return { host, g, code, before, pin };
}

test('P7E11 되돌아간 대기실: 학생은 같은 캐릭터로 저절로 다시 앉고, 방장에게 한 줄, 출발하면 판으로', async ({ browser }) => {
  const { host, g, before, pin } = await rolled(browser, true);
  await rollback(host.page, before);
  await host.page.goto('/');
  await expect(host.page.locator('[data-k="host-restored"]')).toHaveText('다시 연 방이에요. 친구들이 모두 자리에 앉은 뒤에 출발해 주세요', { timeout: 20_000 });
  await expect(host.page.locator('.lb-slot[data-seat="1"] .lb-slot-state')).toHaveText('준비됐어요', { timeout: 30_000 });
  const hostSeat = await host.page.evaluate(() => { const s = window.__host.room.rec!.seats[1]; return { pin: s.pin, charId: s.charId }; });
  const mine = await g.page.evaluate(() => { const s = window.__client.state; return { seat: s.seat, pin: s.pin, charId: s.room!.seats[1].charId }; });
  expect(mine).toEqual({ seat: 1, pin: hostSeat.pin, charId: 1 });
  expect(hostSeat.charId).toBe(1);
  expect(mine.pin).not.toBe(pin); // 새 번호
  await expect(g.page.locator('.lb-slot.is-me')).toHaveAttribute('data-seat', '1');
  await expect(g.page.locator('.lobby-pick')).toHaveCount(0);
  await shot(host.page, 'host-restored');
  await host.page.locator('[data-act="start"]').click();
  await expect(g.page.locator('.game .board-root')).toBeVisible({ timeout: 15_000 });
  await expect(g.page.locator('.pin-box')).toHaveCount(0);
  expect((await look(host.page)).seats.map((s) => s.isBot)).toEqual([false, false, true, true]);
  clean([host, g]);
  await closeAll([host, g]);
});

test('P7E11 되돌아간 대기실에서 방장이 먼저 그 캐릭터를 고름: 학생은 고르기 화면(단추 살아 있음)', async ({ browser }) => {
  const { host, g, code, before } = await rolled(browser, false);
  const { port } = signal;
  await signal.stop(); // 학생이 방장보다 먼저 붙지 못하게
  await rollback(host.page, before);
  await host.page.goto('/');
  await joinCode(host.page, code);
  await expect(host.page.locator('.pick[data-char="1"]')).toBeVisible({ timeout: 30_000 });
  await pick(host.page, 1);
  signal = await startSignaling(port);
  await expect(g.page.locator('.lobby-pick')).toBeVisible({ timeout: 60_000 });
  await expect(g.page.locator('.pick[data-char="1"]')).toBeDisabled();
  await g.page.waitForTimeout(1_500);
  await expect(g.page.locator('.lobby-pick')).toBeVisible();
  expect(await host.page.evaluate(() => window.__host.room.rec!.seats.map((s) => s.claimed))).toEqual([true, false, false, false]);
  await pick(g.page, 2);
  await expect(host.page.locator('.lb-slot[data-seat="1"] .lb-slot-state')).toHaveText('준비됐어요');
  clean([host, g]);
  await closeAll([host, g]);
});

const breakStore = () => { Storage.prototype.setItem = () => { throw new DOMException('막힘', 'SecurityError'); }; };
/** 방 코드 알약과 겹치는 것 */
const overlaps = (p: Page) => p.evaluate(() => {
  const pill = document.querySelector('.code-pill')!, a = pill.getBoundingClientRect();
  return [...document.querySelectorAll('.app *')].filter((e) => !e.contains(pill) && !pill.contains(e) && !e.closest('.sc-bg'))
    .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top; }).map((e) => e.className);
});
/** 안내 줄이 출발 단추·자리 칸과 겹치는가 */
const lineHits = (p: Page, sel: string) => p.evaluate((sel) => {
  const a = document.querySelector(sel)!.getBoundingClientRect();
  return ['[data-act="start"]', '.lobby-seats'].filter((s) => { const b = document.querySelector(s)!.getBoundingClientRect(); return b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top; });
}, sel);

for (const viewport of [{ width: 1366, height: 768 }, { width: 740, height: 360 }]) {
  test(`P7E12 다시 연 대기실 한 줄(${viewport.width}×${viewport.height}): 앉은 뒤에만, host-keep 자리, 넘침·겹침을 더 만들지 않는다`, async ({ browser }) => {
    const host = await device(browser, site.url, { viewport });
    const p = host.page;
    const lines = async () => Promise.all(['[data-k="host-restored"]', '[data-k="host-keep"]', '.lobby-sub[data-save]'].map((s) => p.locator(s).count()));
    await makeRoom(p);
    const code = await readCode(p);
    const picking = await tall(p);
    expect(await lines()).toEqual([0, 0, 0]);
    await pick(p, 0);
    expect(await lines()).toEqual([0, 1, 0]); // 새로 만든 대기실
    const top = (q: Page) => q.evaluate(() => { for (const e of document.querySelectorAll('.sc--lobby, .lobby')) e.scrollTop = 0; }); // 740×360 은 단추를 누르려고 굴러가 있다
    await top(p);
    const keep = { at: (await p.locator('[data-k="host-keep"]').boundingBox())!, tall: await tall(p), hits: await overlaps(p), start: (await p.locator('[data-act="start"]').boundingBox())! };

    // 앉기 전에 닫은 방을 코드로 다시 연다
    const two = await device(browser, site.url, { viewport });
    await makeRoom(two.page);
    const code2 = await readCode(two.page);
    await two.page.reload();
    await joinCode(two.page, code2);
    await readCode(two.page);
    expect(await two.page.evaluate(() => window.__client.state.host!.restored)).toBe(true);
    for (const s of ['[data-k="host-restored"]', '[data-k="host-keep"]', '.lobby-sub[data-save]']) await expect(two.page.locator(s)).toHaveCount(0);
    expect(await tall(two.page)).toBe(picking);
    await pick(two.page, 0);
    await expect(two.page.locator('[data-k="host-restored"]')).toHaveCount(1);
    await expect(two.page.locator('[data-k="host-keep"]')).toHaveCount(0);

    // 앉은 방을 새로고침
    await p.reload();
    await expect(p.locator('[data-k="host-restored"]')).toHaveText('다시 연 방이에요. 친구들이 모두 자리에 앉은 뒤에 출발해 주세요', { timeout: 15_000 });
    expect(await readCode(p)).toBe(code);
    for (const q of [p, two.page]) {
      await top(q);
      const at = (await q.locator('[data-k="host-restored"]').boundingBox())!;
      expect([at.y, at.height]).toEqual([keep.at.y, keep.at.height]);
      expect(await tall(q)).toBeLessThanOrEqual(keep.tall);
      expect(await overlaps(q)).toEqual(keep.hits);
      expect(await lineHits(q, '[data-k="host-restored"]')).toEqual([]);
      expect((await q.locator('[data-act="start"]').boundingBox())!).toEqual(keep.start);
    }
    if (viewport.width === 1366) {
      expect([keep.hits, await tall(p) <= 768, keep.start.y + keep.start.height <= 768]).toEqual([[], true, true]);
    }
    await shot(p, 'host-restored-lobby');

    // 다시 연 방에서 저장이 안 됨: 저장 안내 한 줄만
    await p.addInitScript(breakStore);
    await p.reload();
    await expect(p.locator('.lobby-sub[data-save]')).toHaveCount(1, { timeout: 15_000 });
    expect(await lines()).toEqual([0, 0, 1]);
    clean([host, two]);
    await closeAll([host, two]);
  });
}
