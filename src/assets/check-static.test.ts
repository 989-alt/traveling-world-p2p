// @ts-nocheck -- node 전용 테스트(@types/node 없음, 의존성 추가 금지). check-static.mjs 를 자식 프로세스로 돌린다.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('check-static 스크립트 (P4E03)', () => {
  const script = join(__dirname, '../../scripts/check-static.mjs');
  const HTML = `<!doctype html><link rel="manifest" href="./assets/m.webmanifest"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Jua">
    <link rel="preconnect" href="//fonts.gstatic.com"><script type="module" src="./assets/a.js"></script><link rel="stylesheet" href="./assets/a.css">`;
  const MANIFEST = { name: '가', start_url: '../', scope: '../', icons: [{ src: '../webp/a.webp' }, { src: 'https://cdn.example.com/b.png' }] };
  const CLEAN = {
    'index.html': HTML, 'assets/a.js': 'const u="https://0.peerjs.com/peerjs";fetch("./x")', 'assets/a.css': '.a{}',
    'assets/m.webmanifest': JSON.stringify(MANIFEST),
  };
  /** files 에 null 이면 그 파일을 뺀다. files 자체가 null 이면 dist 가 없다 */
  const run = (files: Record<string, string | null> | null) => {
    const root = mkdtempSync(join(tmpdir(), 'cs-'));
    if (files) for (const [f, text] of Object.entries({ ...CLEAN, ...files })) {
      if (text === null) continue;
      mkdirSync(join(root, 'dist', dirname(f)), { recursive: true });
      writeFileSync(join(root, 'dist', f), text);
    }
    return spawnSync('node', [script], { cwd: root, encoding: 'utf8' });
  };
  const bad = (files: Parameters<typeof run>[0], why: string) => {
    const r = run(files);
    expect([r.status, r.stderr]).toEqual([1, expect.stringContaining(why)]);
  };

  it('P4E03 깨끗한 dist -> exit 0 (외부 주소·글꼴은 로컬 절대 경로로 세지 않는다)', () => {
    const r = run({});
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toContain('check-static: OK');
  });
  it('P4E03 dist 없음 -> exit 1', () => bad(null, 'dist/index.html 없음'));
  it.each(['assets/a.js', 'assets/late.js', 'index.html', 'assets/m.webmanifest'])("P4E03 '/api/rooms' 가 %s 에 -> exit 1", (f) => {
    bad({ [f]: f === 'index.html' ? `${HTML}<a href="./api/rooms">` : f.endsWith('manifest') ? JSON.stringify({ ...MANIFEST, x: './api/rooms' }) : 'fetch("/api/rooms")' }, "'/api/'");
  });
  it.each([
    ['src', '<script type="module" src="/assets/a.js"></script>'], ['href', "<link rel=icon href='/favicon.ico'>"],
    ['따옴표 없음', '<img src=/webp/a.webp>'], ['srcset', '<img srcset="./a.webp 1x, /webp/b.webp 2x">'], ['base', '<base href="/">'],
  ])('P4E03 index.html 의 절대 경로(%s) -> exit 1', (_, tag) => bad({ 'index.html': HTML + tag }, '절대 경로'));
  it.each([
    ['start_url', { start_url: '/' }], ['scope', { scope: '/' }], ['아이콘', { icons: [{ src: '/webp/a.webp' }] }],
  ])('P4E03 manifest 의 절대 경로(%s) -> exit 1', (_, over) => bad({ 'assets/m.webmanifest': JSON.stringify({ ...MANIFEST, ...over }) }, '절대 경로'));
  it('P4E03 manifest 가 없으면 검사가 헛돈다 -> exit 1', () => bad({ 'assets/m.webmanifest': null }, 'webmanifest 없음'));
  it.each([
    ['css url', { 'assets/a.css': '.a{background:url(/webp/a.webp)}' }], ['css url 따옴표·빈칸', { 'assets/a.css': '.a{background:url( "/webp/a.webp" )}' }],
    ['html 안 style', { 'index.html': `${HTML}<style>.a{background:url('/webp/a.webp')}</style>` }],
    ['js /webp/', { 'assets/a.js': 'x="/webp/a.webp"' }], ['js /audio/', { 'assets/a.js': "x='/audio/x.mp3'" }], ['js /assets/', { 'assets/a.js': 'x=`/assets/x.js`' }],
    ['대문자 확장자 css', { 'assets/b.CSS': '.a{background:url(/webp/a.webp)}' }], ['대문자 확장자 js', { 'assets/z.JS': 'x="/webp/a.webp"' }],
    ['onclick 주소', { 'index.html': `${HTML}<body onclick="location.href='/x'">` }], ['onclick &quot;', { 'index.html': `${HTML}<body onclick="go(&quot;/x&quot;)">` }],
    ['인라인 스크립트 주소', { 'index.html': `${HTML}<script>fetch("/x.json")</script>` }],
  ])('P5E06 절대 경로(%s) -> exit 1', (_, files) => bad(files, '절대 경로'));
  it.each([
    ['onclick', { 'index.html': `${HTML}<body onclick="fetch('/api/x')">` }], ['인라인 스크립트', { 'index.html': `${HTML}<script>fetch('/api/x')</script>` }], ['z.JS', { 'assets/z.JS': 'fetch("/api/x")' }],
  ])("P5E06 '/api/'(%s) -> exit 1", (_, files) => bad(files, "'/api/'"));
  it('P5E06 대문자 확장자의 서비스워커 파일 -> exit 1', () => bad({ 'SW.JS': '0' }, '서비스워커'));
  it('P5E06 외부·자기 문서·data 주소와 상대 경로, 나눗셈·가르기 글자는 통과', () => {
    const r = run({
      'assets/a.css': '.a{background:url(//cdn.example.com/a.png)}.b{filter:url(#a)}.c{background:url(data:image/png;base64,/webp/)}.d{background:url(../webp/a.webp)}',
      'assets/a.js': 'a="./webp/a.webp";b="webp/a.webp";c=s.split("/");d="https://x.example.com/assets/a.js"',
      'index.html': `${HTML}<script>x=s.split("/");y="//cdn.example.com/a"</script><body onload="this.media='all'">`,
    });
    expect([r.status, r.stderr]).toEqual([0, '']);
  });
  it('P4E03 서비스워커 등록·파일 -> exit 1', () => {
    bad({ 'assets/a.js': 'navigator.serviceWorker.register("./w.js")' }, '서비스워커');
    for (const f of ['sw.js', 'service-worker.js', 'assets/serviceWorker-abc.js']) bad({ [f]: '0' }, '서비스워커');
    expect(run({ 'assets/swim.js': '0' }).status).toBe(0);
  });
});
