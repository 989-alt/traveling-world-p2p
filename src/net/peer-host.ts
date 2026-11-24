// 방장 쪽 연결(PRD §9.5): 연결 ID 등록, 학생 기기가 보낸 것을 검사해 방(HostRoom.accept)에 넘긴다.
// 경계: 방은 처리 도중에 HostConn.send·close 를 부른다. PeerJS 사건은 전부 microtask 로 미뤄 그 안에서 방을 되부르지 않는다.
import type { BufferedConnection, DataConnection } from 'peerjs';
import type { HostConn, HostPort, HostRoom } from '../host/host-room';
import { MAX_MESSAGE_CHARS } from '../shared/protocol';
import { FRAME_V, hostId, NET } from './config';
import { pack, parseFrame, type Frame } from './frames';
import { bindConn, newPeer } from './peer-socket';

export type RemoteRoom = Pick<HostRoom, 'code' | 'accept'>;
/** open = 친구가 붙을 수 있다 · offline = 시그널링에 못 붙음 · failed = 연결 ID 를 끝내 못 잡음. 방은 어느 쪽이든 돈다 */
export type HostNetState = 'open' | 'offline' | 'failed';
export interface PeerHostOpts {
  onState?: (s: HostNetState) => void;
  /** 새 방: 연결 ID 를 남이 쓰는 중 → 코드를 다시 뽑은 방(못 만들면 null). 없으면 저장된 방 복원 = 같은 ID 로 다시 시도 */
  repick?: () => Promise<RemoteRoom | null>;
}

/** 학생 프레임의 선 위 크기 상한: 가장 긴 게임 메시지(글자마다 많아야 6바이트로 감긴다) + 틀 */
const MAX_FRAME_BYTES = MAX_MESSAGE_CHARS * 6 + 64;

/** new = 아직 안 열림 · hello = 인사 기다림 · live = 방에 이어짐 · closing = 닫힘 확인 기다림 · cut = 같은 기기의 새 연결에 밀림 · over = 끝 */
type Stage = 'new' | 'hello' | 'live' | 'closing' | 'cut' | 'over';

class Link implements HostConn {
  stage: Stage = 'new';
  private port: HostPort | null = null;
  private told = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seatTimer: ReturnType<typeof setTimeout> | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;
  private recent: number[] = [];
  private beats: number[] = [];
  private nextId = 1;

  constructor(readonly dc: DataConnection, private host: PeerHost) {
    bindConn(dc, {
      open: () => queueMicrotask(() => this.opened()),
      data: (x) => queueMicrotask(() => this.data(x)),
      end: () => queueMicrotask(() => { if (this.stage !== 'cut') this.finish(); }),
    }, MAX_FRAME_BYTES);
    this.arm(NET.openMs, () => this.finish());
  }

  // ── 방이 부르는 면 ──────────────────────────────────────

  send(d: string) {
    if (this.stage === 'live') for (const f of pack(d, this.nextId++)) this.put(f);
  }
  /** 닫힘 프레임을 보내고 확인(또는 3초) 뒤에 실제로 끊는다 */
  close(code = 1000) {
    if (this.stage === 'cut') return queueMicrotask(() => this.finish());
    if (this.stage !== 'live' && this.stage !== 'hello') return;
    this.stage = 'closing';
    this.disarm();
    this.arm(NET.closeWaitMs, () => this.finish());
    this.put({ t: 'c', code });
  }

  // ── 연결에서 오는 것 ────────────────────────────────────

  private opened() {
    if (this.stage !== 'new') return;
    this.stage = 'hello';
    this.arm(NET.helloMs, () => this.refuse());
    this.beat = setInterval(() => this.put({ t: 'b' }), NET.beatMs);
    if (!this.host.admit(this)) this.refuse();
  }

  private data(x: unknown) {
    const f = parseFrame(x);
    if (this.stage === 'closing') { if (f?.t === 'a') this.finish(); return; }
    if (this.stage === 'hello') {
      if (f?.t !== 'h' || f.v !== FRAME_V || f.code !== this.host.code) return this.refuse();
      this.stage = 'live';
      this.heard();
      this.seatTimer = setTimeout(() => { if (!this.port!.seated()) this.refuse(); }, NET.seatlessMs);
      this.port = this.host.accept(this);
      return;
    }
    if (this.stage !== 'live') return;
    this.heard();
    if (f?.t === 'b') { if (this.flooded(this.beats)) this.refuse(); return; }
    if (f?.t !== 'm' || f.d.length > MAX_MESSAGE_CHARS || this.flooded(this.recent)) return this.refuse();
    this.port!.message(f.d);
  }

  private heard() { this.arm(NET.deadMs, () => this.finish()); }

  /** 게임 메시지와 심박은 따로 센다(at) */
  private flooded(at: number[]) {
    const now = Date.now();
    while (at.length && now - at[0] >= NET.floodMs) at.shift();
    return at.push(now) > NET.floodCount;
  }

  // ── 끝 ──────────────────────────────────────────────────

  private refuse() {
    this.close(1008);
    this.tell();
  }

  /** 같은 기기의 새 연결이 왔다: 조용히 끊되, 새 연결이 자리를 되찾을 틈을 두고 나서 방에 알린다(되찾으면 방이 먼저 4000 으로 닫는다) */
  supersede() {
    this.disarm();
    this.dc.close();
    if (!this.port) return this.finish();
    this.stage = 'cut';
    this.arm(NET.deadMs, () => this.finish());
  }

