// @ts-nocheck -- node 전용 테스트(@types/node 없음, 의존성 추가 금지). check-first-load.mjs 를 자식 프로세스로 돌린다.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import cards from '../data/cards.json';
import missions from '../data/missions.json';
import tf from '../data/tf.json';

describe('check-first-load 스크립트 (P4E04)', () => {
  const script = join(__dirname, '../../scripts/check-first-load.mjs');
  const HTML = '<script type="module" crossorigin src="./assets/index.js"></script><link rel="modulepreload" href="./assets/dep.js"><link rel="stylesheet" href="./assets/a.css"><link rel="stylesheet" href="https://fonts.googleapis.com/css2">';
  const HOST = `const a=JSON.parse(${JSON.stringify(JSON.stringify({ cards, missions }))})`;
  const CLEAN = { 'index.js': 'import("./host-net.js")', 'dep.js': '0', 'a.css': '.a{}', 'host-net.js': HOST };
  const run = (files: Record<string, string | null> | null, html: string | null = HTML, at = script) => {
    const root = mkdtempSync(join(tmpdir(), 'cf-'));
    if (files) {
      mkdirSync(join(root, 'dist/assets'), { recursive: true });
      if (html !== null) writeFileSync(join(root, 'dist/index.html'), html);
      for (const [f, text] of Object.entries({ ...CLEAN, ...files })) if (text !== null) writeFileSync(join(root, 'dist/assets', f), text);
    }
    return spawnSync('node', [at], { cwd: root, encoding: 'utf8' });
  };
  const bad = (r: ReturnType<typeof run>, why: string) => expect([r.status, r.stderr]).toEqual([1, expect.stringContaining(why)]);
  const reason = (cards as { reasons: string[] }[])[7].reasons[0];
  const explain = (missions as { explain: string }[])[3].explain;

  it('P4E04 정상 -> exit 0, 첫 로드 KB 와 방장용 파일 KB 를 출력', () => {
    const r = run({});
    expect([r.status, r.stderr]).toEqual([0, '']);
    expect(r.stdout).toMatch(/첫 로드 합계 \d+\.\d KB/);
    expect(r.stdout).toMatch(/방장용 파일 [1-9]\d*\.\d KB {2}host-net\.js/);
  });
  it.each([['해설 카드 글이 첫 js', 'index.js', reason], ['미션 해설이 미리 받는 js', 'dep.js', explain], ['해설 카드 글이 css', 'a.css', reason]])('P4E04 %s 에 -> exit 1', (_, f, text) => {
    bad(run({ [f]: `x("${text}")` }), '첫 로드에 정답 글');
  });
  /** 자료에 해설 줄을 더한 사본에서 돌린다(스크립트는 제 옆 src/data 를 읽는다). 방장용에는 그 줄도 있다 */
  const runWith = (added: string, files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'cd-'));
    cpSync(script, join(root, 'scripts/check-first-load.mjs'));
    cpSync(join(__dirname, '../data'), join(root, 'src/data'), { recursive: true });
    writeFileSync(join(root, 'src/data/cards.json'), JSON.stringify([...cards, { reasons: [added] }]));
    return run({ 'host-net.js': `${HOST};"${added}"`, ...files }, HTML, join(root, 'scripts/check-first-load.mjs'));
  };
  /** 참/거짓 문장으로 늘 화면에 보이는 두 문장(PRD §6 S17) */
  const SHOWN = ['네팔은 바다에 닿지 않은 내륙국이에요.', '일 년 내내 기온이 높고 기온 변화가 거의 없어요.'];
  it('P5E07 늘 보여 주는 두 문장만 첫 로드에 있어도 된다', () => {
    const r = run({ 'index.js': JSON.stringify((tf as { text: string }[]).map((t) => t.text)) });
    expect([r.status, r.stderr]).toEqual([0, '']);
    bad(run({ 'index.js': JSON.stringify([...SHOWN, reason]) }), '첫 로드에 정답 글 1건');
    // 예외는 자료에 글자 그대로 있는 두 줄이다(낡은 예외가 남지 않게)
    expect(SHOWN.filter((t) => (cards as { reasons: string[] }[]).some((c) => c.reasons.includes(t)))).toEqual(SHOWN);
  });
  it.each([
    ['예외 문장을 품은 더 긴 새 문장', `${SHOWN[0]} 그래서 항구가 없어요.`], ['예외 문장의 일부인 새 문장', SHOWN[1].slice(0, 12)],
    ['참/거짓 문장과 글자까지 같은 새 문장', (tf as { text: string }[])[0].text],
  ])('P5E07 %s -> exit 1', (_, added) => {
    expect(runWith(added, {}).status).toBe(0); // 첫 로드에 없으면 통과
    bad(runWith(added, { 'index.js': `x("${added}")` }), '첫 로드에 정답 글 1건');
  });
  it('P5E07 index.html 인라인 스크립트의 정답 문장 -> exit 1', () => bad(run({}, `${HTML}<script>x("${reason}")</script>`), '첫 로드에 정답 글 1건'));
  it('P4E04 어느 파일에도 정답 글이 없음(방장용 파일 누락) -> exit 1', () => {
    bad(run({ 'host-net.js': null }), '방장용 파일에 없는 정답 글');
    bad(run({ 'host-net.js': '0' }), '방장용 파일에 없는 정답 글');
  });
  it('P4E04 정답 글이 한 줄만 빠져도 -> exit 1', () => bad(run({ 'host-net.js': HOST.replace(explain, '') }), '방장용 파일에 없는 정답 글'));
  it('P4E04 dist 없음 · 참조 없음 · 가리킨 파일 없음 -> exit 1', () => {
    bad(run(null), 'dist/index.html 없음');
    bad(run({}, '<p>빈 글</p>'), 'js·css 참조를 하나도 못 찾음');
    expect(run({ 'dep.js': null }).status).not.toBe(0);
  });
});
