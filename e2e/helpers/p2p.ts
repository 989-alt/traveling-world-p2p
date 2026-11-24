// P2P e2e 공용: 로컬 시그널링 서버(127.0.0.1, 빈 포트) + 시험 페이지 빌드. 공용 시그널링·STUN 으로 나가지 않게 주소를 빌드에 박는다.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import preact from '@preact/preset-vite';
import type { Page } from '@playwright/test';
import { build, preview } from 'vite';
import { ROOT } from './room-server';

export async function startSignaling(at = 0) {
  const p = spawn(process.execPath, [`${ROOT}scripts/peer-server.mjs`, String(at)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  const [line] = (await once(createInterface(p.stdout), 'line')) as [string];
  const port = Number(line.match(/127\.0\.0\.1:(\d+)/)![1]);
  return { port, stop: async () => { const gone = once(p, 'exit'); p.kill(); await gone; } };
}

const defines = (port: number) => {
  const env = { VITE_TW_PEER_HOST: '127.0.0.1', VITE_TW_PEER_PORT: String(port), VITE_TW_PEER_SECURE: 'false', VITE_TW_ICE_SERVERS: '[]' };
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]));
};

/** 시험 손잡이: 이 빌드에서만 방장 탭의 HostRoom·GameClient 를 window 에 건다(제품 코드 수정 0). __accepts = 원격 연결을 받은 순간 방장 화면의 자리 */
const HOOKS: [RegExp, string, string][] = [
  [/src\/app\.tsx$/, 'export const client = new GameClient();', 'export const client = new GameClient(); globalThis.__client = client;'],
  [/src\/host\/host-room\.ts$/, 'storage.putAlive(this.alive);', 'storage.putAlive(this.alive); globalThis.__host = this;'],
  [/src\/host\/host-room\.ts$/, 'accept(conn: HostConn): HostPort {', 'accept(conn: HostConn): HostPort { (globalThis.__accepts ??= []).push(globalThis.__client.state.seat);'],
];

/** 앱(기본 = 기기 간 통신)을 로컬 시그널링 주소로 빌드해 127.0.0.1 에 띄운다 */
export async function serveApp(port: number) {
  const out = join(tmpdir(), `tw-p2p-app-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const done = new Set<number>();
  const hooks = {
    name: 'tw-test-hooks', enforce: 'pre' as const,
    transform(code: string, id: string) {
      let next = code;
      HOOKS.forEach(([file, from, to], i) => { if (file.test(id) && next.includes(from)) { next = next.replace(from, to); done.add(i); } });
      return next === code ? null : { code: next, map: null };
    },
  };
  await build({ root: ROOT, configFile: false, plugins: [hooks, preact()], define: defines(port), publicDir: false, logLevel: 'error', build: { outDir: out, emptyOutDir: true } });
  if (done.size !== HOOKS.length) throw new Error(`시험 손잡이 ${done.size}/${HOOKS.length}`);
  for (const d of ['webp', 'audio']) symlinkSync(`${ROOT}assets/${d}`, join(out, d), 'dir');
  const server = await preview({ root: ROOT, configFile: false, build: { outDir: out }, preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  return { url: server.resolvedUrls!.local[0], close: async () => { await server.close(); rmSync(out, { recursive: true, force: true }); } };
}

/** 시험 페이지를 로컬 시그널링 주소로 빌드해 127.0.0.1 에 띄운다 */
export async function servePage(port: number) {
  const out = join(tmpdir(), `tw-p2p-e2e-${process.pid}`);
  await build({
    root: ROOT, configFile: false, publicDir: false, logLevel: 'error',
    define: defines(port),
    build: { outDir: out, emptyOutDir: true, target: 'es2022', rollupOptions: { input: `${ROOT}e2e/helpers/p2p-page.html` } },
  });
  const server = await preview({ root: ROOT, configFile: false, build: { outDir: out }, preview: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  return { url: `${server.resolvedUrls!.local[0]}e2e/helpers/p2p-page.html`, close: async () => { await server.close(); rmSync(out, { recursive: true, force: true }); } };
}

export interface RtcSeen { config: RTCConfiguration; negotiated: boolean; state: string; candidates: string[]; dcs: RTCDataChannel[]; /** 이 기기가 만든 채널로 받은 프레임 글 */ got: string[]; stats(): Promise<unknown[]> }

/** 페이지가 만드는 RTCPeerConnection 을 전부 적는다(window.__rtc) */
export const recordRtc = (page: Page) => page.addInitScript(() => {
  const seen: RtcSeen[] = [];
  (window as unknown as { __rtc: RtcSeen[] }).__rtc = seen;
  const Real = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Real {
    constructor(c?: RTCConfiguration) {
      super(c);
      const rec: RtcSeen = {
        config: JSON.parse(JSON.stringify(c ?? {})), negotiated: false, candidates: [], dcs: [], got: [],
        get state() { return pc.connectionState; },
        stats: async () => { const a: unknown[] = []; (await pc.getStats()).forEach((r) => a.push(r)); return a; },
      };
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const pc = this;
      seen.push(rec);
      for (const k of ['setLocalDescription', 'setRemoteDescription'] as const) {
        const f = this[k].bind(this) as (...a: unknown[]) => Promise<void>;
        (this as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => { rec.negotiated = true; return f(...a); };
      }
      const create = this.createDataChannel.bind(this);
      this.createDataChannel = (...a: Parameters<typeof create>) => { const d = create(...a); rec.dcs.push(d); d.addEventListener('message', (e) => rec.got.push(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data))); return d; };
      this.addEventListener('icecandidate', (e) => { if (e.candidate?.candidate) rec.candidates.push(e.candidate.candidate); });
    }
  };
});

/** 127.0.0.1·localhost 밖으로 나가는 요청·웹소켓을 적는다. 글꼴 주소는 막고 세지 않는다 */
export async function recordOutside(page: Page) {
  const outside: string[] = [];
  const ws: string[] = [];
  const font = /(^|\.)(googleapis|gstatic)\.com$/;
  const local = (u: string) => ['127.0.0.1', 'localhost'].includes(new URL(u).hostname);
  await page.route((u) => font.test(u.hostname), (r) => r.abort());
  page.on('request', (r) => { const u = r.url(); if (/^https?:/.test(u) && !local(u) && !font.test(new URL(u).hostname)) outside.push(u); });
  page.on('websocket', (w) => { ws.push(w.url()); if (!local(w.url())) outside.push(w.url()); });
  return { outside, ws };
}
