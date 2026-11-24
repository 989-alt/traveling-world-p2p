// P2P-3(PRD §6 S15): 진짜 앱 + 로컬 시그널링(127.0.0.1) + 빈 iceServers. 방장 탭이 방을 돌리고 학생 기기가 직접 붙는다. 공용 주소 0.
import { expect, test } from '@playwright/test';
import { joinCode, openMake } from './helpers/entry';
import { serveApp, startSignaling, type RtcSeen } from './helpers/p2p';
import { arrive, atQuestion, closeAll, device, finishGame, look, makeRoom, passTurn, pick, pm, readCode, seen, shot, sit, startGame, tab, tall, timeout } from './helpers/p2p-game';

test.describe.configure({ mode: 'serial' });
test.skip(() => test.info().project.name === 'tablet-touch', '기기 크기와 무관 — 데스크톱 한 번');
test.setTimeout(90_000);

let signal: Awaited<ReturnType<typeof startSignaling>>;
let site: Awaited<ReturnType<typeof serveApp>>;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  signal = await startSignaling();
  site = await serveApp(signal.port);
});
test.afterAll(async () => { await site?.close(); await signal?.stop(); });

interface StateLike { t: string; cards?: unknown[]; game?: { turn: { step: string; question: object | null; tf: object | null } } | null }
/** 학생 기기가 채널로 받은 프레임 → 게임 메시지(조각은 합친다) */
function messages(got: string[]): StateLike[] {
  const out: string[] = [];
  const parts = new Map<number, string[]>();
  for (const raw of got) {
    const f = JSON.parse(raw) as { t: string; d: string; id: number; i: number; n: number };
    if (f.t === 'm') out.push(f.d);
    if (f.t !== 'p') continue;
    const p = parts.get(f.id) ?? [];
    p[f.i] = f.d;
    parts.set(f.id, p);
    if (p.filter((x) => x !== undefined).length === f.n) out.push(p.join(''));
  }
  return out.map((d) => JSON.parse(d) as StateLike);
}

