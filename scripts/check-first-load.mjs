// 정답 파일 분리(PRD §6 S17, §13 ③): 해설 카드 글(cards.json reasons)·미션 해설(missions.json explain)은 첫 로드(index.html 과 거기서 가리키는 것)에 0건,
// 방을 만들 때만 받는 js(방장용)에는 전부 있다(있다는 것도 봐야 검사가 헛돌지 않는다). 빌드 뒤에 돌린다. 예산은 check-bundle-size 가 본다.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

if (!existsSync('dist/index.html')) { console.error('check-first-load: dist/index.html 없음 — 먼저 npm run build'); process.exit(1); }

const html = readFileSync('dist/index.html', 'utf8');
const refs = new Set([...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]));
for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
  const href = tag.match(/\bhref="([^"]+)"/)?.[1];
  if (href && /\brel="(stylesheet|modulepreload)"/.test(tag)) refs.add(href);
}
const first = [...refs].filter((r) => !/^(https?:)?\/\//.test(r)).map((r) => join('dist', r.split(/[?#]/)[0]));
if (!first.length) { console.error('check-first-load: dist/index.html 에서 js·css 참조를 하나도 못 찾음'); process.exit(1); }
const lazy = readdirSync('dist/assets').filter((f) => f.endsWith('.js')).map((f) => join('dist/assets', f)).filter((f) => !first.includes(f));

// 글에 따옴표·역슬래시가 없어 그대로 견준다. 생기면 아래 '방장용 파일에 없는' 검사가 걸린다
const data = (name) => JSON.parse(readFileSync(new URL(`../src/data/${name}.json`, import.meta.url), 'utf8'));
const answers = [...new Set([...data('cards').flatMap((c) => c.reasons), ...data('missions').map((m) => m.explain)])];
const has = (files) => { const text = files.map((f) => readFileSync(f, 'utf8')); return answers.filter((a) => text.some((t) => t.includes(a))); };

// 참/거짓 문장으로 늘 화면에 보이는 두 문장(PRD §6 S17). 글자까지 같은 줄만 첫 로드에서 세지 않는다. 방장용에는 그대로 있어야 한다
const SHOWN = new Set(['네팔은 바다에 닿지 않은 내륙국이에요.', '일 년 내내 기온이 높고 기온 변화가 거의 없어요.']);
const secret = answers.filter((a) => !SHOWN.has(a));
const leaked = has(['dist/index.html', ...first]).filter((a) => !SHOWN.has(a)); // index.html 인라인 글까지
if (leaked.length) { console.error(`check-first-load: 첫 로드에 정답 글 ${leaked.length}건\n  ${leaked.slice(0, 5).join('\n  ')}`); process.exit(1); }
const found = new Set(has(lazy));
const missing = answers.filter((a) => !found.has(a));
if (!answers.length || missing.length) { console.error(`check-first-load: 방장용 파일에 없는 정답 글 ${missing.length}/${answers.length}건\n  ${missing.slice(0, 5).join('\n  ')}`); process.exit(1); }

const kb = (files) => (files.reduce((n, f) => n + statSync(f).size, 0) / 1024).toFixed(1);
console.log(`첫 로드 합계 ${kb(first)} KB (파일 ${first.length}개, 정답 글 0/${secret.length}건, 참/거짓 문장과 같은 ${answers.length - secret.length}건은 세지 않음)`);
for (const f of lazy) { const n = has([f]).length; if (n) console.log(`방장용 파일 ${kb([f])} KB  ${f.slice('dist/assets/'.length)} (정답 글 ${n}/${answers.length}건)`); }