  /** 실제로 끊고 방에 알린다 */
  finish() {
    if (this.stage === 'over') return;
    this.stage = 'over';
    this.disarm();
    this.dc.close();
    this.tell();
    this.host.gone(this);
  }

  private tell() {
    if (this.told) return;
    this.told = true;
    this.port?.closed();
  }

  /** 밀린 연결은 닫힘 프레임 없이 끝낸다(방이 처리 중일 수 있어 microtask 로) */
  private put(f: Frame) {
    void this.dc.send(f);
    if ((this.dc as BufferedConnection).bufferSize > NET.maxBuffered) queueMicrotask(() => this.finish());
  }
  private arm(ms: number, f: () => void) {
    clearTimeout(this.timer);
    this.timer = setTimeout(f, ms);
  }
  private disarm() {
    clearTimeout(this.timer);
    clearTimeout(this.seatTimer);
    clearInterval(this.beat);
  }
}

export class PeerHost {
  private peer: ReturnType<typeof newPeer> | null = null;
  private links = new Set<Link>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private repicks = 0;
  /** 복원: 연결 ID 가 '이미 쓰는 중' 이기 시작한 때. 다른 오류가 끼면 다시 잰다 */
  private takenAt: number | null = null;
  /** 복원: 시그널링에 못 붙었을 때 다음 등록까지 */
  private retryMs = NET.reconnectMs;
  private offline = false;
  private ending: Promise<void> | null = null;
  private drained = () => {};

  constructor(private room: RemoteRoom, private o: PeerHostOpts = {}) { this.register(); }

  get code() { return this.room.code; }

  /** 새 연결을 그만 받고 ID 를 놓는다. 닫힘 확인을 기다리는 연결은 끝까지 보낸 뒤에 끝난다(PRD §9.5 방장 끝내기). 두 번 불러도 같다 */
  close(): Promise<void> {
    if (this.ending) return this.ending;
    this.ending = new Promise((done) => { this.drained = () => { this.abandon(); done(); }; });
    clearTimeout(this.timer);
    this.peer?.disconnect();
    for (const l of [...this.links]) if (l.stage !== 'closing') l.finish();
    if (!this.links.size) this.drained();
    return this.ending;
  }

  // ── Link 가 부르는 면 ───────────────────────────────────

  accept(l: Link) { return this.room.accept(l); }
  /** 같은 기기의 옛 연결을 밀어낸 뒤 자리가 있으면 true */
  admit(l: Link) {
    const on = () => [...this.links].filter((x) => x.stage === 'hello' || x.stage === 'live');
    for (const x of on()) if (x !== l && x.dc.peer === l.dc.peer) x.supersede();
    return on().length <= NET.maxRemotes;
  }
  gone(l: Link) {
    this.links.delete(l);
    if (!this.links.size) this.drained();
  }

  // ── 등록 ────────────────────────────────────────────────

  private register() {
    const peer = newPeer(hostId(this.code));
    this.peer = peer;
    let opened = false;
    let wait = NET.reconnectMs;
    // 부순 Peer 의 늦은 사건은 무시한다
    const mine = () => this.peer === peer && !this.ending;
    const lost = (then: () => void) => { clearTimeout(this.timer); this.abandon(); then(); };
    this.timer = setTimeout(() => lost(() => this.unreachable()), NET.registerMs);
    peer.on('open', () => {
      if (!mine()) return;
      wait = NET.reconnectMs;
      if (opened) return;
      opened = true;
      clearTimeout(this.timer);
      this.state('open');
    });
    peer.on('error', (e) => {
      // webrtc = 거절한 연결 하나의 실패이지 등록 실패가 아니다(15초 시한이 덮는다)
      if (opened || !mine() || e.type === 'webrtc') return;
      lost(() => { if (e.type === 'unavailable-id') void this.taken(); else this.unreachable(); });
    });
    // 시그널링만 끊김: 맺은 연결은 그대로, 새 연결을 받으려고 될 때까지 다시 등록한다. reconnect() 실패도 disconnected 로 온다
    peer.on('disconnected', () => {
      if (!opened || !mine()) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => peer.reconnect(), wait);
      wait = Math.min(wait * 2, NET.reconnectMaxMs);
    });
    peer.on('connection', (dc) => {
      // 열리기 전의 등록은 곧 부술 수 있다(PeerJS 는 열렸는지 안 보고 넘긴다)
      const full = [...this.links].filter((l) => l.stage === 'new').length >= NET.maxPending;
      if (!opened || !mine() || full || dc.serialization !== 'json') return dc.close();
      this.links.add(new Link(dc, this));
    });
  }

  private async taken() {
    if (!this.o.repick) {
      this.takenAt ??= Date.now();
      if (Date.now() - this.takenAt >= NET.retakeGiveUpMs) this.state('failed');
      else this.timer = setTimeout(() => this.register(), NET.retakeMs);
      return;
    }
    const room = this.repicks++ < NET.maxRepicks ? await this.o.repick() : null;
    if (this.ending) return;
    if (!room) return this.state('failed');
    this.room = room;
    this.register();
  }

  /** 시그널링에 못 붙음. 복원은 [다시 연결해 보기] 가 없는 판 화면이라 뒤에서 끝없이 다시 한다(알림은 한 번) */
  private unreachable() {
    if (!this.o.repick) {
      this.takenAt = null;
      this.timer = setTimeout(() => this.register(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, NET.reconnectMaxMs);
      if (this.offline) return;
      this.offline = true;
    }
    this.state('offline');
  }

  private state(s: HostNetState) { this.o.onState?.(s); }

  private abandon() {
    const p = this.peer;
    this.peer = null;
    p?.destroy();
  }
}
