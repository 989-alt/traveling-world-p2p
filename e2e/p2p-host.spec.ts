// P2P-3(PRD §6 S16): 방장 자리 비움·복원. 진짜 앱 + 로컬 시그널링 + 진짜 새로고침. 방장 탭의 Room 은 손잡이(window.__host)로 본다.
import { expect, test, type Page } from '@playwright/test';
import { joinCode } from './helpers/entry';
import { serveApp, startSignaling } from './helpers/p2p';
import { arrive, atQuestion, closeAll, device, finishGame, hostKeys, hurry, look, makeRoom, passTurn, pick, pm, readCode, sec, seen, shot, sit, startGame, tab, tall, type Dev } from './helpers/p2p-game';

test.describe.configure({ mode: 'serial' });
test.skip(() => test.info().project.name === 'tablet-touch', '기기 크기와 무관 — 데스크톱 한 번');
test.setTimeout(120_000);

let signal: Awaited<ReturnType<typeof startSignaling>>;
let site: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  signal = await startSignaling();
  site = await serveApp(signal.port);
});
test.afterAll(async () => { await site?.close(); await signal?.stop(); });

const clean = (devs: Dev[]) => { for (const d of devs) { expect(d.errors).toEqual([]); for (const n of d.net) expect(n.outside).toEqual([]); } };
/** 방장 탭을 ms 동안 없앤다(새로고침). 저장소는 그대로 */
async function gone(page: Page, ms: number) {
  await page.goto('about:blank');
  await page.waitForTimeout(ms);
  await page.goto(site.url);
}
const resume = async (host: Page) => {
  await pm(host, 'P-H').locator('[data-act="resume"]').click();
  await expect(pm(host, 'P-H')).toHaveCount(0);
};
/** '방을 다시 열지 못했어요'와 방 코드 6자(§8-19 ⓗ): 두 크기에서 안 잘린다. name 이 있으면 보고서 스크린숏 */
async function stuckWithCode(host: Dev, code: string, name: string | null) {
  const note = host.page.locator('.sc-note');
  for (const viewport of [{ width: 1180, height: 820 }, { width: 1366, height: 768 }]) {
    await host.page.setViewportSize(viewport);
    await expect(note).toContainText('방을 다시 열지 못했어요', { timeout: 8_000 });
    await expect(note.locator('button')).toHaveText(['다시 해 보기', '처음 화면으로']);
    await expect(note.locator('.code-box')).toHaveText(code.split(''));
    expect(await note.evaluate((n) => {
      const out = n.getBoundingClientRect();
      return [...n.querySelectorAll('.code-pill, .code-box, button')].filter((e) => {
        const r = e.getBoundingClientRect();
        return e.scrollWidth > e.clientWidth || r.width === 0 || r.left < out.left || r.right > out.right || r.top < out.top || r.bottom > out.bottom || out.bottom > innerHeight;
      }).map((e) => e.className);
    })).toEqual([]);
    if (name) await shot(host.page, `reopen-${name}`);
  }
}
/** 답 시간이 남은 값 */
const near = (a: number, b: number, by: number, what: string) => expect(Math.abs(a - b), `${what}: ${a} vs ${b}`).toBeLessThanOrEqual(by);

test('P3E03 문항 남은 약 12초에 방장 새로고침(8초 뒤): 학생은 방장 기다림·타이머 정지 → 저절로 멈춤 모달, 계속하기 뒤 12초에서', async ({ browser }) => {
  const { host, guests: [g] } = await startGame(browser, site.url, 1);
  await atQuestion(host.page, 1, 11, 12_500, g.page);
  const before = await look(host.page);
  const t0 = Date.now();
  const away = expect(pm(g.page, 'H-W')).toBeVisible({ timeout: 7_500 }).then(async () => {
    const at = Date.now() - t0;
    await expect(g.page.locator('#pm-title')).toHaveText('방장 기기를 기다리고 있어요');
    await expect(g.page.locator('.pm-line')).toHaveText('방장 기기가 다시 켜지면 저절로 이어져요');
    await expect(g.page.locator('.pm-btn')).toHaveText(['처음 화면으로']);
    const s = await sec(g.page);
    const clock = await g.page.locator('.gm-timer b').innerText();
    await g.page.waitForTimeout(1_300);
    expect([await sec(g.page), await g.page.locator('.gm-timer b').innerText()]).toEqual([s, clock]); // 화면 시계 정지
    return at;
  });
  await host.page.goto('about:blank');
  test.info().annotations.push({ type: 'away-ms', description: String(await away) });
  await g.page.waitForTimeout(Math.max(0, 8_000 - (Date.now() - t0)));
  await host.page.goto(site.url);
  await expect(pm(host.page, 'P-H')).toBeVisible({ timeout: 10_000 });
  await expect(host.page.locator('.pin-box')).toHaveCount(0);
  // 멈춘 채 열린 판: 등장 연출이 첫 프레임에 서서 안 보이는 것이 없다(캐릭터·간판·문항 창)
  await expect(host.page.locator('.qs')).toBeVisible();
  expect(await host.page.locator('.game').evaluate((g) => g.getAnimations({ subtree: true }).filter((a) => a.playState === 'paused' && a.effect!.getComputedTiming().endTime !== Infinity).map((a) => (a.effect as KeyframeEffect).target!.className))).toEqual([]);
  expect(await host.page.locator('.bc-pose').evaluateAll((els) => els.map((e) => getComputedStyle(e).opacity).filter((o) => o !== '1'))).toEqual([]);
  const back = await look(host.page);
  expect([back.phase, (await seen(host.page)).seat]).toEqual(['paused', 0]);
  near(back.play, before.play, 1_200, '놀이 시계');
  await expect(pm(g.page, 'P-S')).toBeVisible({ timeout: 15_000 });
  // 다시 붙은 기기에도 자리 번호가 있다
  await pm(g.page, 'P-S').locator('[data-act="seat"]').click();
  await expect(g.page.locator('.save-pin')).toHaveText(back.seats[1].pin);
  await g.page.locator('[data-act="saved"]').click();
  await resume(host.page);
  await expect(pm(g.page, 'P-S')).toHaveCount(0);
  near((await look(host.page)).left, before.left, 1_500, '문항 남은 시간');
  near(await sec(g.page) * 1000, before.left, 2_000, '학생 화면 문항 숫자');
  clean([host, g]);
  await closeAll([host, g]);
});