test('P3E01 4기기 한 바퀴: 입장 → 출발 → 도착 문항·해설·참/거짓, 학생 프레임에 정답 0, 중계 0, 바깥 0', async ({ browser }) => {
  const { host, guests } = await startGame(browser, site.url, 3);
  const all = [host, ...guests];
  // 방장용 파일(Room·정답)은 방장만 받는다
  const chunks = (d: typeof host) => d.page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/host-net-')).length);
  expect(await chunks(host)).toBeGreaterThan(0);
  for (const d of guests) expect(await chunks(d)).toBe(0);
  await atQuestion(host.page, 1, 11, 20_000, guests[0].page); // 이탈리아, 학생(자리 1)이 도착
  for (const d of [host, guests[1], guests[2]]) await expect(d.page.locator('.qs')).toHaveAttribute('data-role', 'spectator', { timeout: 10_000 });
  const q = (await look(host.page)).question!;
  expect(typeof q.answer).toBe('number');
  await guests[0].page.locator(`.qs .ov-ans[data-choice="${q.answer}"]`).click();
  for (const d of all) await expect(d.page.locator('.ex')).toBeVisible({ timeout: 10_000 });
  // 해설 7초를 다 그린 네 기기(방장 포함)가 신호를 보낸다
  await expect.poll(async () => (await look(host.page)).step, { timeout: 15_000 }).toBe('tf');
  const ex = await host.page.evaluate(() => window.__host.room.game!.log.findLast((e) => e.ev === 'explanation'));
  expect((ex as unknown as { shownTo: boolean[] }).shownTo).toEqual([true, true, true, true]);
  for (const d of [host, guests[1], guests[2]]) await expect(d.page.locator('.ex-tf-btn')).toHaveCount(2);
  await expect(guests[0].page.locator('.ex-tf-btn')).toHaveCount(0);
  await host.page.locator('.ex-tf-btn[data-tf="true"]').click();
  await guests[1].page.locator('.ex-tf-btn[data-tf="false"]').click();
  await guests[2].page.locator('.ex-tf-btn[data-tf="true"]').click();
  await expect.poll(async () => (await look(host.page)).step, { timeout: 15_000 }).not.toMatch(/^tf/);
  // 참/거짓 결과를 네 기기가 같은 로그로
  const log = await host.page.evaluate(() => window.__host.room.game!.log.length);
  for (const d of all) await expect.poll(async () => (await seen(d.page)).log.length).toBeGreaterThanOrEqual(log);
  await arrive(host.page, 2, 4); // 다음 사람도 돈다
  await expect.poll(async () => (await seen(guests[2].page)).turn).toBe(2);
  await timeout(host.page);

  const rtcOf = (d: typeof host) => d.page.evaluate(() => (window as unknown as { __rtc: RtcSeen[] }).__rtc.map(({ config, negotiated, state, candidates, got }) => ({ config, negotiated, state, candidates, got })));
  for (const d of guests) {
    const ms = (await rtcOf(d)).flatMap((r) => messages(r.got));
    const states = ms.filter((m) => m.t === 'state' && m.game);
    const at = (st: string) => states.filter((m) => m.game!.turn.step === st);
    expect(at('question').length).toBeGreaterThan(0);
    expect(at('explanation').length).toBeGreaterThan(0);
    expect(at('tf').length).toBeGreaterThan(0);
    for (const m of at('question')) {
      expect('answer' in m.game!.turn.question!).toBe(false);
      expect('cardId' in m.game!.turn.question!).toBe(false);
      expect(m.cards).toEqual([]);
    }
    for (const m of at('tf')) expect(m.game!.turn.tf === null || !('answer' in m.game!.turn.tf)).toBe(true);
    for (const m of at('tfResult')) expect('answer' in m.game!.turn.tf!).toBe(true); // 검사식이 헛돌지 않게
  }
  for (const d of all) {
    const rtc = await rtcOf(d);
    const used = rtc.filter((r) => r.negotiated);
    expect(used).toHaveLength(d === host ? 3 : 1);
    for (const r of used) expect([r.config, r.state]).toEqual([{ iceServers: [] }, 'connected']);
    expect(rtc.filter((r) => !r.negotiated).map((r) => [r.state, r.candidates])).toEqual([['closed', []]]);
    for (const n of d.net) {
      expect(n.outside).toEqual([]);
      expect(n.ws.length).toBeGreaterThan(0);
      expect(n.ws.every((u) => u.startsWith(`ws://127.0.0.1:${signal.port}/`))).toBe(true);
    }
    expect(d.errors).toEqual([]);
  }
  await closeAll(all);
});

test('P3E02 방장이 고르기 전에 온 학생: 기다리다 방장이 고른 직후 자리 1, 출발·멈춤은 방장만', async ({ browser }) => {
  const host = await device(browser, site.url);
  await makeRoom(host.page);
  const code = await readCode(host.page);
  const guest = await device(browser, site.url);
  await joinCode(guest.page, code);
  await guest.page.locator('.pick[data-char="3"]').click();
  await guest.page.waitForTimeout(1_500);
  await expect(guest.page.locator('.lb-slot.is-me')).toHaveCount(0);
  await expect(guest.page.locator('[data-k="host-keep"]')).toHaveCount(0);
  await pick(host.page, 0);
  await expect(host.page.locator('[data-k="host-keep"]')).toHaveText('이 기기가 방을 지켜요. 놀이가 끝날 때까지 이 창을 닫거나 다른 앱으로 가지 마세요');
  await expect(guest.page.locator('.lb-slot.is-me')).toHaveAttribute('data-seat', '1');
  await expect(host.page.locator('.lb-slot.is-me')).toHaveAttribute('data-seat', '0');
  expect(await guest.page.evaluate(() => window.__client.state.room!.hostSeat)).toBe(0);
  await expect(guest.page.locator('[data-act="start"]')).toHaveCount(0);
  await host.page.locator('[data-act="start"]').click();
  for (const d of [host, guest]) await expect(d.page.locator('.board-root')).toBeVisible({ timeout: 15_000 });
  await expect(host.page.locator('[data-act="pause"]')).toBeVisible();
  await expect(guest.page.locator('[data-act="pause"]')).toHaveCount(0);
  await expect(guest.page.locator('[data-act="leave-sign"]')).toBeVisible();
  await closeAll([host, guest]);
});

