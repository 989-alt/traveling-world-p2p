// 방장 기기의 방(PRD §9.5): worker/room.ts 의 Room 을 이 탭에서 돌린다. 저장은 storage.ts, 탭 잠금은 lock.ts.
// 여기는 알람·심박(자리 비움 §3.7), 연결(직결·원격), 방장 자리 0 규칙, 방 만들기·불러오기.
import { MAX_CODE_TRIES, randomCode } from '../../worker/create';
import { Room, type RoomCtx, type RoomWs } from '../../worker/room';
import { parseClient, type ClientMsg, type ServerMsg } from '../shared/protocol';
import type { Seat, Settings } from '../shared/types';
import type { SocketLike } from '../net/socket';
import { acquireLock, browserLocks, type LocksLike } from './lock';
import { browserStore, deleteRoom, hasRoom, HostStorage, isDead, readAlive, readRec, type StorageLike } from './storage';

export const BEAT_MS = 1_000;
/** 이보다 오래 못 돌았으면 그 구간은 없던 시간(PRD §3.7 방장 기기 자리 비움) */
export const STALL_MS = 5_000;
/** setTimeout 이 받는 가장 긴 지연. 넘기면 바로 울린다 */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** 방장 기기 쪽에서 본 연결 하나. 원격(P2P-2)은 이 꼴로 넘긴다. send·close 안에서 HostPort 를 되부르지 않는다(Room 처리 도중이다) */
export interface HostConn {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
/** 연결이 방으로 넘기는 것 */
export interface HostPort {
  message(data: string): void;
  closed(): void;
  /** 이 연결이 자리에 앉아 있나 */
  seated(): boolean;
}

export interface HostDeps { store: StorageLike | null; locks: LocksLike | null }
const browserDeps = (): HostDeps => ({ store: browserStore(), locks: browserLocks() });

class Conn implements RoomWs {
  closed = false;
  private att: unknown = null;
  constructor(private conn: HostConn, readonly direct: boolean) {}
  send(data: string) { this.conn.send(data); }
  close(code?: number, reason?: string) {
    if (this.closed) return;
    this.closed = true;
    this.conn.close(code, reason);
  }
  serializeAttachment(a: unknown) { this.att = structuredClone(a); }
  deserializeAttachment() { return structuredClone(this.att); }
}

export class HostRoom {
  readonly room: Room;
  private conns: Conn[] = [];
  /** 방장이 앉기 전 원격 hello. 연결마다 마지막 하나, 먼저 온 연결부터 */
  private held = new Map<Conn, string>();
  private alarmAt: number | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | undefined;
  private beatTimer: ReturnType<typeof setInterval> | undefined;
  private over = false;

  private constructor(readonly code: string, readonly storage: HostStorage, private alive: number, private release: () => void, settings?: Settings) {
    const ctx: RoomCtx = {
      storage: {
        kv: storage.kv,
        setAlarm: async (at) => { this.setAlarm(at); },
        deleteAlarm: async () => { this.setAlarm(null); },
        deleteAll: async () => { storage.deleteAll(); this.close(); }, // Room 이 방을 끝냈다(end·만료)
      },
      acceptWebSocket: (ws) => { this.conns.push(ws as Conn); },
      getWebSockets: () => (this.conns = this.conns.filter((c) => !c.closed)),
    };
    try {
      this.room = new Room(ctx, null);
      if (settings) this.room.init(code, settings);
      else this.revive();
      this.enter(() => { void this.room.alarm(); }); // 알람은 저장되지 않으므로 다시 건다
      this.beatTimer = setInterval(() => this.beat(), BEAT_MS);
      storage.putAlive(this.alive);
    } catch (e) {
      this.close();
      throw e;
    }
  }

  static create(code: string, store: StorageLike | null, release: () => void, settings: Settings) {
    return new HostRoom(code, new HostStorage(store, code), Date.now(), release, settings);
  }
  static restore(code: string, store: StorageLike | null, release: () => void) {
    const storage = new HostStorage(store, code);
    const alive = readAlive(store, code);
    storage.load();
    return new HostRoom(code, storage, alive, release);
  }

  /** 저장본에서 다시 연 방(PRD §3.7): 틈 길이와 무관하게 멈춘 판, 그다음 사람 자리 전부 끊김.
   *  거꾸로면 끊김 처리(Room.run)가 꺼져 있던 시간을 놀이 시계에 넣는다 */
  private revive() {
    const rec = this.room.rec!;
    // 마지막 처리가 마지막 alive 기록보다 늦을 수 있다: 그때까지는 살아 있었다
    this.room.stall(Math.max(this.alive, rec.lastTickAt ?? 0));
    rec.seats.forEach((s, seat) => {
      if (!s.claimed) return;
      const gone = new Conn({ send: () => {}, close: () => {} }, false);
      gone.closed = true;
      gone.serializeAttachment({ seat });
      this.room.webSocketClose(gone);
    });
  }

  /** 이 탭에서 방을 그만 돌린다(저장본은 그대로). 잠금을 놓는다 */
  close() {
    this.over = true;
    this.setAlarm(null);
    clearInterval(this.beatTimer);
    this.held.clear();
    this.release();
  }

  /** 방장 자동 복귀: 저장된 방에서 자리 0 의 PIN. 방장이 아직 안 앉았으면 null */
  hostRejoin(): { seat: Seat; pin: string } | null {
    const r = this.room.rec;
    return r?.seats[r.hostSeat].claimed ? { seat: r.hostSeat, pin: r.seats[r.hostSeat].pin } : null;
  }

  // ── 시간 ────────────────────────────────────────────────

