// 거울(PRD §9.5): localStorage 에 성공한 쓰기를 IndexedDB 에도 쓴다. Chrome 은 localStorage 를 약 60초마다만 디스크에 적어
// 브라우저가 강제 종료되면 판이 되돌아간다(reports/P2P-7-flush-probe.txt). 원본은 localStorage 이고 거울은 앱을 열 때만 읽는다.
import { acquireLock, browserLocks, type LocksLike } from './lock';
import { browserStore, hasRoom, hostKey, isDead, keysOf, readAlive, readRec, scanRoom, type StorageLike } from './storage';

/** value null = key 로 시작하는 것을 모두 지운다 */
export type MirrorOp = [key: string, value: string | null];
export interface MirrorBackend {
  all(): Promise<Map<string, string>>;
  /** 트랜잭션 하나 */
  write(ops: MirrorOp[]): Promise<void>;
}

const OPEN_MS = 2_000;

/** null = 이 세션은 거울을 쓰지 않는다 */
let backend: MirrorBackend | null = null;
let reopen: (() => MirrorBackend) | null = null;
/** 거울이 꺼져도 새 연결로 한 번 더 보낼 것 */
const must = new WeakSet<MirrorOp>();
let batch: MirrorOp[] = [];
let tail: Promise<unknown> = Promise.resolve();

/** 한 처리(동기) 안의 변경은 처리가 끝난 뒤 트랜잭션 하나로 간다 */
export function mirrorPut(...op: MirrorOp) {
  if (backend) push(op);
}

/** 방 전체 지움·자리: 꺼진 거울에 남으면 다음에 거울이 되는 세션이 끝낸 판을 되살린다 → 꺼졌어도 새 연결로 한 번 보낸다 */
export function mirrorMust(...op: MirrorOp) {
  must.add(op);
  if (reopen) push(op);
}

function push(op: MirrorOp) {
  if (batch.push(op) === 1) queueMicrotask(flush);
}

function flush() {
  const ops = batch;
  batch = [];
  // 앞 배치가 끝난 뒤에: 실패한 조각을 건너뛰고 room 만 앞서지 않게
  tail = tail.then(() => backend!.write(ops)).catch(() => { // 꺼졌으면 여기서 던져 같은 길
    backend = null;
    const rest = ops.filter((op) => must.has(op));
    if (rest.length) void again(rest); // 답이 없어도 뒤의 것이 막히지 않게 기다리지 않는다
  });
}

async function again(ops: MirrorOp[]) {
  try { await reopen!().write(ops); } catch { /* 새 연결도 안 되는 기기: 되풀이하지 않는다 */ }
}

/** 거울 전체. 없거나 안 열리거나 2초 안에 답이 없으면 null 이고 이 세션은 거울을 끈다. 그 사이의 쓰기는 다 읽은 뒤에 나간다 */
export async function openMirror(make: () => MirrorBackend = idb): Promise<Map<string, string> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  reopen = make;
  try {
    backend = make();
    const all = Promise.race([backend.all(), new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error('거울이 답하지 않음')), OPEN_MS); })]);
    tail = all.catch(() => { backend = null; });
    return await all;
  } catch {
    backend = null;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 앱을 열 때: 거울이 엄격히 새로운 방(과 localStorage 에 없는 방)을 거울 것으로 통째 갈아 끼운다 */
export async function adoptRooms(all: Map<string, string>, store: StorageLike | null = browserStore(), locks: LocksLike | null = browserLocks()) {
  const keys = [...all.keys()];
  const view = { length: keys.length, key: (i) => keys[i], getItem: (k) => all.get(k) ?? null } as StorageLike;
  for (const code of new Set(keys.flatMap((k) => /^tw\.host\.(\w+)\./.exec(k)?.[1] ?? []))) {
    try { if (store) await adopt(code, view, store, locks); } catch { /* 저장소가 막히거나 자리가 모자람: 옛 room 이 남는다 */ }
  }
}

async function adopt(code: string, view: StorageLike, store: StorageLike, locks: LocksLike | null) {
  const prefix = hostKey(code, '');
  try {
    if (isDead(readRec(view, code))) throw new Error('만료·깨짐');
    scanRoom(view, code);
  } catch { return mirrorPut(prefix, null); }
  const newer = () => !hasRoom(store, code) || readAlive(view, code) > readAlive(store, code);
  if (!newer()) return;
  const release = await acquireLock(code, store, locks);
  if (!release) return;
  try {
    if (!newer()) return; // 기다리는 사이 다른 탭이 갈아 끼웠다
    const mine = keysOf(view).filter((k) => k.startsWith(prefix));
    const drop = (keep: string[]) => { for (const k of keysOf(store)) if (k.startsWith(prefix) && !keep.includes(k)) store.removeItem(k); };
    // 조각 → room → alive: 도중에 던지면 옛 room 과 그 조각이 일관되고, alive 가 옛것이라 다음에 다시 갈아 끼운다
    const last = [hostKey(code, 'room'), hostKey(code, 'alive')];
    const fresh = store.getItem(last[0]) === null; // 못 읽으면 여기서 던진다(있는 방을 없다고 보고 지우지 않게)
    try {
      for (const k of mine.sort((a, b) => last.indexOf(a) - last.indexOf(b))) store.setItem(k, view.getItem(k)!);
    } catch (e) {
      if (fresh) drop([]); // room 없는 조각은 만료 청소에 걸리지 않는다
      throw e;
    }
    drop(mine);
  } finally {
    await release(); // 곧 자동 복귀가 같은 잠금을 잡는다
  }
}

function idb(): MirrorBackend {
  const req = indexedDB.open('tw', 1);
  req.onupgradeneeded = () => { req.result.createObjectStore('kv'); };
  const db = new Promise<IDBDatabase>((ok, no) => { req.onsuccess = () => ok(req.result); req.onerror = () => no(req.error!); });
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => T) => {
    const tx = (await db).transaction('kv', mode);
    const out = f(tx.objectStore('kv'));
    tx.commit?.(); // 바로 닫히는 탭(끝내기 직후)에서도 끝까지 간다. 저절로 되는 커밋은 탭으로 한 번 돌아와야 해서 취소된다
    await new Promise<void>((ok, no) => { tx.oncomplete = () => ok(); tx.onabort = () => no(tx.error!); });
    return out;
  };
  return {
    all: async () => {
      const [keys, values] = await run('readonly', (s) => [s.getAllKeys(), s.getAll() as IDBRequest<string[]>] as const);
      return new Map(keys.result.map((k, i) => [k as string, values.result[i]]));
    },
    write: (ops) => run('readwrite', (s) => { for (const [k, v] of ops) if (v === null) s.delete(IDBKeyRange.bound(k, `${k}\uffff`)); else s.put(v, k); }),
  };
}