test('P3E07 시그널링을 끈 채 방 만들기: 대기실 → 안내 + 다시 연결해 보기, 로봇과 출발 · 켜고 다시 연결하면 코드가 보이고 친구가 들어온다', async ({ browser }) => {
  const sig = await startSignaling();
  const own = await serveApp(sig.port);
  await sig.stop();
  let back: typeof sig | null = null;
  try {
    const lock = { init: async (p: import('@playwright/test').Page) => p.addInitScript(() => {
      const w = window as unknown as { __wake: string[] };
      w.__wake = [];
      Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => { w.__wake.push('ask'); return { release: async () => { w.__wake.push('release'); } }; } } });
    }) };
    const wake = (p: import('@playwright/test').Page) => p.evaluate(() => (window as unknown as { __wake: string[] }).__wake);
    // ⓐ 로봇과 시작
    const a = await device(browser, own.url, lock);
    expect(await wake(a.page)).toEqual([]); // 첫 화면에서는 화면 꺼짐 방지를 요청하지 않는다
    await makeRoom(a.page);
    const pill = a.page.locator('.code-pill');
    await expect(pill).toContainText('친구 기기와 연결할 수 없어요. 인터넷이나 학교 와이파이를 확인해 주세요', { timeout: 17_000 });
    await expect(pill).toContainText('로봇과 함께라면 지금 시작할 수 있어요');
    await expect(a.page.locator('[data-act="net-again"]')).toHaveText('다시 연결해 보기');
    await expect(a.page.locator('.code-box')).toHaveCount(0);
    expect(await wake(a.page)).toEqual(['ask']);
    await pick(a.page, 0);
    await expect(a.page.locator('[data-act="start"]')).toBeEnabled();
    await a.page.locator('[data-act="start"]').click();
    await expect(a.page.locator('.board-root')).toBeVisible({ timeout: 15_000 });
    expect((await look(a.page)).seats.map((s) => s.isBot)).toEqual([false, true, true, true]);
    await arrive(a.page, 0, 4);
    await expect.poll(async () => { if ((await look(a.page)).seat === 0) await timeout(a.page); return (await look(a.page)).seat; }, { timeout: 30_000 }).toBe(1);
    // 로봇 차례도 저절로 돈다
    await expect.poll(() => a.page.evaluate(() => window.__host.room.game!.log.some((e) => e.ev === 'dice' && e.seat === 1)), { timeout: 30_000 }).toBe(true);
    // ⓑ 대기실에서 다시 연결
    const b = await device(browser, own.url);
    await makeRoom(b.page);
    await expect(b.page.locator('[data-act="net-again"]')).toBeVisible({ timeout: 17_000 });
    await pick(b.page, 0);
    back = await startSignaling(sig.port);
    await b.page.locator('[data-act="net-again"]').click();
    const code = await readCode(b.page);
    const g = await device(browser, own.url);
    await sit(g.page, code, 2);
    await expect(b.page.locator('.lb-slot[data-seat="1"] .lb-slot-state')).toHaveText('준비됐어요');
    for (const d of [a, b, g]) { expect(d.errors).toEqual([]); for (const n of d.net) expect(n.outside).toEqual([]); }
    await closeAll([a, b, g]);
  } finally {
    await back?.stop();
    await own.close();
  }
});

