// 같은 기기 두 탭(PRD §9.5): 잠금을 잡은 탭만 Room 을 돌린다.
import { ALIVE_FRESH_MS, aliveFresh, readAlive, type StorageLike } from './storage';

export type LocksLike = Pick<LockManager, 'request'>;

export function browserLocks(): LocksLike | null {
  return typeof navigator === 'undefined' ? null : navigator.locks ?? null;
}

/** alive 가 신선도를 넘긴 뒤 다시 볼 때의 여유(타이머가 조금 일찍 울려도) */
const RECHECK_SLACK_MS = 100;
/** 같은 순간에 다시 보는 두 탭을 떼어 놓는 흔들림. 기다림 전체가 3.5초를 넘지 않게 */
const RECHECK_JITTER_MS = 250;

/** 잡았으면 놓는 함수(약속 = 실제로 풀림. Web Locks 의 놓기는 비동기다), 다른 탭이 쥐고 있으면 null.
 *  recheck: 신선도 길에서 막히면 한 번만 기다렸다가 다시 본다 — 방금 새로고침한 자기 탭의 alive 일 수 있다(PRD §9.5) */
export async function acquireLock(code: string, store: StorageLike | null, locks: LocksLike | null, recheck = false): Promise<(() => Promise<unknown>) | null> {
  if (locks) {
    try {
      return await new Promise<(() => Promise<unknown>) | null>((resolve, reject) => {
        const done: Promise<unknown> = locks.request(`tw.host.${code}`, { ifAvailable: true }, (lock) => {
          if (!lock) return resolve(null);
          return new Promise<void>((release) => { resolve(() => { release(); return done; }); });
        });
        done.catch(reject);
      });
    } catch { /* 잠금을 못 쓰는 곳(막힌 iframe 등) → 아래 */ }
  }
  // shortcut: 신선도는 원자적이지 않다(alive 가 낡은 방을 두 탭이 같은 순간에 열면 둘 다 열린다. 다시 보기는 흔들림만큼만 갈린다). Web Locks 없는 브라우저가 실제로 쓰이면 다시 본다
  const free = () => { try { return !aliveFresh(store, code); } catch { return true; } }; // 못 읽는 저장소: 여는 쪽이 broken 으로 답한다
  if (!free()) {
    if (!recheck) return null;
    const wait = Math.min(readAlive(store, code) - Date.now(), 0) + ALIVE_FRESH_MS + RECHECK_SLACK_MS + Math.random() * RECHECK_JITTER_MS;
    await new Promise((r) => { setTimeout(r, wait); });
    if (!free()) return null;
  }
  return async () => {};
}