test('P3E04 방장 탭이 가려져 8초 멎음 → 멈춤 모달, 학생은 그 사이 방장 기다림 / 2초는 아무 일 없음', async ({ browser }) => {
  const { host, guests: [g] } = await startGame(browser, site.url, 1);
  await atQuestion(host.page, 1, 11, 60_000, g.page);
  const hide = (ms: number) => host.page.evaluate((ms) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    const t = Date.now();
    while (Date.now() - t < ms); // 타이머가 하나도 안 돈다
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  }, ms);
  const a = await look(host.page);
  await hide(2_000);
  await host.page.waitForTimeout(1_500);
  const b = await look(host.page);
  expect([b.phase, b.log]).toEqual(['playing', a.log]);
  near(a.play - b.play, b.now - a.now, 300, '2초는 흐른 시간');
  await expect(pm(g.page, 'H-W')).toHaveCount(0);
  const away = expect(pm(g.page, 'H-W')).toBeVisible({ timeout: 9_000 });
  const c = await look(host.page);
  await hide(8_000);
  await away;
  await expect(pm(host.page, 'P-H')).toBeVisible();
  await expect(pm(g.page, 'P-S')).toBeVisible({ timeout: 10_000 });
  await expect(pm(g.page, 'H-W')).toHaveCount(0);
  near((await look(host.page)).play, c.play, 1_500, '놀이 시계');
  clean([host, g]);
  await closeAll([host, g]);
});

test('P3E05 같은 브라우저 두 번째 탭에서 같은 방: 다른 창 안내 + 처음 화면으로, 첫 탭 영향 0', async ({ browser }) => {
  const { host, guests: [g], code } = await startGame(browser, site.url, 1);
  const first = host.page;
  const second = await tab(host, {
    init: (p) => p.addInitScript(() => {
      const w = window as unknown as { __writes: string[] };
      w.__writes = [];
      for (const k of ['setItem', 'removeItem'] as const) {
        const f = Storage.prototype[k] as (...a: string[]) => void;
        (Storage.prototype as unknown as Record<string, unknown>)[k] = function (this: Storage, ...a: string[]) { if (/^tw\.(host|seat)/.test(a[0])) w.__writes.push(a[0]); return f.apply(this, a); };
      }
    }),
  });
  const note = second.locator('.sc-note');
  await expect(note).toContainText('이 방은 다른 창에서 열려 있어요. 그 창에서 계속해 주세요');
  await note.locator('button', { hasText: '처음 화면으로' }).click();
  await joinCode(second, code);
  await expect(note).toContainText('이 방은 다른 창에서 열려 있어요. 그 창에서 계속해 주세요');
  await note.locator('button').click();
  await expect(second.locator('[data-act="intro-start"]')).toBeVisible();
  expect(await second.evaluate(() => (window as unknown as { __writes: string[] }).__writes)).toEqual([]);
  expect((await look(first)).phase).toBe('playing');
  await expect(first.locator('.board-root')).toBeVisible();
  expect((await look(first)).seats.slice(0, 2).map((s) => s.connected)).toEqual([true, true]);
  clean([host, g]);
  await closeAll([host, g]);
});

test('P3E06 다른 기기가 자리 0 + 방장 PIN 으로 복귀: 틀린 번호와 같은 안내, 방장 화면 영향 0', async ({ browser }) => {
  const { host, guests: [g], code } = await startGame(browser, site.url, 1);
  const pin = (await look(host.page)).seats[0].pin;
  const other = await device(browser, site.url);
  await joinCode(other.page, code);
  await expect(other.page.locator('.pin-box')).toBeVisible({ timeout: 15_000 });
  await other.page.locator('.pin-seat').first().click();
  await other.page.locator('#seat-pin').fill(pin);
  await other.page.getByRole('button', { name: '돌아가기' }).click();
  await expect(other.page.locator('.sc-msg')).toHaveText('번호가 맞지 않아요. 찍어 둔 사진을 다시 봐 주세요.');
  await host.page.waitForTimeout(500);
  await expect(host.page.locator('.board-root')).toBeVisible();
  expect([(await seen(host.page)).seat, (await look(host.page)).seats[0].connected, (await look(host.page)).phase]).toEqual([0, true, 'playing']);
  clean([host, g, other]);
  await closeAll([host, g, other]);
});

