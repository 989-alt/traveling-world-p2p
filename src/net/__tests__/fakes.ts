// 가짜 PeerJS: 시험이 사건을 직접 낸다. 짝지은 연결(pair)은 JSON 을 거쳐 microtask 로 건넨다(순서 보장 채널).
export const fake = { peers: [] as FakePeer[] };

type Cb = (...a: any[]) => void;
class Emitter {
  private cbs = new Map<string, Cb[]>();
  on(ev: string, cb: Cb) { this.cbs.set(ev, [...(this.cbs.get(ev) ?? []), cb]); return this; }
  emit(ev: string, ...a: unknown[]) { for (const cb of this.cbs.get(ev) ?? []) cb(...a); }
}

export class FakeDc extends Emitter {
  open = false;
  serialization = 'json';
  reliable = true;
  sent: any[] = [];
  /** close() 로 실제 끊은 횟수(flush 는 따로) */
  closes = 0;
  flushes = 0;
  /** PeerJS 가 쌓아 둔 메시지 수. 시험이 넣는다 */
  bufferSize = 0;
  private done = false;
  other: FakeDc | null = null;
  /** send·close 안에서 곧바로 부를 것(가장 나쁜 PeerJS) */
  onSend: ((x: any) => void) | null = null;
  onClose: (() => void) | null = null;
  constructor(public peer: string) { super(); }
  ready() { this.open = true; this.emit('open'); }
  send(x: any) {
    if (!this.open) return this.emit('error', { type: 'not-open-yet' });
    const json = JSON.stringify(x);
    this.sent.push(JSON.parse(json));
    this.onSend?.(x);
    const to = this.other;
    if (to) queueMicrotask(() => { if (to.open) to.emit('data', JSON.parse(json)); });
  }
  close(o?: { flush?: boolean }) {
    if (o?.flush) {
      this.flushes++;
      const to = this.other;
      if (to) queueMicrotask(() => to.cut());
      return;
    }
    if (this.done) return;
    this.closes++;
    this.onClose?.();
    this.cut();
  }
  /** 실제 연결이 끊김(망·상대가 닫음) */
  cut() {
    if (this.done) return;
    this.done = true;
    const to = this.other;
    if (to) queueMicrotask(() => to.cut());
    if (!this.open) return;
    this.open = false;
    this.emit('close');
  }
  of(t: string) { return this.sent.filter((f) => f.t === t); }
}

export class FakePeer extends Emitter {
  id: string | null;
  private lastId: string | null = null;
  opts: any;
  open = false;
  destroyed = false;
  disconnected = false;
  reconnects = 0;
  /** connect() 로 만든 연결 */
  dcs: FakeDc[] = [];
  connectArgs: [string, any][] = [];
  constructor(a?: any, b?: any) {
    super();
    this.id = typeof a === 'string' ? a : null;
    this.opts = typeof a === 'string' ? b : a;
    fake.peers.push(this);
  }
  ready(id = this.id ?? this.lastId ?? 'stu') { this.id = id; this.open = true; this.disconnected = false; this.emit('open', id); }
  connect(peer: string, o: any) { const dc = new FakeDc(peer); this.connectArgs.push([peer, o]); this.dcs.push(dc); return dc; }
  /** 원격 연결이 들어와 열림 */
  incoming(peer: string, ready = true) { const dc = new FakeDc(peer); this.emit('connection', dc); if (ready) dc.ready(); return dc; }
  /** PeerJS: 시그널링이 끊기면 error 뒤 disconnected */
  drop(type = 'network') { this.emit('error', { type }); this.disconnect(); }
  fail(type: string) { this.emit('error', { type }); this.destroy(); }
  reconnect() { this.reconnects++; this.disconnected = false; this.id = this.lastId; }
  /** PeerJS 와 같다: id 를 비우고 disconnected 에 옛 id 를 싣는다(1.5.5 bundler.mjs 1762~1772행) */
  disconnect() {
    if (this.disconnected) return;
    const id = this.id;
    this.open = false;
    this.disconnected = true;
    this.lastId = id;
    this.id = null;
    this.emit('disconnected', id);
  }
  destroy() {
    if (this.destroyed) return;
    this.disconnect();
    for (const dc of this.dcs) dc.close();
    this.destroyed = true;
    this.emit('close');
  }
}

/** 두 연결을 잇고 연다 */
export function pair(a: FakeDc, b: FakeDc) { a.other = b; b.other = a; a.ready(); b.ready(); }
export const last = <T>(a: T[]) => a[a.length - 1];
