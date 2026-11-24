import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Assembler, pack, parseFrame, type Frame } from '../frames';

const bytes = (f: Frame) => new TextEncoder().encode(JSON.stringify(f)).length;
type P = Extract<Frame, { t: 'p' }>;

function rig() {
  const done: string[] = [];
  let drops = 0;
  const asm = new Assembler((d) => done.push(d), () => { drops++; });
  return { asm, done, drops: () => drops, size: () => asm.size, add: (id: number, i: number, n: number, d = 'x') => asm.add({ t: 'p', id, i, n, d }) };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('P2E01 조각 내기', () => {
  const bit = '{"ev":"문항 \\"따옴표\\" 역슬래시 \\\\ 가나다 🌏🧭"},';
  it('P2E01 1.5MB 상태: 조각 본문 ≤ 4,000자, 프레임 ≤ 15,000바이트, 조립이 글자 단위로 같다', () => {
    const big = JSON.stringify({ t: 'state', log: bit.repeat(Math.ceil(1_500_000 / bit.length)) });
    expect(big.length).toBeGreaterThan(1_500_000);
    const fs = pack(big, 7) as P[];
    expect(fs.every((f) => f.t === 'p' && f.id === 7 && f.d.length <= 4_000)).toBe(true);
    expect(Math.max(...fs.map(bytes))).toBeLessThanOrEqual(15_000);
    const r = rig();
    for (const f of fs) r.asm.add(parseFrame(JSON.parse(JSON.stringify(f))) as P); // 선을 건넌 것과 같게
    expect(r.done.length).toBe(1);
    expect(r.done[0] === big).toBe(true);
    expect([r.drops(), r.size(), vi.getTimerCount()]).toEqual([0, 0, 0]);
  });

  it('P2E01 가장 나쁜 글자(한글만 · 따옴표와 역슬래시만 · 이모지가 조각 경계에 걸림)도 15,000바이트를 안 넘는다', () => {
    for (const s of ['가'.repeat(9_000), '"\\'.repeat(9_000), `${'a'.repeat(3_999)}${'🌏'.repeat(4_000)}`]) {
      const big = JSON.stringify({ s });
      const fs = pack(big, 1) as P[];
      expect(Math.max(...fs.map(bytes))).toBeLessThanOrEqual(15_000);
      const r = rig();
      for (const f of fs) r.asm.add(JSON.parse(JSON.stringify(f)));
      expect(r.done[0] === big).toBe(true);
    }
  });

  it('P2E01 3,000자까지는 m 한 장, 3,001자부터 조각', () => {
    expect(pack('x'.repeat(3_000), 1)).toEqual([{ t: 'm', d: 'x'.repeat(3_000) }]);
    expect(pack('x'.repeat(3_001), 1)).toEqual([{ t: 'p', id: 1, i: 0, n: 1, d: 'x'.repeat(3_001) }]);
  });
});

describe('P2E02 조립 상한', () => {
  it('P2E02 조각 수 2,049 선언은 버린다(2,048 은 받는다). 같은 id 의 나머지 조각에 또 알리지 않는다', () => {
    const r = rig();
    for (let i = 0; i < 2_049; i++) r.add(1, i, 2_049);
    expect([r.drops(), r.size(), vi.getTimerCount()]).toEqual([1, 0, 0]);
    for (let i = 0; i < 2_048; i++) r.add(2, i, 2_048);
    expect(r.done).toEqual(['x'.repeat(2_048)]);
  });

  it('P2E02 합친 길이 4,194,305자는 버리고 4,194,304자는 받는다', () => {
    for (const [len, ok] of [[4_194_305, false], [4_194_304, true]] as const) {
      const r = rig();
      const n = Math.ceil(len / 4_000);
      for (let i = 0; i < n; i++) r.add(1, i, n, 'x'.repeat(Math.min(4_000, len - i * 4_000)));
      expect([r.done.length, r.drops(), r.size(), vi.getTimerCount()]).toEqual(ok ? [1, 0, 0, 0] : [0, 1, 0, 0]);
    }
  });

  it('P2E02 i 중복 · 범위 밖 · n 불일치 · 본문 4,001자', () => {
    const bad: ((r: ReturnType<typeof rig>) => void)[] = [
      (r) => { r.add(1, 0, 3); r.add(1, 0, 3); },
      (r) => { r.add(1, 3, 3); },
      (r) => { r.add(1, -1, 3); },
      (r) => { r.add(1, 0, 0); },
      (r) => { r.add(1, 0, 3); r.add(1, 1, 4); },
      (r) => { r.add(1, 0, 3, 'x'.repeat(4_001)); },
    ];
    for (const f of bad) {
      const r = rig();
      expect(() => f(r)).not.toThrow();
      expect([r.done.length, r.drops(), r.size(), vi.getTimerCount()]).toEqual([0, 1, 0, 0]);
      r.add(9, 0, 1, 'ok'); // 다음 메시지는 정상
      expect(r.done).toEqual(['ok']);
    }
  });

  it('P2E02 15초 안에 다 안 오면 버린다', () => {
    const r = rig();
    r.add(1, 0, 2);
    vi.advanceTimersByTime(14_999);
    expect(r.drops()).toBe(0);
    vi.advanceTimersByTime(1);
    expect([r.drops(), r.size()]).toEqual([1, 0]);
    r.add(1, 1, 2);
    expect([r.done.length, r.drops(), r.size(), vi.getTimerCount()]).toEqual([0, 1, 0, 0]);
  });

  it('P2E02 두 메시지 조각이 섞여 와도 id 별로 조립', () => {
    const r = rig();
    r.add(1, 0, 2, 'a'); r.add(2, 1, 2, 'D'); r.add(2, 0, 2, 'C'); r.add(1, 1, 2, 'b');
    expect(r.done).toEqual(['CD', 'ab']);
    expect(r.drops()).toBe(0);
  });

  it('P2E02 clear 는 조립과 타이머를 남기지 않는다', () => {
    const r = rig();
    r.add(1, 0, 2); r.add(2, 0, 2);
    r.asm.clear();
    expect([r.size(), vi.getTimerCount(), r.drops()]).toEqual([0, 0, 0]);
  });
});

describe('P2E02 틀 모양', () => {
  it('P2E02 모르는 종류·모양이 다른 것은 null', () => {
    for (const x of [null, 0, 'b', [], {}, { t: 'z' }, { t: 'm' }, { t: 'm', d: 1 }, { t: 'h', v: 1 }, { t: 'c' }, { t: 'c', code: '4000' },
      { t: 'p', id: 1, i: 0, n: 1 }, { t: 'p', id: 1.5, i: 0, n: 1, d: '' }, { t: 'p', id: 1, i: '0', n: 1, d: '' }]) expect(parseFrame(x)).toBeNull();
    for (const f of [{ t: 'h', v: 1, code: 'ABCDEF' }, { t: 'm', d: '' }, { t: 'b' }, { t: 'a' }, { t: 'c', code: 4000 }, { t: 'p', id: 1, i: 0, n: 1, d: '' }]) expect(parseFrame(f)).toEqual(f);
  });
});

describe('P2bE08 조립 전체 상한', () => {
  const fill = (r: ReturnType<typeof rig>, id: number, n: number, from: number, to: number) => { for (let i = from; i < to; i++) r.add(id, i, n, 'x'.repeat(4_000)); };
  it('P2bE08 두 메시지의 합이 4,194,304자까지는 둘 다 조립, 넘기는 조각의 메시지만 버린다', () => {
    const r = rig();
    // 524 + 524 조각 = 4,192,000자, 나머지 2,304자
    fill(r, 1, 525, 0, 524); fill(r, 2, 526, 0, 524);
    r.add(1, 524, 525, 'x'.repeat(2_304)); // 1 은 합이 딱 상한일 때 끝난다
    expect([r.done.length, r.drops()]).toEqual([1, 0]);
    fill(r, 2, 526, 524, 526);
    expect([r.done.length, r.drops(), r.size(), vi.getTimerCount()]).toEqual([2, 0, 0, 0]);

    const q = rig();
    fill(q, 1, 525, 0, 524); fill(q, 2, 526, 0, 524);
    q.add(2, 524, 526, 'x'.repeat(2_304)); // 합 4,194,304
    expect([q.drops(), q.size()]).toEqual([0, 2]);
    q.add(2, 525, 526, 'x'); // 4,194,305 → 2 만 버린다
    expect([q.drops(), q.size(), q.done.length]).toEqual([1, 1, 0]);
    q.add(1, 524, 525, 'x');
    expect([q.done.length, q.drops(), q.size(), vi.getTimerCount()]).toEqual([1, 1, 0, 0]);
    fill(q, 3, 1_048, 0, 1_048); // 버리고 끝낸 만큼 자리가 돌아온다
    expect([q.done.length, q.drops()]).toEqual([2, 1]);
  });

  it('P2bE08 버린 id 는 64개까지만 기억: 1,000번 버려도 남는 것 0, 잊힌 id 는 새 조립으로 15초 뒤 1번 버린다', () => {
    const r = rig();
    for (let id = 0; id < 1_000; id++) r.add(id, 0, 0);
    expect([r.drops(), r.size(), vi.getTimerCount()]).toEqual([1_000, 0, 0]);
    for (let id = 936; id < 1_000; id++) r.add(id, 0, 2); // 마지막 64개는 기억한다
    expect([r.drops(), r.size()]).toEqual([1_000, 0]);
    r.add(935, 0, 2); // 65번째 앞은 잊었다
    expect([r.drops(), r.size()]).toEqual([1_000, 1]);
    vi.advanceTimersByTime(15_000);
    r.add(935, 0, 2);
    expect([r.drops(), r.size(), vi.getTimerCount()]).toEqual([1_001, 0, 0]);
  });
});