test('P3E09 끝내기 직후 방장 탭 닫기 / 나가기 직후 학생 탭 닫기', async ({ browser }) => {
  const { host, guests, code } = await startGame(browser, site.url, 3);
  const keys = async (d: Dev) => d.page.evaluate(() => localStorage.getItem('tw.seat'));
  // 나가기: 학생 3
  const out = guests[2];
  await out.page.locator('[data-act="leave-sign"]').click();
  await out.page.locator('.pm [data-act="leave"]').click();
  await expect(out.page.locator('.app')).toHaveAttribute('data-phase', 'entry');
  expect(await keys(out)).toBeNull();
  await out.page.close();
  await expect(host.page.locator('.panel[data-seat="3"] .panel-bot')).toBeVisible({ timeout: 35_000 });
  // 끝내기
  await host.page.locator('[data-act="pause"]').click();
  await host.page.locator('.pm [data-act="ask-end"]').click();
  await host.page.locator('.pm [data-act="end"]').click();
  await expect(host.page.locator('.app')).toHaveAttribute('data-phase', 'entry');
  await host.page.close();
  await Promise.all(guests.slice(0, 2).map(async (d) => { // 띠는 4초라 두 기기를 함께 본다
    await expect(d.page.locator('[data-bye="ended"]')).toHaveText('방장이 게임을 끝냈어요', { timeout: 3_000 });
    await expect(d.page.locator('.app')).toHaveAttribute('data-phase', 'entry');
    expect(await keys(d)).toBeNull();
  }));
  await tab(host);
  await expect(host.page.locator('[data-act="intro-start"]')).toBeVisible(); // 끝낸 판은 되살아나지 않는다
  expect(await hostKeys(host.page, code)).toEqual([]);
  clean([host, ...guests]);
  await closeAll([host, ...guests]);
});

test('P3E10 ⓐ 처음부터 저장이 안 되는 기기: 띠, 방 만들기·출발 가능, 새로고침하면 첫 화면', async ({ browser }) => {
  const host = await device(browser, site.url, { init: (p) => p.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('막힘', 'SecurityError'); }; }) });
  await makeRoom(host.page);
  const band = host.page.locator('[data-save]');
  await readCode(host.page);
  await pick(host.page, 0); // 저장 안내는 앉은 뒤에(§8-20 ③ P2P-3 되돌이)
  await expect(band).toHaveText('이 기기에는 놀이를 저장할 수 없어요. 창을 닫으면 이어 할 수 없어요');
  await host.page.locator('[data-act="start"]').click();
  await expect(host.page.locator('.board-root')).toBeVisible({ timeout: 15_000 });
  await expect(band).toBeVisible();
  await host.page.reload();
  await expect(host.page.locator('[data-act="intro-start"]')).toBeVisible();
  await expect(host.page.locator('.sc-note')).toHaveCount(0);
  clean([host]);
  await closeAll([host]);
});

test('P3E10 ⓑ 하다가 저장이 멈춤: 띠, 두 차례 더 → 방장 새로고침이면 실패 직전으로, 학생 로그 = 방장 로그, 계속하면 정상', async ({ browser }) => {
  const { host, guests: [g] } = await startGame(browser, site.url, 1);
  await passTurn(host.page);
  await host.page.waitForTimeout(1_200);
  const saved = await look(host.page);
  await host.page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('꽉 참', 'QuotaExceededError'); }; });
  await passTurn(host.page);
  await passTurn(host.page);
  await expect(host.page.locator('[data-save]')).toHaveText('지금부터는 놀이가 저장되지 않아요. 창을 닫으면 조금 전으로 돌아가요');
  const ahead = await look(host.page);
  expect(ahead.log).toBeGreaterThan(saved.log + 2);
  await expect.poll(async () => (await seen(g.page)).log.length).toBe(ahead.log);
  await host.page.reload();
  await expect(pm(host.page, 'P-H')).toBeVisible({ timeout: 10_000 });
  await expect(host.page.locator('[data-save]')).toHaveCount(0); // 다시 연 탭은 저장을 새로 시도한다
  const back = await look(host.page);
  expect([back.phase, back.seat]).toEqual(['paused', saved.seat]);
  expect(back.players).toEqual(saved.players);
  expect(back.log).toBeLessThan(ahead.log);
  await expect(pm(g.page, 'P-S')).toBeVisible({ timeout: 15_000 });
  const same = async () => {
    const h = await host.page.evaluate(() => { const s = window.__client.state; return { turn: s.room!.game!.turn.seat, players: s.room!.game!.players.map((p) => ({ coin: p.coin, pos: p.pos })), log: s.log }; });
    const s = await seen(g.page);
    return { h, s: { turn: s.turn, players: s.players, log: s.log }, room: (await look(host.page)).log };
  };
  let x = await same();
  expect(x.s).toEqual(x.h);
  expect(x.s.log).toHaveLength(x.room);
  await expect(g.page.locator('.ov-layer--notice, .cut')).toHaveCount(0); // 사라진 구간의 알림·연출이 남지 않는다
  await resume(host.page);
  await expect(pm(g.page, 'P-S')).toHaveCount(0);
  await passTurn(host.page);
  await expect.poll(async () => (await seen(g.page)).turn).toBe((saved.seat + 1) % 4);
  await expect.poll(async () => { x = await same(); return x.s.log.length === x.room; }).toBe(true);
  expect(x.s.players).toEqual(x.h.players);
  clean([host, g]);
  await closeAll([host, g]);
});

