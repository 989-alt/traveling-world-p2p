// 기기에 남기는 것은 {roomCode, seatNo, seatPin} 과 쓴 시각 at 하나뿐(PRD §9). 저장이 막힌 브라우저에서도 게임은 돈다.
import { mirrorMust } from '../host/mirror';
import { CODE_RE, PIN_RE } from '../shared/protocol';
import type { Seat } from '../shared/types';

export interface SavedSeat { roomCode: string; seatNo: Seat; seatPin: string }
export const SEAT_KEY = 'tw.seat';

export function loadSeat(store: Pick<Storage, 'getItem'> | null = safeStore()): SavedSeat | null {
  try {
    const v = JSON.parse(store?.getItem(SEAT_KEY) ?? 'null') as SavedSeat | null;
    return v && CODE_RE.test(v.roomCode) && [0, 1, 2, 3].includes(v.seatNo) && PIN_RE.test(v.seatPin) ? { roomCode: v.roomCode, seatNo: v.seatNo, seatPin: v.seatPin } : null;
  } catch { return null; }
}

export function saveSeat(v: SavedSeat | null, store: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStore()) {
  if (!store) return;
  const raw = JSON.stringify({ ...v, at: Date.now() }); // 지움 = 거울에 묘비 {at}
  try { if (v) store.setItem(SEAT_KEY, raw); else store.removeItem(SEAT_KEY); mirrorMust(SEAT_KEY, raw); } catch { /* 저장 불가: 이번 접속만 */ }
}

const atOf = (raw: string | null) => { const at = (JSON.parse(raw ?? 'null') as { at?: unknown } | null)?.at; return typeof at === 'number' ? at : 0; };

/** 앱을 열 때(PRD §9.5 거울): 거울의 자리가 엄격히 새로우면 거울대로(값 또는 묘비) */
export function adoptSeat(raw: string | undefined, store: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = safeStore()) {
  try {
    if (!raw || !store || atOf(raw) <= atOf(store.getItem(SEAT_KEY))) return;
    if ('roomCode' in JSON.parse(raw)) store.setItem(SEAT_KEY, raw); else store.removeItem(SEAT_KEY);
  } catch { /* 깨졌거나 저장이 막힘: 그대로 */ }
}

function safeStore(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
