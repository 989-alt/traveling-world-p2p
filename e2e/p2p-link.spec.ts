// P2P-2: 진짜 브라우저 2개 + 로컬 시그널링(127.0.0.1) + 빈 iceServers 로 방장 탭의 방에 붙는다. 공용 시그널링·STUN 0.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { recordOutside, recordRtc, servePage, startSignaling, type RtcSeen } from './helpers/p2p';

test.describe.configure({ mode: 'serial' });

let signal: Awaited<ReturnType<typeof startSignaling>>;
let site: Awaited<ReturnType<typeof servePage>>;
test.beforeAll(async () => {
  test.setTimeout(120_000);
  signal = await startSignaling();
  site = await servePage(signal.port);
});
test.afterAll(async () => { await site?.close(); await signal?.stop(); });

interface HostH { code: string; states: string[]; conns: unknown[]; sent: number; closed: number; start(): void; bigLog(n: number): void; seat1(): boolean; stop(): Promise<void> }
interface GuestH { status: string[]; closes: (number | null)[]; types: string[]; biggest: number; silent: boolean[]; say(m: unknown): void; leave(): void }
const H = (p: Page) => p.evaluate(() => { const { code, states, conns, sent, closed } = (window as unknown as { __p2p: HostH }).__p2p; return { code, states, conns: conns.length, sent, closed }; });
const G = (p: Page) => p.evaluate(() => { const { status, closes, types, biggest, silent } = (window as unknown as { __p2p: GuestH }).__p2p; return { status, closes, types, biggest, silent }; });
const ready = (p: Page) => p.waitForFunction(() => !!(window as unknown as { __p2p?: unknown }).__p2p);

async function link(a: Browser, b: Browser, url = site.url) {
  const host = await (await a.newContext()).newPage();
  const guest = await (await b.newContext()).newPage();
  const errors: string[] = [];
  const net = [];
  for (const p of [host, guest]) {
    p.on('pageerror', (e) => errors.push(e.message));
    await recordRtc(p);
    net.push(await recordOutside(p));
  }
  await host.goto(`${url}?role=host`);
  await ready(host);
  await expect.poll(async () => (await H(host)).states, { timeout: 15_000 }).toEqual(['open']);
  await guest.goto(`${url}?role=guest&code=${(await H(host)).code}`);
  await ready(guest);
  await expect.poll(async () => (await G(guest)).types, { timeout: 20_000 }).toContain('welcome');
  return { host, guest, net, errors, done: async () => { await host.context().close(); await guest.context().close(); } };
}

test('P2E13 hello → welcome, 1.5MB 상태, 4002, 중계 0, 바깥 요청 0', async ({ browser }) => {
  const second = await browser.browserType().launch();
  try {
    const { host, guest, net, errors, done } = await link(browser, second);

    await host.evaluate(() => (window as unknown as { __p2p: HostH }).__p2p.start());
    await expect.poll(async () => (await G(guest)).types.filter((t) => t === 'state').length).toBeGreaterThan(1);
    await host.evaluate(() => (window as unknown as { __p2p: HostH }).__p2p.bigLog(1_500_000));
    await guest.evaluate(() => (window as unknown as { __p2p: GuestH }).__p2p.say({ t: 'sync' }));
    await expect.poll(async () => (await G(guest)).biggest, { timeout: 15_000 }).toBeGreaterThan(1_500_000);
    expect((await G(guest)).biggest).toBe((await H(host)).sent);

    const rtc = (p: Page) => p.evaluate(async () => {
      const out = [];
      for (const r of (window as unknown as { __rtc: RtcSeen[] }).__rtc) {
        const st = r.negotiated && r.state === 'connected' ? ((await r.stats()) as { id: string; type: string; nominated?: boolean; state?: string; localCandidateId?: string; remoteCandidateId?: string; candidateType?: string; address?: string }[]) : [];
        const pair = st.find((x) => x.type === 'candidate-pair' && x.nominated && x.state === 'succeeded');
        const cand = (id?: string) => { const c = st.find((x) => x.id === id); return c && `${c.candidateType} ${c.address}`; };
        out.push({ config: r.config, negotiated: r.negotiated, state: r.state, candidates: r.candidates, pair: pair && [cand(pair.localCandidateId), cand(pair.remoteCandidateId)] });
      }
      return out;
    });
    for (const p of [host, guest]) {
      const all = await rtc(p);
      const used = all.filter((r) => r.negotiated);
      test.info().annotations.push({ type: p === host ? 'host-rtc' : 'guest-rtc', description: JSON.stringify(all) });
      expect(used.map((r) => r.config)).toEqual([{ iceServers: [] }]);
      expect(used[0].state).toBe('connected');
      // peerjs 가 모듈을 읽을 때 기능 검사용으로 만들었다 바로 닫는 것 하나뿐(bundler.mjs 187행). 협상을 안 하므로 밖으로 아무것도 안 나간다
      expect(all.filter((r) => !r.negotiated).map((r) => [r.state, r.candidates])).toEqual([['closed', []]]);
    }

    await guest.evaluate(() => (window as unknown as { __p2p: GuestH }).__p2p.say({ t: 'leave' }));
    await expect.poll(async () => (await G(guest)).closes).toEqual([4002]);
    await expect.poll(async () => (await H(host)).closed).toBe(1);
    for (const n of net) {
      expect(n.outside).toEqual([]);
      expect(n.ws.length).toBeGreaterThan(0);
      expect(n.ws.every((u) => u.startsWith(`ws://127.0.0.1:${signal.port}/`))).toBe(true);
    }
    expect(errors).toEqual([]);
    await done();
  } finally { await second.close(); }
});

