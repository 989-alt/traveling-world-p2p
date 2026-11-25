import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeMirror, flush } from '../../host/__tests__/helpers';
import { mirrorPut, openMirror } from '../../host/mirror';
import { adoptSeat, loadSeat, saveSeat } from '../seat-store';

const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }; };

describe('seat-store', () => {
  it('저장·복원·삭제, 모양이 틀리면 null', () => {
    const st = mem();
    saveSeat({ roomCode: 'ABCDEF', seatNo: 2, seatPin: '0420' }, st);
    expect(loadSeat(st)).toEqual({ roomCode: 'ABCDEF', seatNo: 2, seatPin: '0420' });
    st.setItem('tw.seat', '{"roomCode":"abc","seatNo":9,"seatPin":"x"}');
    expect(loadSeat(st)).toBeNull();
    saveSeat(null, st);
    expect(loadSeat(st)).toBeNull();
  });
  it('저장소가 던져도 게임은 돈다', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(loadSeat(bad)).toBeNull();
    expect(() => saveSeat({ roomCode: 'ABCDEF', seatNo: 0, seatPin: '1111' }, bad)).not.toThrow();
  });
});

describe('P7E08 자리 거울', () => {
  afterEach(async () => { await openMirror(() => { throw new Error('끔'); }); vi.useRealTimers(); });
  const seat = { roomCode: 'ABCDEF', seatNo: 2 as const, seatPin: '0420' };
  const other = { roomCode: 'GGGGGG', seatNo: 1 as const, seatPin: '1111' };

  it('P7E08 저장은 at 을 붙여 둘 다에, 삭제는 localStorage 삭제 + 거울 묘비', async () => {
    vi.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    const m = new FakeMirror();
    await openMirror(() => m);
    const st = mem();
    saveSeat(seat, st);
    await flush();
    const raw = JSON.stringify({ ...seat, at: 1_000 });
    expect([st.getItem('tw.seat'), m.data.get('tw.seat')]).toEqual([raw, raw]);
    expect(loadSeat(st)).toEqual(seat);
    vi.setSystemTime(2_000);
    saveSeat(null, st);
    await flush();
    expect([st.getItem('tw.seat'), m.data.get('tw.seat')]).toEqual([null, '{"at":2000}']);
  });

  it('P7E08 localStorage 에 못 쓰면 거울에도 쓰지 않는다', async () => {
    const m = new FakeMirror();
    await openMirror(() => m);
    const bad = { setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    for (const st of [bad, null]) { saveSeat(seat, st); saveSeat(null, st); }
    await flush();
    expect(m.batches).toEqual([]);
  });

  const A = (v: object, at?: number) => JSON.stringify({ ...v, ...(at === undefined ? {} : { at }) });
  const rows: [string, string | null, string | undefined, string | null][] = [
    ['거울이 새 값', A(seat, 5), A(other, 6), A(other, 6)],
    ['거울이 새 묘비', A(seat, 5), A({}, 6), null],
    ['localStorage 에 없음 + 거울 값', null, A(other, 6), A(other, 6)],
    ['localStorage 옛 꼴 + 거울 값', A(seat), A(other, 6), A(other, 6)],
    ['같음', A(seat, 6), A(other, 6), A(seat, 6)],
    ['거울이 오래됨', A(seat, 7), A(other, 6), A(seat, 7)],
    ['거울이 오래된 묘비', A(seat, 7), A({}, 6), A(seat, 7)],
    ['거울에 없음', A(seat), undefined, A(seat)],
    ['거울이 옛 꼴(at 없음)', A(seat), A(other), A(seat)],
    ['거울이 깨짐', A(seat, 1), '{"at"', A(seat, 1)],
  ];
  for (const [name, ls, raw, want] of rows) it(`P7E08 앱을 열 때: ${name}`, () => {
    const st = mem();
    if (ls !== null) st.setItem('tw.seat', ls);
    adoptSeat(raw, st);
    expect(st.getItem('tw.seat')).toBe(want);
  });

  it('P7E08 at 이 없는 옛 값도 그대로 읽는다. 저장소가 던져도 예외 0', () => {
    const st = mem();
    st.setItem('tw.seat', A(seat));
    expect(loadSeat(st)).toEqual(seat);
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    expect(() => adoptSeat(A(other, 6), bad)).not.toThrow();
    expect(() => adoptSeat(A(other, 6), null)).not.toThrow();
  });
});

describe('P7bE02 거울이 꺼진 세션의 자리', () => {
  afterEach(async () => { await openMirror(() => { throw new Error('끔'); }); vi.useRealTimers(); });
  const A = { roomCode: 'ABCDEF', seatNo: 2 as const, seatPin: '0420' };
  const B = { roomCode: 'GGGGGG', seatNo: 1 as const, seatPin: '1111' };

  /** 거울에 A 가 들어간 뒤 꺼진다(다음 배치가 실패). 그 뒤 새로 만든 백엔드 수를 센다 */
  async function off() {
    vi.useFakeTimers({ now: 1_000, toFake: ['Date'] });
    const m = new FakeMirror();
    const made = { n: -1, fail: null as Error | null };
    await openMirror(() => { made.n++; if (made.fail) throw made.fail; return m; });
    const st = mem();
    saveSeat(A, st);
    await flush();
    m.fail = new Error('용량');
    mirrorPut('tw.host.ABCDEF.alive', '1');
    await flush();
    m.fail = null;
    expect([m.batches.length, made.n]).toEqual([1, 0]);
    vi.setSystemTime(2_000);
    return { m, st, made };
  }
  /** 다음 앱 열기 */
  const reopen = async (m: FakeMirror, st: ReturnType<typeof mem>) => { adoptSeat((await m.all()).get('tw.seat'), st); return loadSeat(st); };

  it('P7bE02 묘비: localStorage 삭제 + 새 연결로 묘비 한 번. 다음에 열어도(localStorage 가 그대로든 사라졌든) 자리 0', async () => {
    const { m, st, made } = await off();
    saveSeat(null, st);
    await flush();
    expect([st.getItem('tw.seat'), m.data.get('tw.seat'), made.n, m.batches.length]).toEqual([null, '{"at":2000}', 1, 2]);
    expect(await reopen(m, st)).toBeNull();
    expect(await reopen(m, mem())).toBeNull();
  });

  it('P7bE02 값(새 방에 앉음): localStorage 저장 + 새 연결로 같은 값 한 번. 다음에 열면 그 자리', async () => {
    const { m, st, made } = await off();
    saveSeat(B, st);
    await flush();
    expect([m.data.get('tw.seat'), made.n, m.batches.length]).toEqual([st.getItem('tw.seat'), 1, 2]);
    expect(await reopen(m, st)).toEqual(B);
    expect(await reopen(m, mem())).toEqual(B); // 강제 종료로 localStorage 가 사라진 쪽
  });

  it('P7bE02 묘비 뒤 값: 간 순서대로, 두 번', async () => {
    const { m, st, made } = await off();
    saveSeat(null, st);
    await flush();
    saveSeat(B, st);
    await flush();
    expect([made.n, m.batches.slice(1).map((b) => b.length), m.data.get('tw.seat')]).toEqual([2, [1, 1], st.getItem('tw.seat')]);
  });

  for (const bad of ['make 가 던짐', 'write 거부'] as const) it(`P7bE02 새 연결도 ${bad}: 예외 0, 되풀이 0, localStorage 는 그대로 된다`, async () => {
    const { m, st, made } = await off();
    if (bad === 'make 가 던짐') made.fail = new Error('막힘'); else m.fail = new Error('용량');
    saveSeat(null, st);
    await flush();
    saveSeat(B, st);
    await flush();
    expect([made.n, m.batches.length, loadSeat(st)]).toEqual([2, 1, B]);
  });

  it('P7bE02 localStorage 에 못 쓰면 꺼진 세션에서도 거울에 보내지 않는다', async () => {
    const { m, made } = await off();
    const bad = { setItem: () => { throw new Error('x'); }, removeItem: () => { throw new Error('x'); } };
    for (const st of [bad, null]) { saveSeat(B, st); saveSeat(null, st); }
    await flush();
    expect([made.n, m.batches.length]).toEqual([0, 1]);
  });
});
