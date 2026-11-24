// 화면 ↔ 서버 사이 하나뿐인 연결 관리자. 상태는 reduce() 로만 바뀌고, 자리 정보는 기기에 저장해 끊겨도 돌아온다.
import { useEffect, useState } from 'preact/hooks';
import { browserStore, hasRoom } from '../host/storage';
import { NET, TRANSPORT } from '../net/config';
import { peerMake } from '../net/peer-socket';
import { RoomSocket, type RoomSocketOpts } from '../net/socket';
import { ENDED_CLOSE, PIN_TRY_MS, type ClientAct, type ClientMsg, type ServerMsg } from '../shared/protocol';
import type { Seat, TotalMinutes } from '../shared/types';
import type { HostNet } from './host-net';
import { loadSeat, saveSeat, type SavedSeat } from './seat-store';
import { hostCover, initialState, reduce, type ClientState, type HostView } from './store';

type Make = RoomSocketOpts['make'];
type HostModule = Pick<typeof import('./host-net'), 'createHost' | 'openHost'>;
/** 방장 기기만 받는 지연 파일(Room·정답 데이터). ws 빌드에는 들지 않는다 */
const loadHostNet = (): Promise<HostModule> => (import.meta.env.VITE_TW_NET === 'ws' ? Promise.reject(new Error('ws')) : import('./host-net'));
const PEER = TRANSPORT === 'peer';
/** 들어가기 시작한 때부터 이만큼 못 붙으면 안내(§8-19). 시도 하나의 시한이 아니다 */
export const LATE_MS = 20_000;