test('P2E13 학생이 데이터 채널로 JSON 아닌 것을 보내면 방장이 1008', async ({ browser }) => {
  for (const bad of ['text', 'null', 'bytes'] as const) {
    const { host, guest, errors, done } = await link(browser, browser);
    await guest.evaluate((k) => {
      const dc = (window as unknown as { __rtc: RtcSeen[] }).__rtc.filter((r) => r.negotiated).at(-1)!.dcs[0];
      if (k === 'text') dc.send('not json');
      else dc.send(k === 'null' ? new TextEncoder().encode('null') : new Uint8Array([255, 0, 1]));
    }, bad);
    await expect.poll(async () => (await G(guest)).closes).toEqual([1008]);
    await expect.poll(async () => (await H(host)).closed).toBe(1);
    expect(errors).toEqual([]);
    await done();
  }
});

test('P2E13 학생 탭이 사라지면 방장이 그 자리를 끊고, 방장이 사라지면 학생은 코드 없이 닫힌다', async ({ browser }) => {
  test.setTimeout(60_000); // 양쪽 10초 무신호를 실제로 기다린다
  const a = await link(browser, browser);
  await a.guest.close();
  await expect.poll(async () => (await H(a.host)).closed, { timeout: 15_000 }).toBe(1);
  await a.done();
  const b = await link(browser, browser);
  await b.host.close();
  await expect.poll(async () => (await G(b.guest)).closes, { timeout: 15_000 }).toEqual([null]);
  await b.done();
});

// 시험 페이지 빌드 폴더가 프로세스마다 하나라 공용 것을 덮어쓴다 → 이 파일의 마지막에 둔다
test('P2bE02 시그널링이 끊긴 뒤 방장이 사라져도 학생 쪽 RTCPeerConnection 이 남지 않는다', async ({ browser }) => {
  test.setTimeout(60_000);
  const sig = await startSignaling();
  let up = true;
  const own = await servePage(sig.port);
  try {
    const { host, guest, net, errors, done } = await link(browser, browser, own.url);
    await sig.stop();
    up = false;
    await host.waitForTimeout(3_000);
    await host.close();
    await expect.poll(async () => (await G(guest)).closes, { timeout: 15_000 }).toEqual([null]);
    await guest.waitForTimeout(3_000);
    const used = await guest.evaluate(() => (window as unknown as { __rtc: RtcSeen[] }).__rtc.filter((r) => r.negotiated).map((r) => r.state));
    expect(used).toEqual(['closed']);
    expect((await G(guest)).closes).toEqual([null]);
    expect(errors).toEqual([]);
    for (const n of net) expect(n.outside).toEqual([]);
    await done();
  } finally {
    if (up) await sig.stop();
    await own.close();
  }
});