test('P3E08 꺼진 방장의 코드로 입장: 20초(±2초)에 안내 + 처음 화면으로, 재시도는 계속되어 방장이 켜지면 대기실로', async ({ browser }) => {
  const host = await device(browser, site.url);
  await makeRoom(host.page);
  await pick(host.page, 0);
  const code = await readCode(host.page);
  await host.page.close();
  const guest = await device(browser, site.url);
  await joinCode(guest.page, code);
  const t0 = Date.now();
  const note = guest.page.locator('.sc-note');
  await guest.page.waitForTimeout(17_500 - (Date.now() - t0));
  await expect(note.locator('p')).toHaveText('방에 들어가는 중이에요…');
  await expect(note).toHaveText(/^방에 들어갈 수 없어요\. 코드가 맞는지, 방장 기기가 켜져 있는지 확인해 주세요\. 학교 와이파이에서 안 되면 선생님께 알려 주세요/, { timeout: 4_500 });
  expect(Math.abs(Date.now() - t0 - 20_000)).toBeLessThan(2_000);
  await expect(note.locator('button')).toHaveText('처음 화면으로');
  await tab(host); // 방장이 앱을 다시 연다 → 저장 자리로 자동 복귀
  await expect(host.page.locator('.lb-slot.is-me')).toBeVisible({ timeout: 15_000 });
  expect(await readCode(host.page)).toBe(code);
  await expect(guest.page.locator('.lb-slot')).toHaveCount(4, { timeout: 20_000 });
  // 없는 코드: 같은 안내, 처음 화면으로
  const lone = await device(browser, site.url);
  await joinCode(lone.page, 'ZZZZZZ');
  await expect(lone.page.locator('.sc-note')).toContainText('방에 들어갈 수 없어요', { timeout: 22_000 }); // 단추는 처음부터 있다(P5E01)
  await expect(lone.page.locator('.sc-note button')).toBeVisible({ timeout: 22_000 });
  await lone.page.locator('.sc-note button').click();
  await expect(lone.page.locator('[data-act="intro-start"]')).toBeVisible();
  for (const d of [host, guest, lone]) expect(d.errors).toEqual([]);
  await closeAll([host, guest, lone]);
});

test('P3E26 방이 받아 주지 않는 학생(7번째 연결): 연결은 열리지만 20초에 안내', async ({ browser }) => {
  const host = await device(browser, site.url);
  await makeRoom(host.page);
  await pick(host.page, 0);
  const code = await readCode(host.page);
  const guests = [];
  for (let i = 0; i < 6; i++) {
    const g = await device(browser, site.url);
    await joinCode(g.page, code);
    await expect(g.page.locator('.lb-slot')).toHaveCount(4, { timeout: 15_000 });
    guests.push(g);
  }
  const seventh = await device(browser, site.url);
  await joinCode(seventh.page, code);
  const t0 = Date.now();
  await expect(seventh.page.locator('.sc-note')).toContainText('방에 들어갈 수 없어요', { timeout: 23_000 }); // 단추는 처음부터 있다(P5E01)
  await expect(seventh.page.locator('.sc-note button')).toBeVisible();
  expect(Math.abs(Date.now() - t0 - 20_000)).toBeLessThan(2_000);
  const tries = await seventh.page.evaluate(() => (window as unknown as { __rtc: RtcSeen[] }).__rtc.filter((r) => r.negotiated).length);
  expect(tries).toBeGreaterThanOrEqual(3); // 0 · 0.5 · 1.5 · 3.5 · 7.5 · 15.5초
  expect(tries).toBeLessThanOrEqual(7);
  await expect(pm(guests[0].page, 'H-W')).toHaveCount(0);
  await closeAll([host, ...guests, seventh]);
});

for (const viewport of [{ width: 1366, height: 768 }, { width: 1180, height: 820 }]) {
  test(`P3bE04 대기실 부제(60분 방, ${viewport.width}×${viewport.height}): 코드가 보일 때만 친구에게 코드를 알려 주세요`, async ({ browser }) => {
    /** 시그널링: hang = 답 없음, taken = 이미 쓰는 ID, pass = 그대로 */
    let mode: 'hang' | 'taken' | 'pass' = 'hang';
    const host = await device(browser, site.url, { viewport, init: (p) => p.routeWebSocket(`ws://127.0.0.1:${signal.port}/**`, (ws) => {
      if (mode === 'pass') ws.connectToServer();
      else if (mode === 'taken') ws.send(JSON.stringify({ type: 'ID-TAKEN', payload: { msg: 'ID is taken' } }));
    }) });
    const p = host.page;
    await openMake(p);
    await p.locator('.peg[data-minutes="60"]').click();
    await p.locator('[data-act="make"]').click();
    const sub = p.locator('.lobby-sub').first();
    const net = () => p.evaluate(() => window.__client.state.host!.net);
    const line = async () => { const b = (await sub.boundingBox())!; return [b.y, b.height, await sub.evaluate((e) => e === (window as unknown as { __sub: Element }).__sub)]; };
    await expect(p.locator('.code-pill')).toHaveText('코드를 준비하고 있어요…');
    await expect(sub).toHaveText('60분 놀이');
    await sub.evaluate((e) => { (window as unknown as { __sub: Element }).__sub = e; });
    let at = await line();
    const again = async (next: typeof mode) => { mode = next; await p.locator('[data-act="net-again"]').click(); };
    await expect.poll(net, { timeout: 17_000 }).toBe('offline');
    await expect(sub).toHaveText('60분 놀이');
    expect(await line()).toEqual(at);
    await pick(p, 0); // 고르기 줄이 걷히면 대기실 전체가 내려온다(가운데 맞춤) → 다시 잰다
    at = await line();
    await shot(p, 'lobby-offline');
    expect(await p.locator('.code-pill [role="status"] button').count()).toBe(0); // 단추는 알림 글 밖에
    await again('taken');
    await expect.poll(net, { timeout: 17_000 }).toBe('failed');
    await expect(sub).toHaveText('60분 놀이');
    expect(await line()).toEqual(at);
    await again('pass');
    const code = await readCode(p);
    await expect(sub).toHaveText('60분 놀이 · 친구에게 코드를 알려 주세요');
    expect(await line()).toEqual(at);
    const g = await device(browser, site.url, { viewport });
    await joinCode(g.page, code);
    await expect(g.page.locator('.lobby-sub')).toHaveText('60분 놀이 · 친구에게 코드를 알려 주세요', { timeout: 15_000 });
    await closeAll([host, g]);
  });
}