test('P3E18 문항 중 방장 바로 새로고침(2초 안), 학생 1대는 돌아오지 않음: 멈춘 판 · 끊김 표시 · 재개 30초 뒤 로봇', async ({ browser }) => {
  const { host, guests: [g, lost] } = await startGame(browser, site.url, 2);
  await atQuestion(host.page, 1, 11, 15_000, g.page);
  const before = await look(host.page);
  const t0 = Date.now();
  await host.page.goto('about:blank');
  await lost.page.close();
  await host.page.goto(site.url);
  await expect(pm(host.page, 'P-H')).toBeVisible({ timeout: 10_000 });
  test.info().annotations.push({ type: 'host-back-ms', description: String(Date.now() - t0) });
  const back = await look(host.page);
  expect(back.phase).toBe('paused');
  near(back.play, before.play, 1_200, '놀이 시계');
  await expect(pm(g.page, 'P-S')).toBeVisible({ timeout: 15_000 });
  await host.page.waitForTimeout(1_500);
  expect((await look(host.page)).phase).toBe('paused'); // 저절로 이어지지 않는다
  expect((await look(host.page)).seats.map((s) => s.connected)).toEqual([true, true, false, false]);
  expect(await host.page.evaluate(() => window.__client.state.room!.seats[2].connected)).toBe(false);
  await resume(host.page);
  const t1 = Date.now();
  near((await look(host.page)).left, before.left, 1_500, '문항 남은 시간');
  const bot = host.page.locator('.panel[data-seat="2"] .panel-bot');
  await host.page.waitForTimeout(26_500);
  await expect(bot).toHaveCount(0);
  await expect(bot).toBeVisible({ timeout: 8_000 });
  near(Date.now() - t1, 30_000, 3_000, '봇 대체');
  clean([host, g, lost]);
  await closeAll([host, g, lost]);
});

test('P3E19 로그 조각이 깨진 방: 새로고침·코드 입력 둘 다 바로 다시 열지 못했어요, 저장본은 그대로', async ({ browser }) => {
  const { host, guests: [g], code } = await startGame(browser, site.url, 1);
  await closeAll([g]);
  const breakLog = () => host.page.evaluate((k) => localStorage.setItem(k, localStorage.getItem(k)!.slice(0, 9)), `tw.host.${code}.log:000000`);
  await host.page.waitForTimeout(1_200);
  await breakLog();
  const note = host.page.locator('.sc-note');
  const stuck = async () => {
    await expect(note).toContainText('방을 다시 열지 못했어요', { timeout: 5_000 });
    await expect(note.locator('button')).toHaveText(['다시 해 보기', '처음 화면으로']);
    await expect(host.page.locator('.pin-box')).toHaveCount(0);
  };
  await host.page.reload();
  await stuck();
  await note.locator('[data-act="again"]').click();
  await stuck();
  const keys = await hostKeys(host.page, code);
  await note.locator('[data-act="home"]').click();
  await joinCode(host.page, code);
  await stuck();
  await note.locator('[data-act="home"]').click();
  await expect(host.page.locator('[data-act="intro-start"]')).toBeVisible();
  expect(await host.page.evaluate(() => localStorage.getItem('tw.seat'))).toBeNull();
  expect(await hostKeys(host.page, code)).toEqual(keys);
  expect(keys).toContain(`tw.host.${code}.room`);
  await host.page.reload();
  await expect(host.page.locator('[data-act="intro-start"]')).toBeVisible();
  clean([host]);
  await closeAll([host]);
});

test('P5E02 다시 열지 못한 방(failed): 방 코드가 보이고, 처음 화면으로 뒤 그 코드로 방장이 다시 연다', async ({ browser }) => {
  const { host, code } = await startGame(browser, site.url, 0, { init: (p) => p.addInitScript(() => {
    const now = Date.now;
    Date.now = () => now() + ((window as unknown as { __skip?: number }).__skip ?? 0);
  }) });
  await host.page.waitForTimeout(1_200);
  await host.page.goto('about:blank');
  // 다른 기기가 그 연결 ID 를 쥔다
  const squat = new WebSocket(`ws://127.0.0.1:${signal.port}/peerjs?key=peerjs&id=twj1-${code}&token=x`);
  await new Promise((ok, no) => { squat.onmessage = ok; squat.onerror = no; });
  await host.page.goto(site.url);
  const note = host.page.locator('.sc-note');
  await expect(note).toHaveText('방을 다시 여는 중이에요…', { timeout: 15_000 });
  await host.page.waitForTimeout(2_500); // '이미 쓰는 중'이 한 번은 나온 뒤
  await host.page.evaluate(() => { (window as unknown as { __skip: number }).__skip = 100_000; });
  await stuckWithCode(host, code, 'failed');
  const keys = await hostKeys(host.page, code);
  const gone = new Promise((ok) => { squat.onclose = ok; });
  squat.close();
  await gone;
  await note.locator('[data-act="home"]').click();
  await expect(host.page.locator('[data-act="intro-start"]')).toBeVisible();
  expect(await hostKeys(host.page, code)).toEqual(keys);
  await joinCode(host.page, code);
  await expect(pm(host.page, 'P-H')).toBeVisible({ timeout: 15_000 });
  expect((await seen(host.page)).seat).toBe(0);
  clean([host]);
  await closeAll([host]);
});

test('P5E02 다시 열지 못한 방(broken): 방 코드가 보이고 저장본은 그대로', async ({ browser }) => {
  const { host, code } = await startGame(browser, site.url, 0);
  await host.page.waitForTimeout(1_200);
  await host.page.goto('about:blank');
  await host.page.goto(`${site.url}webp/UI-logo.webp`);
  await host.page.evaluate((k) => localStorage.setItem(k, localStorage.getItem(k)!.slice(0, 9)), `tw.host.${code}.log:000000`);
  const keys = await hostKeys(host.page, code);
  await host.page.goto(site.url);
  await stuckWithCode(host, code, 'broken');
  await host.page.locator('.sc-note [data-act="home"]').click();
  await joinCode(host.page, code);
  await stuckWithCode(host, code, null); // 방장 길로 다시 연다(학생 길·자리 번호 화면이 아니다)
  expect(await hostKeys(host.page, code)).toEqual(keys);
  clean([host]);
  await closeAll([host]);
});

