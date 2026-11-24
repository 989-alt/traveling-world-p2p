// P2P-4(PRD §6 S14): 업체가 받은 폴더를 하위 경로에 올린 꼴. 납품과 같은 설정(vite.config.ts)으로 지은 묶음 + 작은 정적 서버.
// 시그널링 주소만 README 가 적은 환경 변수(VITE_TW_*)로 이 기기의 로컬 서버로 바꾼다 — 바깥으로 나가지 않는다.
import { execFile } from 'node:child_process';
import { rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { recordOutside, startSignaling } from './helpers/p2p';
import { makeRoom, pick, readCode } from './helpers/p2p-game';
import { ROOT } from './helpers/room-server';
import { serveUnder } from './helpers/static-server';

const SUB = '/sub/dir/';
const OUT = join(tmpdir(), `tw-p2p-static-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);

test.skip(() => test.info().project.name === 'tablet-touch', '기기 크기와 무관 — 데스크톱 한 번');
test.setTimeout(90_000);

let signal: Awaited<ReturnType<typeof startSignaling>>;
let site: Awaited<ReturnType<typeof serveUnder>>;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  signal = await startSignaling();
  const env = { ...process.env, VITE_TW_NET: 'peer', VITE_TW_PEER_HOST: '127.0.0.1', VITE_TW_PEER_PORT: String(signal.port), VITE_TW_PEER_SECURE: 'false', VITE_TW_ICE_SERVERS: '[]' };
  await promisify(execFile)('npx', ['vite', 'build', '--outDir', OUT, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, env });
  // 그림·소리는 vite.config.ts 의 복사 플러그인이 (outDir 과 상관없이) dist 에 놓은 것 = 납품 목록 그대로
  for (const d of ['webp', 'audio']) symlinkSync(`${ROOT}dist/${d}`, join(OUT, d), 'dir');
  site = await serveUnder(OUT, SUB);
});
test.afterAll(async () => { await site?.close(); await signal?.stop(); rmSync(OUT, { recursive: true, force: true }); });

for (const [name, entry] of [['뒤 슬래시 주소', SUB], ['index.html 직접', `${SUB}index.html`]]) {
  test(`P4E01 하위 경로(${name}): 첫 화면 → 방 만들기 → 캐릭터 → 출발 → 판, 404 0, /sub/dir/ 밖 0, /api/ 0`, async ({ page }) => {
    site.log.length = 0;
    const { outside, ws } = await recordOutside(page);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // 서버가 못 본 것(다른 출처로 간 요청)까지: 페이지가 낸 http 요청 전부
    const asked: string[] = [];
    page.on('request', (r) => { if (r.url().startsWith('http') && !/(googleapis|gstatic)\.com/.test(r.url())) asked.push(r.url()); });

    await page.goto(site.origin + entry);
    await makeRoom(page); // 간판·팝업 나무판은 CSS 변수로 넘긴 그림(url)
    await pick(page, 0);
    await readCode(page); // 환경 변수로 넣은 시그널링 주소에 등록됐다
    await expect(page.locator('.lb-slot-state', { hasText: '로봇이 함께해요' })).toHaveCount(3);
    await page.locator('[data-act="start"]').click();
    await expect(page.locator('.board-root')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.bc-sprite').first()).toBeVisible();
    // 판을 연 뒤에 이어 받는 그림까지 다 온 다음에 센다(networkidle 은 첫 화면에서 이미 지나가 다시 기다리지 않는다)
    let last = -1;
    await expect.poll(() => { const still = site.log.length === last; last = site.log.length; return still; }, { intervals: [1_500], timeout: 30_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => [...document.images].filter((i) => i.currentSrc && !(i.complete && i.naturalWidth > 0)).map((i) => i.currentSrc))).toEqual([]);

    // 브라우저가 창 없이는 안 받는 것 둘은 주소를 풀어 직접 받는다
    for (const rel of ['manifest', 'apple-touch-icon']) {
      const href = await page.locator(`link[rel="${rel}"]`).evaluate((l) => (l as HTMLLinkElement).href);
      expect(href.startsWith(site.origin + SUB), href).toBe(true);
      expect((await page.request.get(href)).status(), href).toBe(200);
    }

    const seen = (re: RegExp) => site.log.filter((l) => l.status === 200 && re.test(l.path)).length;
    await expect.poll(() => seen(/\/audio\/BGM[^/]*\.mp3$/)).toBeGreaterThan(0);
    await expect.poll(() => seen(/\/audio\/SFX[^/]*\.mp3$/)).toBeGreaterThan(10);
    expect(seen(/\/webp\/.+\.webp$/)).toBeGreaterThan(50); // 칸 30 + 광장·캐릭터·간판
    expect(seen(/\/assets\/host-net-[^/]+\.js$/)).toBe(1);
    expect(site.log.filter((l) => l.status !== 200)).toEqual([]);
    expect(site.log.filter((l) => !l.path.startsWith(SUB))).toEqual([]);
    expect(asked.filter((u) => !u.startsWith(site.origin + SUB))).toEqual([]);
    expect([...asked, ...ws].filter((u) => u.includes('/api/'))).toEqual([]);
    expect(outside).toEqual([]);
    expect(ws.map((u) => new URL(u).host)).toEqual([`127.0.0.1:${signal.port}`]);
    expect(errors).toEqual([]);
  });
}

test('P4E01 CSS 변수로 넘긴 그림 주소는 스타일 파일(assets/)이 아니라 /sub/dir/webp/ 를 가리킨다', async ({ page }) => {
  await recordOutside(page);
  await page.goto(site.origin + SUB);
  await page.locator('[data-act="intro-start"]').click();
  await expect(page.locator('[data-act="to-make"]')).toBeVisible();
  const urls = await page.evaluate(() => [...document.querySelectorAll('*')].flatMap((e) => {
    const s = getComputedStyle(e);
    return [s.borderImageSource, s.backgroundImage, s.maskImage].flatMap((v) => [...v.matchAll(/url\("([^"]+\.webp)"\)/g)].map((m) => m[1]));
  }));
  expect(urls.length).toBeGreaterThan(0);
  expect(urls.filter((u) => !u.startsWith(`${site.origin}${SUB}webp/`))).toEqual([]);
});

test('P4E02 manifest 의 start_url·scope 는 /sub/dir/, 아이콘은 /sub/dir/webp/UI-logo.webp(200)', async ({ page }) => {
  await recordOutside(page);
  await page.goto(site.origin + SUB);
  const cdp = await page.context().newCDPSession(page);
  const m = await cdp.send('Page.getAppManifest'); // 브라우저가 실제로 읽은 manifest
  expect([m.url.startsWith(site.origin + SUB), m.errors]).toEqual([true, []]);
  const raw = JSON.parse(m.data!) as { start_url: string; scope: string; icons: { src: string }[] };
  const path = (u: string) => new URL(u, m.url).pathname;
  expect([path(raw.start_url), path(raw.scope), raw.icons.map((i) => path(i.src))]).toEqual([SUB, SUB, [`${SUB}webp/UI-logo.webp`]]);
  const icon = await page.request.get(new URL(raw.icons[0].src, m.url).href);
  expect([icon.status(), icon.headers()['content-type']]).toEqual([200, 'image/webp']);
});
