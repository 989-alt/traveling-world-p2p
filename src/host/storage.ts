// 방장 기기 저장(PRD §9.5): localStorage 바로 쓰기 + 메모리 사본. Room 은 사본만 읽는다 — 쓰기가 막혀도 판은 돈다.
import type { RoomCtx, RoomRec } from '../../worker/room';

export type StorageLike = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
/** ok 저장 중 · never 처음부터 저장 못 함(복원 없음) · stopped 도중에 멈춤(마지막 온전한 저장본이 남아 있다) */
export type SaveStatus = 'ok' | 'never' | 'stopped';

/** alive 가 이 안에 갱신됐으면 다른 탭이 돌리는 방 */
export const ALIVE_FRESH_MS = 3_000;

export const hostKey = (code: string, key: string) => `tw.host.${code}.${key}`;
const ROOM_KEY = /^tw\.host\.([A-HJ-NP-Z2-9]{6})\.room$/;

export function browserStore(): StorageLike | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

// 읽기는 예외를 그대로 던진다: 못 읽은 것을 '없음·깨짐'으로 보면 멀쩡한 저장본을 지우게 된다
const read = (store: StorageLike | null, code: string, key: string) => store?.getItem(hostKey(code, key)) ?? null;

/** 지우면서 훑지 않도록 키를 먼저 모은다 */
const keysOf = (store: StorageLike | null) => (store ? Array.from({ length: store.length }, (_, i) => store.key(i) ?? '') : []);

function roomCodes(store: StorageLike | null): string[] {
  try { return keysOf(store).flatMap((k) => ROOM_KEY.exec(k)?.[1] ?? []); } catch { return []; }
}

/** 저장된 방. 없거나 깨졌으면 null */
export function readRec(store: StorageLike | null, code: string): RoomRec | null {
  const raw = read(store, code, 'room');
  try {
    const v = JSON.parse(raw ?? 'null') as RoomRec | null;
    return typeof v?.expiresAt === 'number' ? v : null;
  } catch { return null; }
}

/** 새 코드가 이미 쓰이는가. 저장소를 못 읽는 기기는 저장도 못 하므로 겹칠 것이 없다고 본다 */
export function hasRoom(store: StorageLike | null, code: string) {
  try { return read(store, code, 'room') !== null; } catch { return false; }
}

export const readAlive = (store: StorageLike | null, code: string) => Number(read(store, code, 'alive')) || 0;

/** 기기 시계가 뒤로 바뀌면 alive 가 미래일 수 있다 → 차이의 크기로 본다(그 방이 계속 '다른 탭'으로 남지 않게) */
export const aliveFresh = (store: StorageLike | null, code: string) => Math.abs(Date.now() - readAlive(store, code)) <= ALIVE_FRESH_MS;

export function deleteRoom(store: StorageLike | null, code: string) {
  const prefix = hostKey(code, '');
  try { for (const k of keysOf(store)) if (k.startsWith(prefix)) store!.removeItem(k); } catch { /* 저장이 막힌 기기: 지울 것도 없다 */ }
}

/** 이 방을 열 수 없다(만료·깨짐) */
export const isDead = (rec: RoomRec | null) => !rec || Date.now() >= rec.expiresAt;

/** 앱을 열 때: 14일 지난 방과 깨진 방을 지운다 */
export function sweepRooms(store: StorageLike | null = browserStore()) {
  for (const code of roomCodes(store)) try { if (isDead(readRec(store, code))) deleteRoom(store, code); } catch { /* 못 읽은 방은 건너뛴다 */ }
}

const isQuota = (e: unknown) => ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes((e as { name?: string } | null)?.name ?? '');

/** 로그 조각 하나의 이벤트 수. 이벤트 배열이 아니면 던진다 */
function chunkLength(json: string): number {
  const v = JSON.parse(json) as unknown;
  if (!Array.isArray(v) || v.some((e) => typeof (e as { ev?: unknown } | null)?.ev !== 'string')) throw new Error('로그 조각이 깨짐');
  return v.length;
}

