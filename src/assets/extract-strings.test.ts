// @ts-nocheck -- node 전용 테스트(@types/node 없음). extract-strings.mjs 를 자식 프로세스로 돌린다.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(__dirname, '../../scripts/extract-strings.mjs');
const FILES = { 'a.tsx': '화면 문구', 'dev/b.tsx': '개발 문구', 'x.test.tsx': '시험 문구', '__tests__/c.tsx': '시험 문구 둘', 'harness.tsx': '하네스 문구', 'ui/dev/d.tsx': '안쪽 개발 문구' };

describe('P3bE12 문구 추출의 경로 거름', () => {
  it('P3bE12 저장소가 /dev/ 아래에 있어도 같은 문구를 뽑는다(거름은 --src 기준 상대 경로)', () => {
    const run = (under: string) => {
      const src = join(mkdtempSync(join(tmpdir(), 'xs-')), under, 'src');
      for (const [f, text] of Object.entries(FILES)) { mkdirSync(dirname(join(src, f)), { recursive: true }); writeFileSync(join(src, f), `export const T = () => <p>${text}</p>;`); }
      const out = join(src, 'out.json');
      expect(spawnSync('node', [script, '--src', src, '--out', out]).status).toBe(0);
      return JSON.parse(readFileSync(out, 'utf8')).items;
    };
    expect(run('dev/repo')).toEqual([{ id: 's0001', src: 'a.tsx:1', text: '화면 문구' }]);
    expect(run('work/repo')).toEqual(run('dev/repo'));
  });
});