test('P5E04 방장 기다림 동안의 소리 = 멈춤과 같다(더킹 .25 + 차임), 이어지면 돌아온다', async ({ browser }) => {
  const { host, guests: [g] } = await startGame(browser, site.url, 1);
  const au = () => g.page.evaluate(() => {
    const a = (window as unknown as { __audio: { current: string | null; duck: number; log: { name: string }[] } }).__audio;
    return { current: a.current, duck: a.duck, chimes: a.log.filter((x) => x.name === 'chime').length };
  });
  await expect.poll(async () => (await au()).current).toBe('bgm.board');
  const idle = await au();
  // 견줄 것: 방장의 멈춤
  await host.page.locator('[data-act="pause"]').click();
  await expect(pm(g.page, 'P-S')).toBeVisible();
  const paused = { current: 'bgm.board', duck: 0.25, chimes: idle.chimes + 1 };
  await expect.poll(au).toEqual(paused);
  await resume(host.page);
  await expect(pm(g.page, 'P-S')).toHaveCount(0);
  await expect.poll(au).toEqual({ current: 'bgm.board', duck: idle.duck, chimes: paused.chimes + 1 });
  const played = await au();
  // 방장 기다림(연결 층이 신호 끊김 6초에 부르는 것)
  await g.page.evaluate(() => (window.__client as unknown as { goAway(): void }).goAway());
  await expect(pm(g.page, 'H-W')).toBeVisible();
  await expect.poll(au).toEqual({ ...paused, chimes: played.chimes + 1 });
  // 새 효과음은 나지 않는다(차임만)
  expect(await g.page.evaluate(() => { const a = (window as unknown as { __audio: { log: unknown[]; playSfx(n: string): void } }).__audio; const n = a.log.length; a.playSfx('bell'); return a.log.length - n; })).toBe(0);
  await hurry(host.page, 60_000);
  await expect(pm(g.page, 'H-W')).toHaveCount(0);
  await expect.poll(au).toEqual({ ...played, chimes: played.chimes + 2 });
  clean([host, g]);
  await closeAll([host, g]);
});

test('P3E20 Web Locks 가 없는 브라우저: 새로고침은 4초 안에 멈춤 모달, 둘째 탭은 4초 안에 다른 창 안내', async ({ browser }) => {
  const noLocks = (p: Page) => p.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => undefined }); });
  const { host, guests: [g], code } = await startGame(browser, site.url, 1, { init: noLocks });
  await host.page.waitForTimeout(1_500);
  await host.page.reload({ waitUntil: 'commit' });
  const note = host.page.locator('.sc-note');
  await expect(note).toHaveText('방을 다시 여는 중이에요…');
  const t0 = Date.now();
  await expect(pm(host.page, 'P-H')).toBeVisible({ timeout: 4_000 });
  test.info().annotations.push({ type: 'reopen-ms', description: String(Date.now() - t0) });
  const first = host.page;
  await resume(first);
  const log = (await look(first)).log;
  const second = await tab(host, { init: noLocks });
  await expect(second.locator('.sc-note')).toContainText('이 방은 다른 창에서 열려 있어요. 그 창에서 계속해 주세요', { timeout: 4_000 });
  await second.locator('.sc-note button').click();
  await joinCode(second, code);
  await expect(second.locator('.sc-note')).toContainText('이 방은 다른 창에서 열려 있어요', { timeout: 4_000 });
  const v = await look(first);
  expect(v.phase).toBe('playing');
  expect(v.log).toBeGreaterThanOrEqual(log);
  await expect(first.locator('.board-root')).toBeVisible();
  clean([host, g]);
  await closeAll([host, g]);
});

for (const who of ['학생', '방장'] as const) for (const off of [60_000, -60_000]) {
  test(`P3E11 ${who} 기기 시계 ${off / 1000}초: 문항 중 학생 새로고침 — 남은 시간 = 방장 ±1초, 답을 방장이 받는다`, async ({ browser }) => {
    const skew = (p: Page) => p.addInitScript((d) => { const real = Date.now; Date.now = () => real() + d; }, off);
    const host = await device(browser, site.url, who === '방장' ? { init: skew } : {});
    await makeRoom(host.page);
    await pick(host.page, 0);
    const code = await readCode(host.page);
    const g = await device(browser, site.url, who === '학생' ? { init: skew } : {});
    await sit(g.page, code, 1);
    await host.page.locator('[data-act="start"]').click();
    await expect(g.page.locator('.board-root')).toBeVisible({ timeout: 15_000 });
    await atQuestion(host.page, 1, 11, 30_000, g.page);
    await g.page.reload();
    await expect(g.page.locator('.qs[data-role="player"]')).toBeVisible({ timeout: 15_000 });
    await g.page.waitForTimeout(500);
    const [shown, v] = await Promise.all([sec(g.page), look(host.page)]);
    expect(v.left).toBeGreaterThan(10_000);
    near(shown, Math.ceil(v.left / 1000), 1, '남은 시간(초)');
    expect(await g.page.locator('.qs [data-choice]:enabled').count()).toBe(4);
    await g.page.locator('.qs [data-choice]:enabled').first().click();
    await expect.poll(async () => (await look(host.page)).step).not.toBe('question');
    clean([host, g]);
    await closeAll([host, g]);
  });
}