  /** 방에 들어가는 모든 길: 오래 못 돌았으면 먼저 그 시각에 멈춘 판으로 만든다 */
  private enter(f: () => void) {
    if (Date.now() - this.alive > STALL_MS) this.room.stall(this.alive);
    f();
    this.alive = Date.now();
  }

  private setAlarm(at: number | null) {
    clearTimeout(this.alarmTimer);
    this.alarmAt = at;
    if (at !== null && !this.over) this.alarmTimer = setTimeout(() => this.enter(() => this.fire()), Math.min(MAX_DELAY_MS, Math.max(0, at - Date.now())));
  }

  private fire() {
    if (this.alarmAt === null) return;
    this.alarmAt = null;
    void this.room.alarm();
  }

  private beat() {
    this.enter(() => { if (this.alarmAt !== null && Date.now() >= this.alarmAt) this.fire(); });
    if (!this.over) this.storage.putAlive(this.alive);
  }

  // ── 연결 ────────────────────────────────────────────────

  /** 원격 연결을 받는다(통신 틀·연결 수 상한은 P2P-2) */
  accept(conn: HostConn): HostPort { return this.attach(conn, false); }

  /** 방장 화면의 직결 연결. 받는 쪽이 처리 도중에 되부르지 못하게 보내기는 늘 microtask 로 */
  loopback(): SocketLike {
    let port: HostPort | null = null;
    const s: SocketLike = {
      readyState: 0, onopen: null, onclose: null, onmessage: null, onerror: null,
      send: (data) => { if (s.readyState === 1) port?.message(data); },
      close: (code) => {
        if (s.readyState === 3) return;
        s.readyState = 3;
        port?.closed();
        queueMicrotask(() => s.onclose?.({ code }));
      },
    };
    queueMicrotask(() => { if (s.readyState === 0) { s.readyState = 1; s.onopen?.({}); } });
    port = this.attach({
      send: (data) => queueMicrotask(() => { if (s.readyState === 1) s.onmessage?.({ data }); }),
      close: (code) => queueMicrotask(() => { if (s.readyState !== 3) { s.readyState = 3; s.onclose?.({ code }); } }),
    }, true);
    return s;
  }

  private attach(conn: HostConn, direct: boolean): HostPort {
    if (this.over) {
      conn.close(1008, 'gone');
      return { message: () => conn.close(1008, 'gone'), closed: () => {}, seated: () => false };
    }
    const c = new Conn(conn, direct);
    this.enter(() => this.room.accept(c));
    return {
      message: (data) => {
        if (this.over) return conn.close(1008, 'gone');
        if (!c.closed) this.enter(() => this.onMessage(c, data));
      },
      closed: () => {
        const live = !c.closed;
        c.closed = true;
        this.held.delete(c);
        if (live && !this.over) this.enter(() => this.room.webSocketClose(c));
      },
      seated: () => (c.deserializeAttachment() as { seat: Seat | null } | null)?.seat != null,
    };
  }

  private onMessage(c: Conn, data: string) {
    const msg = parseClient(data);
    // 방장 기기 = 자리 0, 자리 0 = 방장 기기: 원격 hello 는 방장이 앉을 때까지 보류, 방장이 앉은 방의 직결 hello 는 자리 0 복귀로,
    // 어긋난 복귀(원격의 자리 0·직결의 다른 자리)는 PIN 비교 없이 거부(실패로 세지 않는다)
    const mine = this.hostRejoin();
    if (msg?.t === 'hello' && !c.direct && !mine) return void this.held.set(c, data);
    if (msg?.t === 'rejoin' && c.direct !== (msg.seat === this.room.rec!.hostSeat)) {
      try { c.send(JSON.stringify({ t: 'error', code: 'pin' } satisfies ServerMsg)); } catch { /* 닫히는 중 */ }
      return;
    }
    this.room.webSocketMessage(c, msg?.t === 'hello' && c.direct && mine ? JSON.stringify({ t: 'rejoin', ...mine } satisfies ClientMsg) : data);
    if (!c.direct || !this.held.size || !this.hostRejoin()) return;
    const held = [...this.held];
    this.held.clear();
    for (const [h, raw] of held) this.room.webSocketMessage(h, raw);
  }
}

/** 새 방. 이 기기에 같은 코드의 방이 있으면 다시 뽑는다(최대 5회, 다 겹치면 null) */
export async function createHostRoom(settings: Settings, deps = browserDeps(), gen = randomCode): Promise<HostRoom | null> {
  for (let i = 0; i < MAX_CODE_TRIES; i++) {
    const code = gen();
    if (hasRoom(deps.store, code)) continue;
    const release = await acquireLock(code, deps.store, deps.locks);
    if (release) return HostRoom.create(code, deps.store, release, settings);
  }
  return null;
}

/** 이 기기에 저장된 방을 다시 연다. busy = 다른 탭이 돌리는 중(저장소를 건드리지 않는다), none = 없음·만료·room 값이 깨짐(지운다),
 *  broken = 저장본을 읽다 실패(로그가 깨지거나 빠짐·읽기 막힘. 저장본은 그대로 둔다) */
export async function openHostRoom(code: string, deps = browserDeps()): Promise<HostRoom | 'busy' | 'none' | 'broken'> {
  let release: (() => void) | null = null;
  try {
    release = await acquireLock(code, deps.store, deps.locks, true);
    if (!release) return 'busy';
    if (!isDead(readRec(deps.store, code))) return HostRoom.restore(code, deps.store, release);
    deleteRoom(deps.store, code);
  } catch (e) {
    console.error('[host] 방을 다시 열지 못함', code, e);
    release?.();
    return 'broken';
  }
  release();
  return 'none';
}
