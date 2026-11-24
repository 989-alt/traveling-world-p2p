// 서버 없이 돈다(PRD §6 S14): dist 를 아무 정적 호스팅의 하위 경로에 올려도 되는가. 빌드 뒤에 돌린다.
// ① js·html·manifest 에 '/api/' 0건 ② html·manifest·css 의 로컬 참조와 js 의 '/webp/'·'/audio/'·'/assets/', html 인라인 스크립트·핸들러의 '/…' 글자열 0건(외부 주소 https://… · //… 는 세지 않는다) ③ 서비스워커 파일·등록 0건
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

if (!existsSync('dist/index.html')) { console.error('check-static: dist/index.html 없음 — 먼저 npm run build'); process.exit(1); }

const bad = [];
const files = readdirSync('dist', { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
const texts = files.filter((f) => /\.(m?js|css|html|webmanifest)$/i.test(f)).map((f) => [f, readFileSync(f, 'utf8')]);

for (const [f, text] of texts) {
  const at = text.indexOf('/api/');
  if (at >= 0) bad.push(`${f}: '/api/' — ${text.slice(Math.max(0, at - 30), at + 30)}`);
  if (text.includes('serviceWorker')) bad.push(`${f}: 서비스워커 등록`);
}
for (const f of files) if (/^(sw|service-?worker)([.-].*)?\.m?js$/i.test(basename(f))) bad.push(`${f}: 서비스워커 파일`);

const absolute = (f, url) => { if (/^\/(?!\/)/.test(url)) bad.push(`${f}: 절대 경로 ${url}`); };

const of = (ext) => texts.filter(([f]) => ext.test(f));
for (const [f, html] of of(/\.html$/i)) {
  for (const m of html.matchAll(/\s(src|href|srcset|poster|action|data)\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/gi)) {
    const value = m[2].replace(/^["']|["']$/g, '');
    for (const url of m[1].toLowerCase() === 'srcset' ? value.split(',') : [value]) absolute(f, url.trim());
  }
  const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script/gi), ...html.matchAll(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+)/gi)].map((m) => m[1]);
  for (const code of inline) for (const m of code.replaceAll('&quot;', '"').replaceAll('&#39;', "'").matchAll(/["'`](\/\w[^"'`]*)/g)) absolute(f, m[1]);
}
for (const [f, css] of of(/\.(css|html)$/i)) for (const m of css.matchAll(/url\(\s*["']?([^"')]*)/gi)) absolute(f, m[1]);
for (const [f, js] of of(/\.m?js$/i)) for (const m of js.matchAll(/["'`](\/(webp|audio|assets)\/[^"'`]*)/g)) absolute(f, m[1]);

const manifests = of(/\.webmanifest$/i);
if (!manifests.length) bad.push('dist: webmanifest 없음(검사할 것이 없다)');
const strings = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
for (const [f, text] of manifests) for (const s of strings(JSON.parse(text))) absolute(f, s);

if (bad.length) { console.error(`check-static: ${bad.length}건\n  ${bad.join('\n  ')}`); process.exit(1); }
console.log(`check-static: OK (파일 ${files.length}개, 글 ${texts.length}개, manifest ${manifests.length}개)`);