test('P3E12 다음 시간: 방장 멈춤 → 전원 탭 닫기 → 방장이 앱을 열고 학생 3대 → 이어 하기 화면 → 이어서 하기, 남은 놀이 시간 그대로', async ({ browser }) => {
  const { host, guests, code } = await startGame(browser, site.url, 3);
  await host.page.locator('[data-act="pause"]').click();
  for (const d of guests) await expect(pm(d.page, 'P-S')).toBeVisible();
  const before = await look(host.page);
  for (const d of [...guests, host]) await d.page.close();
  await tab(host);
  const title = (d: Dev) => d.page.locator('.resume .save-title');
  await expect(title(host)).toHaveText('여기까지 왔어요', { timeout: 10_000 });
  for (const d of guests) {
    await tab(d);
    await expect(title(d)).toHaveText('여기까지 왔어요', { timeout: 15_000 });
    await expect(d.page.locator('.pin-box')).toHaveCount(0);
  }
  const now = await look(host.page);
  expect([now.phase, now.play]).toEqual(['paused', before.play]);
  expect(now.seats.map((s) => [s.connected, s.isBot, s.charId])).toEqual(before.seats.map((s) => [true, false, s.charId]));
  await host.page.locator('[data-act="resume"]').click();
  for (const d of [host, ...guests]) await expect(d.page.locator('.board-root')).toBeVisible({ timeout: 15_000 });
  const v = await look(host.page);
  expect(v.phase).toBe('playing');
  near(v.play, before.play, 3_000, '이어서 한 뒤 놀이 시계');
  expect(code).toBe(await host.page.evaluate(() => window.__host.code));
  clean([host, ...guests]);
  await closeAll([host, ...guests]);
});

test('P3E16 방장 기기의 저장 자리가 다른 방을 가리킴: 자기 코드는 방장으로, 남의 방 자동 복귀는 학생 길', async ({ browser }) => {
  const { host, guests: [g], code } = await startGame(browser, site.url, 1);
  const other = await device(browser, site.url);
  await makeRoom(other.page);
  await pick(other.page, 0);
  const otherCode = await readCode(other.page);
  // 둘째 탭으로 남의 방에 학생으로 들어간다(첫 탭은 방장)
  const first = host.page;
  const second = await tab(host);
  await second.locator('.sc-note button', { hasText: '처음 화면으로' }).click();
  await sit(second, otherCode, 2);
  await first.close();
  await second.reload();
  await expect(second.locator('.lb-slot.is-me')).toHaveAttribute('data-seat', '1', { timeout: 15_000 }); // 남의 방 자동 복귀 = 학생
  expect(await second.evaluate(() => window.__client.state.host)).toBeNull();
  await other.page.close();
  await expect(pm(second, 'H-W')).toBeVisible({ timeout: 10_000 }); // 대기실에서도 방장 기다림
  await second.locator('.pm [data-act="home"]').click();
  await joinCode(second, code);
  await expect(second.locator('.pin-box')).toHaveCount(0);
  await expect(second.locator('.game')).toHaveAttribute('data-seat', '0', { timeout: 10_000 });
  await expect(pm(second, 'P-H')).toBeVisible();
  await expect(pm(g.page, 'P-S')).toBeVisible({ timeout: 20_000 });
  clean([host, g, other]);
  await closeAll([host, g, other]);
});

test('P3E21 만료된 방이 저장소에 있는 채 앱을 엶: 그 방 키 0건, 만료 안 된 방은 그대로', async ({ browser }) => {
  const { host, guests: [g], code } = await startGame(browser, site.url, 1);
  await closeAll([g]);
  await host.page.waitForTimeout(1_200);
  await host.page.goto('about:blank');
  await host.page.goto(`${site.url}webp/UI-logo.webp`); // 같은 출처의 그림: 앱이 돌지 않아 tw.seat 를 다시 쓰지 않는다
  const keep = await host.page.evaluate((c) => {
    const old = 'AAAAAA';
    for (const k of Object.keys(localStorage).filter((k) => k.startsWith(`tw.host.${c}.`))) localStorage.setItem(k.replace(c, old), localStorage.getItem(k)!);
    const room = JSON.parse(localStorage.getItem(`tw.host.${old}.room`)!);
    localStorage.setItem(`tw.host.${old}.room`, JSON.stringify({ ...room, code: old, expiresAt: Date.now() - 1 }));
    localStorage.removeItem('tw.seat');
    return Object.keys(localStorage).filter((k) => k.startsWith(`tw.host.${c}.`)).sort();
  }, code);
  await host.page.goto(site.url);
  await expect(host.page.locator('[data-act="intro-start"]')).toBeVisible();
  expect(await hostKeys(host.page, 'AAAAAA')).toEqual([]);
  expect(await hostKeys(host.page, code)).toEqual(keep);
  expect(keep.length).toBeGreaterThan(2);
  clean([host]);
  await closeAll([host]);
});

