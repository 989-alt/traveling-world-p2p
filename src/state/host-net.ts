// 방장 기기의 방 + 연결 등록(PRD §8-19·§9.5). 정답 데이터를 읽는 Room 이 딸려 오므로 방을 만들거나 다시 열 때만 받는 지연 파일이다
// (client.ts 가 동적 import 한다. 화면 코드는 여기서 타입만 쓴다).
import { createHostRoom, openHostRoom, type HostRoom } from '../host/host-room';
import type { SaveStatus } from '../host/storage';
import { PeerHost, type HostNetState, type PeerHostOpts, type RemoteRoom } from '../net/peer-host';
import type { Settings } from '../shared/types';

export interface HostEvents {
  /** wait = 등록 답을 기다린다 */
  onNet(s: 'wait' | HostNetState): void;
  onSave(s: SaveStatus): void;
  /** 코드를 다시 뽑아 room 이 바뀌었다. charId = 방장이 이미 골랐던 캐릭터(아직이면 null) */
  onSwap(charId: number | null): void;
}

const real = {
  peer: (room: RemoteRoom, o: PeerHostOpts): Pick<PeerHost, 'close'> => new PeerHost(room, o),
  create: (s: Settings) => createHostRoom(s),
  open: (code: string) => openHostRoom(code),
};
export type HostNetDeps = typeof real;

const drop = (room: HostRoom) => { room.close(); room.storage.deleteAll(); };

export class HostNet {
  private ev: HostEvents | null = null;
  private peer: Pick<PeerHost, 'close'> | null = null;
  private unwatch = () => {};
  private over = false;

  /** fresh = 새 방의 설정(코드를 다시 뽑을 수 있다). null = 저장된 방을 다시 연 것 */
  constructor(public room: HostRoom, private fresh: Settings | null, private deps: HostNetDeps) {}

  get restored() { return !this.fresh; }

  /** 돌던 판을 다시 열어 저절로 멈췄다(복원·자리 비움) → 멈춤 모달. 방장이 멈춰 둔 판은 이어 하기 화면(PRD §8-11·§8-12) */
  get stalled() {
    const g = this.room.room.game;
    const last = g?.log.filter((e) => e.ev === 'clock').at(-1);
    return g?.phase === 'paused' && last?.ev === 'clock' && last.by === 'auto';
  }

  bind(ev: HostEvents) {
    this.ev = ev;
    this.watch();
  }

  /** 아직이면 시그널링에 등록한다 */
  start() { if (!this.peer) this.register(); }

  /** 같은 방으로 새로 등록([다시 연결해 보기]·[다시 해 보기]). 앞의 것은 닫는다 */
  register() {
    if (this.over) return;
    void this.peer?.close();
    this.ev?.onNet('wait');
    const peer: Pick<PeerHost, 'close'> = this.deps.peer(this.room, {
      onState: (s) => { if (this.peer === peer && !this.over) this.ev?.onNet(s); },
      ...(this.fresh ? { repick: () => this.repick(this.fresh!) } : {}),
    });
    this.peer = peer;
  }

  /** 방을 그만 돌린다(저장본은 그대로, 잠금은 바로 놓는다). 닫힘 프레임이 다 나갈 때까지 연결 층을 들고 있는다 */
  async close() {
    if (this.over) return;
    this.over = true;
    this.unwatch();
    this.room.close();
    await this.peer?.close();
    this.peer = null;
  }

  /** 화면이 기다리지 않는 새 방: 닫고 저장본도 지운다 */
  discard() {
    void this.close();
    this.room.storage.deleteAll();
  }

  /** 새 방의 연결 ID 를 남이 쓰는 중. 새 방을 먼저 만든다 — 못 만들어도 방장이 방 없이 남지 않게. 이미 출발한 판은 버리지 않는다 */
  private async repick(settings: Settings): Promise<RemoteRoom | null> {
    const old = this.room;
    const next = old.room.game ? null : await this.deps.create(settings);
    if (!next) return null;
    if (this.over || old.room.game) { drop(next); return null; }
    const me = old.room.rec!.seats[old.room.rec!.hostSeat];
    this.room = next;
    this.watch();
    this.ev?.onSwap(me.claimed ? me.charId : null);
    drop(old);
    return next;
  }

  private watch() {
    this.unwatch();
    this.ev?.onSave(this.room.storage.status);
    this.unwatch = this.room.storage.subscribe((s) => this.ev?.onSave(s));
  }
}

export async function createHost(settings: Settings, deps: HostNetDeps = real): Promise<HostNet | null> {
  const room = await deps.create(settings);
  return room && new HostNet(room, settings, deps);
}

export async function openHost(code: string, deps: HostNetDeps = real): Promise<HostNet | 'busy' | 'none' | 'broken'> {
  const room = await deps.open(code);
  return typeof room === 'string' ? room : new HostNet(room, null, deps);
}