export class GameClient {
  state: ClientState = initialState();
  private sock: RoomSocket | null = null;
  private listeners = new Set<(s: ClientState) => void>();
  private rejoin: { seat: Seat; pin: string } | null = null;
  private hello: number | null = null;
  /** 자동 복귀(이 기기에 저장된 자리)로 들어왔는지 — PIN 이 틀리면('pin') 저장을 지운다 */
  private fromSaved = false;
  /** 'locked' 뒤 같은 PIN 을 다시 보낼 타이머 */
  private retry: ReturnType<typeof setTimeout> | undefined;
  /** 이 기기(방장)가 끝내기를 보냈다 → ended 를 받아도 안내 띠 없이 첫 화면(DESIGN §20.3) */
  private ending = false;
  /** 소켓 세대: 닫거나 떠난 소켓의 늦은 메시지·닫힘이 새 화면을 건드리지 않게 */
  private gen = 0;
  /** 이 연결에서 전체 상태(logFrom 0)를 받았다 = 방이 받아 줬다. asked = 아직이라 sync 를 보냈다 */
  private got: 'none' | 'asked' | 'full' = 'none';
  /** 방장 기기: 이 탭에서 도는 방 */
  private host: HostNet | null = null;
  /** 방장 기기: 돌던 판을 다시 열어 멈춘 판이다 → 멈춤 모달 */
  private stalled = false;
  private lateTimer: ReturnType<typeof setTimeout> | undefined;
  /** 연결이 끊긴 뒤 방장 기다림까지 */
  private lostTimer: ReturnType<typeof setTimeout> | undefined;
  /** 방장 기기: 뒤에서 다시 등록하기까지 */
  private reopenTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private make?: Make, private urlOf: (code: string) => string = (code) => code, private loadHost = loadHostNet) {}

  subscribe(f: (s: ClientState) => void) { this.listeners.add(f); return () => { this.listeners.delete(f); }; }
  private set(s: ClientState) { this.state = s; this.listeners.forEach((f) => f(s)); }

  /** 이 기기에 남은 자리가 있으면 그 방으로 바로 돌아간다 */
  resumeSaved(): boolean {
    const v = loadSeat();
    if (!v) return false;
    // 자리 0 = 방장 기기인데 저장된 방이 없다(저장이 막힌 기기·만료): 다시 열 것이 없다(PRD §9.5 쓰기 실패)
    if (PEER && v.seatNo === 0 && !hasRoom(browserStore(), v.roomCode)) { saveSeat(null); return false; }
    this.open(v.roomCode);
    return true;
  }

  /** 새 방(기기 간 통신이면 이 탭에서 돌린다). 못 만들면 false. 기다리는 사이 다른 일을 했으면(close) 늦게 온 방은 버린다 */
  async create(settings: { totalMinutes: TotalMinutes }): Promise<boolean> {
    const gen = this.gen;
    if (import.meta.env.VITE_TW_NET === 'ws') {
      const code = await (await import('../net/ws')).createRoom(settings);
      if (gen !== this.gen) return false;
      if (code) this.open(code);
      return code !== null;
    }
    try {
      const net = await (await this.loadHost()).createHost({ ...settings, touristQuiz: false });
      if (gen !== this.gen) { net?.discard(); return false; }
      if (net) this.startHost(net);
      return net !== null;
    } catch (e) {
      console.error('[host] 방을 만들지 못함', e);
      return false;
    }
  }

  /** 방 코드로 들어간다. 이 기기에 저장된 방이면 방장으로 다시 열고, 저장된 자리가 있으면 그 자리로, 아니면 구경부터
   *  (로비면 캐릭터를 고르고, 이미 시작했으면 자리 PIN 을 넣는다) */
  open(code: string) {
    this.close();
    const v = loadSeat();
    const mine = v?.roomCode === code ? v : null;
    this.fromSaved = mine !== null;
    this.rejoin = mine && { seat: mine.seatNo, pin: mine.seatPin };
    this.hello = null;
    if (PEER && hasRoom(browserStore(), code)) void this.reopenHost(code);
    else this.openGuest(code);
  }

  private openGuest(code: string) {
    this.set({ ...initialState(code), conn: 'connecting' });
    const gen = this.gen;
    const live = () => gen === this.gen;
    if (import.meta.env.VITE_TW_NET === 'ws') {
      void import('../net/ws').then(({ roomUrl }) => { if (live()) this.dial(roomUrl(code), this.make); });
      return;
    }
    this.lateTimer = setTimeout(() => this.set({ ...this.state, late: true }), LATE_MS);
    // 신호가 돌아와도 여기서 걷지 않는다: 다시 받은 상태와 같은 렌더에서 걷어야 멈춘 시계가 튀지 않는다
    this.dial(this.urlOf(code), this.make ?? peerMake({ onHostSilent: (v) => { if (!live()) return; if (v) this.goAway(); else this.resync(); } }));
  }

  private async reopenHost(code: string) {
    this.set({ ...initialState(code), conn: 'connecting', host: { net: 'opening', restored: true, settled: false, played: false, save: 'ok' } });
    const gen = this.gen;
    const got = await this.loadHost().then((m) => m.openHost(code)).catch((e) => { console.error('[host] 방을 다시 열지 못함', e); return 'broken' as const; });
    if (gen !== this.gen) { if (typeof got !== 'string') void got.close(); return; }
    if (got === 'none') this.openGuest(code);
    else if (typeof got === 'string') this.setHost({ net: got });
    else this.startHost(got);
  }

  /** 방장 기기: 이 탭의 방에 직결로 들어간다. 저장된 방은 자리 0 으로 돌아온 뒤에 등록한다(친구가 먼저 붙어 판을 재개하지 못하게) */
  private startHost(net: HostNet) {
    this.close();
    this.host = net;
    this.fromSaved = false;
    this.rejoin = net.room.hostRejoin();
    this.hello = null;
    this.stalled = net.stalled;
    this.set({ ...initialState(net.room.code), conn: 'connecting', host: { net: 'wait', restored: net.restored, settled: false, played: false, save: 'ok' } });
    net.bind({
      onNet: (s) => { if (this.host === net) this.onNet(net, s); },
      onSave: (save) => { if (this.host === net) this.setHost({ save }); },
      onSwap: (charId) => {
        if (this.host !== net) return;
        this.rejoin = null;
        this.hello = charId;
        this.dialHost(net);
      },
    });
    this.dialHost(net);
    if (!net.restored || !this.rejoin) net.start();
  }

  private dialHost(net: HostNet) {
    this.gen++;
    this.sock?.close();
    this.dial(net.room.code, () => net.room.loopback());
  }

  private onNet(net: HostNet, s: HostView['net']) {
    clearTimeout(this.reopenTimer);
    this.setHost({ net: s, ...(s === 'open' || s === 'offline' ? { settled: true } : {}) });
    // 화면을 덮지 않는 실패: 뒤에서 같은 방으로 다시 등록한다. 열릴 때까지(§8-19 ⓖ)
    if (s === 'failed' && net.restored && !hostCover(this.state)) this.reopenTimer = setTimeout(() => net.register(), NET.reopenGapMs);
  }

  private setHost(h: Partial<HostView>) {
    if (this.state.host) this.set({ ...this.state, host: { ...this.state.host, ...h } });
  }

  /** 방장: [다시 연결해 보기]·[다시 해 보기]. 못 읽은 방은 처음부터 다시 연다 */
  retryHost() {
    if (this.host) this.host.register();
    else if (this.state.code) this.open(this.state.code);
  }

  private dial(url: string, make: Make) {
    const gen = this.gen;
    const live = () => gen === this.gen;
    this.sock = new RoomSocket({
      url,
      make,
      greet: () => (this.rejoin ? { t: 'rejoin', ...this.rejoin } : this.hello !== null ? { t: 'hello', charId: this.hello } : null),
      onStatus: (conn) => { if (live()) this.onConn(conn); },
      onMsg: (m) => { if (live()) this.onMsg(m); },
      // 4001 ended(메시지를 못 받았어도) · 4002 left: 다시 잇지 않고 첫 화면
      onFinal: (c) => { if (live()) this.finish(c === ENDED_CLOSE && !this.ending ? 'ended' : null); },
    });
  }

  private onConn(conn: Exclude<ClientState['conn'], 'idle'>) {
    this.got = 'none';
    this.set({ ...this.state, conn });
    if (conn !== 'retrying') return;
    const gen = this.gen;
    // 직결이 끊김 = 방이 끝났다(만료). RoomSocket 이 다음 시도를 건 뒤에 닫는다
    if (this.host) queueMicrotask(() => { if (gen === this.gen) this.finish(null); });
    else if (this.overHere()) { this.set({ ...this.state, conn: 'idle' }); queueMicrotask(() => { if (gen === this.gen) this.close(); }); }
    else if (PEER && this.state.room) this.lostTimer ??= setTimeout(() => this.goAway(), NET.silentMs);
  }

  /** 학생 기기의 끝난 판(자리에 앉아 결과를 보는 중): 더 올 소식이 없다. 끊겨도 다시 잇지 않고 받은 기록으로 결과를 보인다(§8-18) */
  private overHere() { return PEER && this.state.room?.phase === 'finished' && this.state.seat !== null; }

  /** 방장 기다림(§8-18). 방장 상태를 다시 받으면 걷힌다 */
  private goAway() {
    if (this.state.away === null && !this.overHere()) this.set({ ...this.state, away: Date.now() });
  }

  close() {
    this.gen++;
    clearTimeout(this.retry);
    clearTimeout(this.lateTimer);
    clearTimeout(this.lostTimer);
    this.lostTimer = undefined;
    clearTimeout(this.reopenTimer);
    this.sock?.close();
    this.sock = null;
    this.stalled = false;
    void this.host?.close();
    this.host = null;
  }

  /** 저장 자리는 둔 채 첫 화면으로(방장 기다림·다른 창·못 들어간 방): 같은 코드로 다시 들어오면 돌아온다 */
  home() {
    this.close();
    this.rejoin = null;
    this.set(initialState());
  }

  /** 방장: 다시 열지 못한 방에서 첫 화면으로. 저장 자리는 이 방 것일 때만 지운다(방 저장본은 그대로) */
  giveUp() {
    if (loadSeat()?.roomCode === this.state.code) saveSeat(null);
    this.home();
  }

  /** 처음 보는 기기: 방으로 돌아가지 않고 입장 화면으로 */
  leave() {
    saveSeat(null);
    this.home();
  }

  /** 방장: 게임 끝내기(U14). 서버가 ended 를 보내고 소켓을 4001 로 닫으면 첫 화면으로. 못 보냈으면 false */
  endGame(): boolean {
    this.ending = true;
    const ok = this.send({ t: 'end' });
    if (!ok) this.ending = false;
    return ok;
  }

  /** 학생: 게임 나가기(U14). 보내고 바로 첫 화면·저장 자리 삭제. 소켓은 서버가 4002 로 닫을 때까지(최대 3초) 두어 메시지가 닿게 한다 */
  leaveGame() {
    const sock = this.sock;
    this.sock = null;
    sock?.send({ t: 'leave' });
    if (sock) setTimeout(() => sock.close(), 3_000);
    this.finish(null);
  }

  /** 판에서 첫 화면으로: 다시 잇지 않고 저장 자리를 지운다(PRD §9.4). bye = 첫 화면 안내 띠 */
  private finish(bye: ClientState['bye']) {
    this.close();
    saveSeat(null);
    this.rejoin = null;
    this.hello = null;
    this.fromSaved = false;
    this.ending = false;
    this.set({ ...initialState(), bye });
  }

  /** 첫 화면 안내 띠를 내린다 */
  dismissBye() { if (this.state.bye) this.set({ ...this.state, bye: null }); }

  private onMsg(m: ServerMsg) {
    if (m.t === 'ended') { this.finish(this.ending ? null : 'ended'); return; }
    if (m.t === 'state') {
      // 새 연결의 첫 상태는 전체여야 한다: 되돌아간 판(방장 새로고침)에 증분을 붙이면 사라진 구간의 기록이 섞인다(PRD §9.5)
      if (this.got !== 'full' && m.logFrom !== 0) {
        if (this.got === 'none') { this.got = 'asked'; this.send({ t: 'sync' }); }
        return;
      }
      this.got = 'full';
      clearTimeout(this.lateTimer);
      clearTimeout(this.lostTimer);
      this.lostTimer = undefined;
    }
    let s = reduce(this.state, m);
    if (m.t === 'state') {
      s = { ...s, late: false, away: null };
      // 판에 있던 기기가 다시 붙어 보니 멈춘 판: 멈춘 순간 PIN 을 받은 기기와 같다 → 멈춤 모달(자기 PIN 은 들어올 때 받았다)
      if (s.room!.phase === 'paused' && !s.pins && s.seat !== null && s.pin && (this.stalled || this.state.room?.phase === 'playing')) s = { ...s, pins: [{ seat: s.seat, pin: s.pin }] };
      if (s.room!.phase !== 'paused') this.stalled = false;
      if (s.host && s.room!.phase === 'playing') s = { ...s, host: { ...s.host, played: true } };
    }
    if (m.t === 'welcome') {
      this.rejoin = { seat: m.seat, pin: m.pin };
      this.hello = null;
      this.fromSaved = false;
      saveSeat({ roomCode: this.host?.room.code ?? s.code!, seatNo: m.seat, seatPin: m.pin } satisfies SavedSeat);
    }
    if (m.t === 'error' && m.code === 'pin') {
      // 틀린 PIN: 다시 이을 때 또 보내지 않는다. 저장된 자리였으면 지우고 PIN 입력 화면으로
      // 앉아 있던 자리가 되돌아간 판(저장이 멈춘 방장)에 없을 때도 같다
      if (this.fromSaved || s.seat !== null) saveSeat(null);
      s = { ...s, seat: null, pin: null, pins: null };
      this.rejoin = null;
      this.fromSaved = false;
    }
    if (m.t === 'error' && m.code === 'locked' && this.rejoin) {
      // 잠긴 자리라 PIN 을 확인하지 않은 거부: 저장은 남기고 서버 비교 간격 뒤 같은 PIN 을 다시 보낸다
      clearTimeout(this.retry);
      this.retry = setTimeout(() => { if (this.rejoin) this.send({ t: 'rejoin', ...this.rejoin }); }, PIN_TRY_MS);
    }
    this.set(s);
    if (m.t === 'welcome') this.host?.start();
    if (s.needSync) this.send({ t: 'sync' });
  }

  send(m: ClientMsg) {
    if (m.t !== 'sync' && this.state.error) this.set({ ...this.state, error: null });
    return this.sock?.send(m) ?? false;
  }
  act(a: ClientAct) { return this.send({ t: 'act', a }); }

  join(charId: number) {
    this.hello = charId;
    this.send({ t: 'hello', charId });
  }

  claim(seat: Seat, pin: string) {
    this.rejoin = { seat, pin };
    this.send({ t: 'rejoin', seat, pin });
  }

  /** 탭이 다시 보이면 서버 상태를 다시 받는다 */
  resync() { this.send({ t: 'sync' }); }
}

export function useClient(c: GameClient) {
  const [s, setS] = useState(c.state);
  useEffect(() => c.subscribe(setS), [c]);
  return s;
}