test('P3E22 학생 둘이 다시 붙으려 애쓰는 동안 방장 복원: 방장이 자리 0 으로 돌아온 뒤에만 학생 연결, 방장 없이 재개 0', async ({ browser }) => {
  const { host, guests } = await startGame(browser, site.url, 2);
  await host.page.goto('about:blank');
  for (const d of guests) await d.page.evaluate(() => { setInterval(() => window.__client.send({ t: 'resume' }), 150); });
  await host.page.waitForTimeout(3_000);
  // 판이 다시 도는 순간마다 방장이 앉아 있었는지 적는다
  await host.page.addInitScript(() => {
    const w = window as unknown as { __ran: boolean[] };
    w.__ran = [];
    setInterval(() => { const r = window.__host?.room; if (r?.game?.phase === 'playing') w.__ran.push(r.rec!.seats[0].connected && window.__client.state.seat === 0); }, 5);
  });
  await host.page.goto(site.url);
  await expect.poll(() => host.page.evaluate(() => window.__accepts?.length ?? 0), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await host.page.waitForTimeout(2_000);
  expect(await host.page.evaluate(() => window.__accepts!.every((s) => s === 0))).toBe(true);
  expect(await host.page.evaluate(() => (window as unknown as { __ran: boolean[] }).__ran.every(Boolean))).toBe(true);
  for (const d of guests) await expect.poll(async () => (await seen(d.page)).seat).not.toBeNull();
  clean([host, ...guests]);
  await closeAll([host, ...guests]);
});

const SAVE = {
  never: '이 기기에는 놀이를 저장할 수 없어요. 창을 닫으면 이어 할 수 없어요',
  stopped: '지금부터는 놀이가 저장되지 않아요. 창을 닫으면 조금 전으로 돌아가요',
};
const breakStore = () => { Storage.prototype.setItem = () => { throw new DOMException('막힘', 'SecurityError'); }; };

for (const viewport of [{ width: 1366, height: 768 }, { width: 1180, height: 820 }]) for (const save of ['never', 'stopped'] as const) {
  test(`P3bE03 저장이 안 되는 방장의 대기실(${save}, ${viewport.width}×${viewport.height}): 앉은 뒤 한 줄, 띠 0, 알약과 겹침 0 → 판에서는 띠`, async ({ browser }) => {
    const ok = await device(browser, site.url, { viewport });
    await makeRoom(ok.page);
    await readCode(ok.page);
    const height = await tall(ok.page);
    await pick(ok.page, 0);
    await expect(ok.page.locator('[data-k="host-keep"]')).toHaveCount(1);
    await expect(ok.page.locator('[data-save]')).toHaveCount(0);
    const keep = (await ok.page.locator('[data-k="host-keep"]').boundingBox())!;

    const host = await device(browser, site.url, { viewport, ...(save === 'never' ? { init: (p: Page) => p.addInitScript(breakStore) } : {}) });
    const p = host.page;
    await makeRoom(p);
    const code = await readCode(p);
    if (save === 'stopped') await p.evaluate(breakStore);
    await expect.poll(() => p.evaluate(() => window.__client.state.host!.save)).toBe(save);
    await p.waitForTimeout(300);
    const none = async (q: Page, what: string) => { for (const sel of ['[data-save]', '[data-k="host-keep"]', '.net-banner']) await expect(q.locator(sel), `${what} ${sel}`).toHaveCount(0); };
    await none(p, '고르기 전');
    expect(await tall(p)).toBe(height);

    await pick(p, 0);
    const line = p.locator('.lobby-sub[data-save]');
    await expect(line).toHaveText(SAVE[save]);
    await expect(line).toHaveAttribute('data-save', save);
    await expect(p.locator('[data-k="host-keep"]')).toHaveCount(0);
    await expect(p.locator('.net-banner')).toHaveCount(0);
    const at = (await line.boundingBox())!;
    expect([at.y, at.height]).toEqual([keep.y, keep.height]); // host-keep 줄과 같은 자리
    expect(await p.evaluate(() => {
      const pill = document.querySelector('.code-pill')!, a = pill.getBoundingClientRect();
      return [...document.querySelectorAll('.app *')].filter((e) => !e.contains(pill) && !pill.contains(e) && !e.closest('.sc-bg'))
        .filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.left < a.right && b.right > a.left && b.top < a.bottom && b.bottom > a.top; }).map((e) => e.className);
    })).toEqual([]);
    const start = (await p.locator('[data-act="start"]').boundingBox())!;
    if (viewport.width === 1366) {
      expect(await tall(p)).toBeLessThanOrEqual(768);
      expect(start.y + start.height).toBeLessThanOrEqual(768);
    }
    await shot(p, `save-${save}-lobby`);
    const g = await device(browser, site.url, { viewport });
    await sit(g.page, code, 1);
    await none(g.page, '학생');

    await p.locator('[data-act="start"]').click();
    await expect(p.locator('.board-root')).toBeVisible({ timeout: 15_000 });
    await expect(p.locator('.net-banner[data-save]')).toHaveText(SAVE[save]);
    await expect(p.locator('[data-save]')).toHaveCount(1);
    await expect(g.page.locator('[data-save]')).toHaveCount(0);
    clean([ok, host, g]);
    await closeAll([ok, host, g]);
  });
}