test('P3bE05 저장이 되는 방장(1366×768): 안내 줄은 고른 뒤에만, 고르기 단계 높이는 P2P-3 그대로, 고른 뒤 스크롤 0', async ({ browser }) => {
  const host = await device(browser, site.url);
  await makeRoom(host.page);
  await readCode(host.page);
  const keep = host.page.locator('[data-k="host-keep"]');
  await expect(keep).toHaveCount(0);
  expect(await tall(host.page)).toBe(781); // P2P-3 보고서의 값(781 > 768)
  await pick(host.page, 0);
  await expect(keep).toHaveText('이 기기가 방을 지켜요. 놀이가 끝날 때까지 이 창을 닫거나 다른 앱으로 가지 마세요');
  await expect(host.page.locator('.net-banner')).toHaveCount(0);
  expect(await tall(host.page)).toBeLessThanOrEqual(768);
  await closeAll([host]);
});

test('P3bE21 화면 꺼짐 방지: 대기실·판에서 한 번 잡아 유지, 결과에서 놓고, 첫 화면에서 다시 잡지 않는다', async ({ browser }) => {
  const lock = { init: (p: import('@playwright/test').Page) => p.addInitScript(() => {
    const w = window as unknown as { __wake: string[] };
    w.__wake = [];
    Object.defineProperty(navigator, 'wakeLock', { value: { request: async () => { w.__wake.push('ask'); return { release: async () => { w.__wake.push('release'); } }; } } });
  }) };
  const host = await device(browser, site.url, lock);
  const wake = () => host.page.evaluate(() => (window as unknown as { __wake: string[] }).__wake);
  expect(await wake()).toEqual([]);
  await makeRoom(host.page);
  await expect.poll(wake).toEqual(['ask']);
  await pick(host.page, 0);
  await host.page.locator('[data-act="start"]').click();
  await expect(host.page.locator('.board-root')).toBeVisible({ timeout: 15_000 });
  await passTurn(host.page);
  expect(await wake()).toEqual(['ask']);
  await finishGame(host.page, [host.page]);
  await expect.poll(wake).toEqual(['ask', 'release']);
  await host.page.getByRole('button', { name: '처음으로' }).click();
  await expect(host.page.locator('[data-act="intro-start"]')).toBeVisible();
  await host.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await host.page.waitForTimeout(1_000);
  expect(await wake()).toEqual(['ask', 'release']);
  await closeAll([host]);
});