export class HostStorage {
  status: SaveStatus = 'ok';
  private mem = new Map<string, string>();
  private listeners = new Set<(s: SaveStatus) => void>();
  /** room 을 한 번이라도 온전히 썼다(= 다시 열 저장본이 있다) */
  private saved = false;

  constructor(private store: StorageLike | null, private code: string) {}

  /** 저장된 방을 메모리 사본으로. 못 읽거나 로그가 온전하지 않으면(로그는 평가 증거다) 아무것도 쓰거나 지우지 않고 던진다 */
  load() {
    const rec = readRec(this.store, this.code);
    this.saved = rec !== null;
    const prefix = hostKey(this.code, '');
    const stale: string[] = [];
    let events = 0;
    for (const full of keysOf(this.store)) {
      if (!full.startsWith(prefix)) continue;
      const key = full.slice(prefix.length);
      // room 쓰기에서 저장이 멈추면 번호 logChunks 이상 조각이 남는다. Room.load 는 조각을 전부 읽으므로 빼고 지운다(PRD §9.5 쓰기 실패)
      if (key.startsWith('log:') && Number(key.slice(4)) >= (rec?.logChunks ?? 0)) { stale.push(key); continue; }
      const v = read(this.store, this.code, key);
      if (v === null || key === 'alive') continue;
      if (key.startsWith('log:')) events += chunkLength(v);
      this.mem.set(key, v);
    }
    if (events !== (rec?.logLen ?? 0)) throw new Error('로그가 빠짐');
    for (const key of stale) this.remove(key);
  }

  kv: RoomCtx['storage']['kv'] = {
    get: (key) => this.mem.get(key),
    put: (key, value) => { this.mem.set(key, value); this.write(key, value); },
    delete: (key) => { this.mem.delete(key); if (this.status === 'ok') this.remove(key); },
    list: ({ prefix }) => [...this.mem].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)),
  };

  putAlive(at: number) { this.write('alive', String(at)); }

  /** 방이 끝남: 저장이 멈춘 방이라도 남은 저장본까지 지운다 */
  deleteAll() {
    this.mem.clear();
    deleteRoom(this.store, this.code);
  }

  subscribe(f: (s: SaveStatus) => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }

  /** 예외를 Room 으로 넘기지 않는다. 한 번 실패하면 이 방 키에 더 쓰지 않는다(마지막 온전한 저장본을 남긴다) */
  private write(key: string, value: string) {
    if (this.status !== 'ok') return;
    if (!this.trySet(hostKey(this.code, key), value)) {
      this.status = this.saved ? 'stopped' : 'never';
      // Room 처리 도중이므로 듣는 쪽은 처리가 끝난 뒤에 부른다
      for (const f of this.listeners) queueMicrotask(() => f(this.status));
    } else if (key === 'room') this.saved = true;
  }

  private trySet(full: string, value: string): boolean {
    const store = this.store;
    if (!store) return false;
    try { store.setItem(full, value); return true; } catch (e) { if (!isQuota(e)) return false; }
    // 용량 탓: 다른 방 가운데 끝난 판·만료된 방만, 오래된 것부터 하나씩(진행 중·대기실·다른 탭이 돌리는 방은 지우지 않는다)
    const done = roomCodes(store).filter((c) => c !== this.code).flatMap((c) => {
      try {
        const rec = readRec(store, c);
        return rec && (rec.game?.phase === 'finished' || isDead(rec)) && !aliveFresh(store, c) ? { c, at: rec.lastActiveAt } : [];
      } catch { return []; }
    }).sort((a, b) => a.at - b.at);
    for (const { c } of done) {
      deleteRoom(store, c);
      try { store.setItem(full, value); return true; } catch (e) { if (!isQuota(e)) return false; }
    }
    return false;
  }

  private remove(key: string) {
    try { this.store?.removeItem(hostKey(this.code, key)); } catch { /* 저장이 막힌 기기 */ }
  }
}