test('P3bE08 끝난 판에서 방장이 [처음으로]: 학생은 결과 화면 그대로(띠·방장 기다림 0, 다시 잇기 0), [처음으로]는 첫 화면', async ({ browser }) => {
  const { host, guests: [g] } = await startGame(browser, site.url, 1);
  await passTurn(host.page);
  await finishGame(host.page, [host.page, g.page]);
  const home = (p: Page) => p.getByRole('button', { name: '처음으로' });
  await expect(home(g.page)).toBeVisible();
  const before = await seen(g.page);
  await g.page.evaluate(() => {
    const w = window as unknown as { __bad: string[] };
    w.__bad = [];
    const look = () => { for (const s of ['.net-banner', '.pm']) if (document.querySelector(s)) w.__bad.push(s); if (!document.querySelector('.rs[data-kind="final"]')) w.__bad.push('결과 없음'); };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true });
    setInterval(look, 50);
  });
  const tries = () => g.page.evaluate(() => (window as unknown as { __rtc: unknown[] }).__rtc.length);
  const n = await tries();
  await home(host.page).click();
  await expect(host.page.locator('[data-act="intro-start"]')).toBeVisible();
  await g.page.waitForTimeout(15_000);
  expect(await g.page.evaluate(() => (window as unknown as { __bad: string[] }).__bad)).toEqual([]);
  expect([await g.page.evaluate(() => window.__client.state.conn), await tries()]).toEqual(['idle', n]);
  expect(await seen(g.page)).toEqual(before);
  expect(await g.page.evaluate(() => localStorage.getItem('tw.seat'))).not.toBeNull();
  await home(g.page).click();
  await expect(g.page.locator('[data-act="intro-start"]')).toBeVisible();
  expect(await g.page.evaluate(() => localStorage.getItem('tw.seat'))).toBeNull();
  clean([host, g]);
  await closeAll([host, g]);
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 1180, height: 820 }]) {
  test(`P3bE17 이어 하기·자리 번호 화면에서 방장이 사라짐(${viewport.width}×${viewport.height}): 끊김 띠가 이어질 때까지, 방장 기다림은 판에서만`, async ({ browser }) => {
    const { host, guests: [g, board], code } = await startGame(browser, site.url, 2);
    await host.page.locator('[data-act="pause"]').click();
    await expect(pm(board.page, 'P-S')).toBeVisible();
    await g.page.setViewportSize(viewport);
    await g.page.reload();
    await expect(g.page.locator('.sc--resume')).toBeVisible({ timeout: 15_000 });
    const pin = await device(browser, site.url, { viewport });
    await joinCode(pin.page, code);
    await expect(pin.page.locator('.pin-box')).toBeVisible({ timeout: 15_000 });
    const t0 = Date.now();
    await host.page.goto('about:blank');
    const band = (d: Dev) => d.page.locator('.net-banner');
    for (const d of [g, pin]) await expect(band(d)).toHaveText('연결이 잠깐 끊겼어요. 다시 잇는 중이에요…', { timeout: 7_500 });
    await expect(pm(board.page, 'H-W')).toBeVisible({ timeout: 7_500 });
    await expect(band(board)).toHaveCount(0);
    while (Date.now() - t0 < 21_000) {
      for (const d of [g, pin]) expect([await band(d).count(), await d.page.locator('.pm').count()]).toEqual([1, 0]);
      await g.page.waitForTimeout(200);
    }
    await expect(g.page.locator('.sc--resume')).toBeVisible();
    await expect(pin.page.locator('.pin-box')).toBeVisible();
    await shot(g.page, 'resume-disconnected');
    await host.page.goto(site.url);
    for (const d of [g, pin, board]) await expect(band(d)).toHaveCount(0, { timeout: 25_000 });
    await expect(g.page.locator('.sc--resume')).toBeVisible();
    await expect(pin.page.locator('.pin-box')).toBeVisible();
    await expect(pm(board.page, 'H-W')).toHaveCount(0, { timeout: 25_000 });
    clean([host, g, board, pin]);
    await closeAll([host, g, board, pin]);
  });
}

test('P3bE20 방장 기다림: 알림·컷씬·카드가 나아가지 않다가 이어지면 이어진다. Enter·Space 로 나가지 않고 Tab 으로 단추에 닿는다', async ({ browser }) => {
  const { host, guests: [g] } = await startGame(browser, site.url, 1);
  const p = g.page;
  const on = { notice: p.locator('.ov-layer--notice'), cut: p.locator('.cut'), card: p.locator('.cc') };
  const shown = async () => ({ notice: await on.notice.count(), cut: await on.cut.count(), card: await on.card.count() });
  const away = () => p.evaluate(() => (window.__client as unknown as { goAway(): void }).goAway()); // 연결 층이 신호 끊김 6초에 부르는 것
  const back = async () => { await hurry(host.page, 60_000); await expect(pm(p, 'H-W')).toHaveCount(0); };
  await arrive(host.page, 1, 11);
  await hurry(host.page, 60_000);
  await expect(on.card).toBeVisible({ timeout: 15_000 });
  // 카드 앞에 알림 → 컷씬이 들어와 카드가 다시 열리기를 기다린다
  await host.page.evaluate(() => {
    const room = window.__host.room, r = room as unknown as { run(f: null, b: () => void): void; dirty: boolean };
    r.run(null, () => {
      room.game!.log.push({ ev: 'event', seat: 1, kind: 'travel', payload: {} }, { ev: 'build', seat: 1, tile: 3, level: 4, cost: 0 } as never);
      r.dirty = true;
    });
  });
  await expect(on.notice).toBeVisible();
  await hurry(host.page, 60_000);
  await p.waitForTimeout(300);
  await away();
  await expect(pm(p, 'H-W')).toBeVisible();
  expect(await p.evaluate(() => document.activeElement!.matches('.pm[data-kind="H-W"]'))).toBe(true);
  for (const k of ['Enter', 'Space', 'Enter']) await p.keyboard.press(k);
  await expect(pm(p, 'H-W')).toBeVisible();
  expect((await seen(p)).seat).toBe(1);
  await p.keyboard.press('Tab');
  expect(await p.evaluate(() => (document.activeElement as HTMLElement).dataset.act)).toBe('home');
  await p.waitForTimeout(6_000); // 알림 3.2초보다 길게
  expect(await shown()).toEqual({ notice: 1, cut: 0, card: 0 });
  await back();
  await p.waitForTimeout(1_000);
  expect(await shown()).toEqual({ notice: 1, cut: 0, card: 0 }); // 남은 시간만큼 더
  await expect(on.cut).toBeVisible({ timeout: 6_000 });
  await expect(on.notice).toHaveCount(0);
  await p.waitForTimeout(500);
  await away();
  await p.waitForTimeout(8_000); // 컷씬 길이보다 길게
  expect(await shown()).toEqual({ notice: 0, cut: 1, card: 0 });
  await back();
  await expect(on.cut).toHaveCount(0, { timeout: 8_000 });
  await expect(on.card).toBeVisible();
  // 대기실 모달도 같은 상자: 실제 끊김에서 처음 초점
  await host.page.goto('about:blank');
  await expect(pm(p, 'H-W')).toBeVisible({ timeout: 8_000 });
  await p.keyboard.press('Space');
  await p.keyboard.press('Enter');
  await expect(pm(p, 'H-W')).toBeVisible();
  clean([host, g]);
  await closeAll([host, g]);
});
