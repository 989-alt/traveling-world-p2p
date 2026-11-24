import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdWakeLock } from '../wake-lock';

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function page(wakeLock: unknown) {
  let cb: (() => void) | null = null;
  const doc = {
    visibilityState: 'visible',
    addEventListener: (_: string, f: () => void) => { cb = f; },
    removeEventListener: (_: string, f: () => void) => { if (cb === f) cb = null; },
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('navigator', { wakeLock });
  const show = async (v: 'visible' | 'hidden') => { doc.visibilityState = v; cb?.(); await flush(); };
  return { show, listening: () => cb !== null };
}
/** 잡힌 잠금 수를 세는 가짜 */
function lock() {
  const l = { asked: 0, held: 0, request: async () => { l.asked++; l.held++; let on = true; return { release: async () => { if (on) { on = false; l.held--; } } }; } };
  return l;
}
afterEach(() => vi.unstubAllGlobals());

describe('P3E13 화면 꺼짐 방지', () => {
  it('P3E13 지원: 부르면 요청, 다시 보이면 다시 요청, 놓으면 해제하고 더 요청하지 않는다', async () => {
    const l = lock();
    const p = page(l);
    expect(l.asked).toBe(0);
    const release = holdWakeLock();
    await flush();
    expect([l.asked, l.held]).toEqual([1, 1]);
    await p.show('hidden');
    expect(l.asked).toBe(1);
    await p.show('visible');
    expect([l.asked, l.held]).toEqual([2, 1]);
    release();
    await flush();
    expect([l.held, p.listening()]).toEqual([0, false]);
    await p.show('visible');
    expect(l.asked).toBe(2);
  });
  it('P3E13 요청 답이 오기 전에 놓으면 온 것을 바로 놓는다', async () => {
    const l = lock();
    page(l);
    holdWakeLock()();
    await flush();
    expect([l.asked, l.held]).toEqual([1, 0]);
  });
  it('P3E13 거부·미지원: 오류 없이 넘어간다', async () => {
    for (const w of [undefined, { request: async () => { throw new DOMException('no', 'NotAllowedError'); } }, { request: () => { throw new Error('sync'); } }]) {
      const p = page(w);
      const release = holdWakeLock();
      await flush();
      await p.show('hidden');
      await p.show('visible');
      release();
      await flush();
    }
  });
});
