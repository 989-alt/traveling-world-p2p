// 화면 꺼짐 방지(PRD §8-20 ④): 대기실·판 동안만. 거부·미지원이면 조용히 넘어간다(권한 창 없음).
interface Sentinel { release(): Promise<void> }
interface WakeLockLike { request(type: 'screen'): Promise<Sentinel> }

/** 잡고, 탭이 다시 보이면 다시 잡는다(가려지면 브라우저가 놓는다). 돌려준 함수로 놓는다 */
export function holdWakeLock(): () => void {
  let held: Sentinel | null = null;
  let off = false;
  const drop = (s: Sentinel | null) => { void s?.release().catch(() => {}); };
  const ask = async () => {
    if (off || document.visibilityState !== 'visible') return;
    try {
      const got = await (navigator as { wakeLock?: WakeLockLike }).wakeLock!.request('screen');
      if (off) return drop(got);
      drop(held);
      held = got;
    } catch { /* 미지원·거부 */ }
  };
  document.addEventListener('visibilitychange', ask);
  void ask();
  return () => {
    off = true;
    document.removeEventListener('visibilitychange', ask);
    drop(held);
    held = null;
  };
}