test('P3bE18 방을 만드는 사이(2초) 뒤로: 첫 화면 그대로, 늦게 온 방은 저장본도 남지 않는다', async ({ browser }) => {
  const d = await device(browser, site.url, { init: (p) => p.addInitScript(() => {
    const request = navigator.locks.request.bind(navigator.locks) as (...a: unknown[]) => Promise<unknown>;
    navigator.locks.request = (async (...a: unknown[]) => { await new Promise((ok) => setTimeout(ok, 2_000)); (window as unknown as { __late: boolean }).__late = true; return request(...a); }) as typeof navigator.locks.request;
  }) });
  await openMake(d.page);
  await d.page.locator('[data-act="make"]').click();
  await d.page.locator('.sp-back').click();
  await expect(d.page.locator('[data-act="to-join"]')).toBeVisible();
  await d.page.waitForFunction(() => (window as unknown as { __late?: boolean }).__late);
  await d.page.waitForTimeout(1_500);
  await expect(d.page.locator('[data-act="to-join"]')).toBeVisible();
  await expect(d.page.locator('.app')).toHaveAttribute('data-phase', 'entry');
  expect(await d.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('tw.')))).toEqual([]);
  expect(d.net.flatMap((n) => n.ws)).toEqual([]); // 등록 0
  expect(d.errors).toEqual([]);
  await closeAll([d]);
});

test('P3bE16 저장 자리로 자동 복귀했는데 방장이 없음: 20초 안내의 [처음 화면으로]는 저장 자리를 남긴다', async ({ browser }) => {
  const seat = JSON.stringify({ roomCode: 'ABCDEF', seatNo: 2, seatPin: '0420' });
  const d = await device(browser, site.url, { init: (p) => p.addInitScript((v) => localStorage.setItem('tw.seat', v), seat) });
  const home = d.page.locator('.sc-note [data-act="home"]');
  await expect(d.page.locator('.sc-note')).toContainText('방에 들어갈 수 없어요', { timeout: 23_000 }); // 단추는 처음부터 있다(P5E01)
  await expect(home).toBeVisible({ timeout: 23_000 });
  await home.click();
  await expect(d.page.locator('[data-act="intro-start"]')).toBeVisible();
  expect(await d.page.evaluate(() => localStorage.getItem('tw.seat'))).toBe(seat);
  await closeAll([d]);
});

test('P5E01 아직 못 붙은 학생(코드 입력 · 자동 복귀): [처음 화면으로]는 바로 첫 화면, 저장 자리 그대로, 다시 잇는 시도 0', async ({ browser }) => {
  const seat = JSON.stringify({ roomCode: 'ABCDEF', seatNo: 2, seatPin: '0420' });
  const typed = await device(browser, site.url);
  await joinCode(typed.page, 'ZZZZZZ');
  const back = await device(browser, site.url, { init: (p) => p.addInitScript((v) => localStorage.setItem('tw.seat', v), seat) });
  const devs = [typed, back];
  for (const d of devs) {
    await expect(d.page.locator('.sc-note p')).toHaveText('방에 들어가는 중이에요…');
    await expect(d.page.locator('.sc-note button')).toHaveText(['처음 화면으로']);
  }
  await shot(back.page, 'joining');
  await back.page.setViewportSize({ width: 1180, height: 820 });
  await shot(back.page, 'joining');
  for (const d of devs) {
    await d.page.locator('.sc-note [data-act="home"]').click();
    await expect(d.page.locator('[data-act="intro-start"]')).toBeVisible();
  }
  const tries = () => Promise.all(devs.map(async (d) => [d.net[0].ws.length, await d.page.evaluate(() => (window as unknown as { __rtc: unknown[] }).__rtc.length)]));
  await typed.page.waitForTimeout(1_000); // 이미 나간 시도가 끝난 뒤부터 센다
  const n = await tries();
  await typed.page.waitForTimeout(21_000); // 다시 잇기 간격(최대 10초)·20초 안내보다 길게
  expect(await tries()).toEqual(n);
  for (const d of devs) {
    await expect(d.page.locator('[data-act="intro-start"]')).toBeVisible();
    expect(await d.page.evaluate(() => { const s = window.__client.state; return [s.code, s.conn, s.late]; })).toEqual([null, 'idle', false]);
    expect(d.errors).toEqual([]);
  }
  expect(await typed.page.evaluate(() => localStorage.getItem('tw.seat'))).toBeNull();
  expect(await back.page.evaluate(() => localStorage.getItem('tw.seat'))).toBe(seat);
  await closeAll(devs);
});
