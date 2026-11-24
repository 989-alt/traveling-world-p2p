// 업체 서버 흉내(P2P-4): 폴더 하나를 하위 경로 아래에 그대로 내놓는 정적 서버(127.0.0.1, 빈 포트). 그 밖의 주소는 전부 404, 받은 요청을 적는다.
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { extname, join } from 'node:path';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.webmanifest': 'application/manifest+json', '.webp': 'image/webp', '.png': 'image/png', '.mp3': 'audio/mpeg' };

export async function serveUnder(dir: string, prefix: string) {
  const log: { path: string; status: number }[] = [];
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://x').pathname;
    const rel = path.startsWith(prefix) ? decodeURIComponent(path.slice(prefix.length)) : null;
    const file = rel === null ? null : join(dir, rel || 'index.html');
    const ok = !!file && !!statSync(file, { throwIfNoEntry: false })?.isFile();
    log.push({ path, status: ok ? 200 : 404 });
    res.writeHead(ok ? 200 : 404, { 'content-type': (ok && TYPES[extname(file)]) || 'text/plain' });
    res.end(ok ? readFileSync(file) : 'not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, log, close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }) };
}
