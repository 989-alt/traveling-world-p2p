// 방장 기기 시험 공용: 가짜 localStorage(쓰기 순서·실패·용량), 가짜 Web Locks, 원격 연결, 직결 연결. 시계는 전부 가짜.
import { vi } from 'vitest';
import type { ServerMsg } from '../../shared/protocol';
import type { Settings } from '../../shared/types';
import { seedCrypto, SETTINGS, T0 } from '../../../worker/__tests__/fakes';
import { withDice } from '../../engine/__tests__/helpers';
import type { SocketLike } from '../../net/socket';
import { createHostRoom, openHostRoom, type HostConn, type HostDeps, type HostRoom } from '../host-room';
import type { MirrorBackend, MirrorOp } from '../mirror';
import { hostKey } from '../storage';

export const quotaError = () => Object.assign(new Error('full'), { name: 'QuotaExceededError' });

export class FakeStore {
  data = new Map<string, string>();
  /** 성공·실패를 가리지 않고 부른 순서대로 'set 키'·'del 키'·'get 키' */
  ops: string[] = [];
  /** 던질 오류. null 이면 쓴다 */
  fail: (key: string) => Error | null = () => null;
  /** 키 + 값 글자 수 상한(넘으면 QuotaExceededError, 옛 값은 그대로) */
  cap = Infinity;
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(k: string) { this.ops.push(`get ${k}`); return this.data.get(k) ?? null; }
  setItem(k: string, v: string) {
    this.ops.push(`set ${k}`);
    const e = this.fail(k);
    if (e) throw e;
    const size = [...this.data].reduce((n, [a, b]) => n + (a === k ? 0 : a.length + b.length), k.length + v.length);
    if (size > this.cap) throw quotaError();
    this.data.set(k, v);
  }
  removeItem(k: string) { this.ops.push(`del ${k}`); this.data.delete(k); }
  of(code: string) { return Object.fromEntries([...this.data].filter(([k]) => k.startsWith(hostKey(code, ''))).sort()); }
  keys(code: string) { return [...this.data.keys()].filter((k) => k.startsWith(hostKey(code, ''))).sort(); }
  chars() { return [...this.data].reduce((n, [a, b]) => n + a.length + b.length, 0); }
  /** 이 방 키에 쓰거나 지운 횟수 */
  touched(code: string) { return this.ops.filter((o) => /^(set|del) /.test(o) && o.includes(hostKey(code, ''))).length; }
}

/** 같은 기기 탭들이 함께 쓰는 잠금 */
export class FakeLocks {
  held = new Set<string>();
  async request(name: string, _o: { ifAvailable: boolean }, cb: (lock: unknown) => unknown) {
    if (this.held.has(name)) return cb(null);
    this.held.add(name);
    try { return await cb({ name }); } finally { this.held.delete(name); }
  }
}

/** 놓은 뒤 한 박자 늦게 풀리는 잠금(진짜 Web Locks 의 놓기는 비동기다) */
export class SlowLocks extends FakeLocks {
  override async request(name: string, _o: { ifAvailable: boolean }, cb: (lock: unknown) => unknown) {
    if (this.held.has(name)) return cb(null);
    this.held.add(name);
    try { return await cb({ name }); } finally { await new Promise((ok) => { setTimeout(ok, 50); }); this.held.delete(name); }
  }
}

/** 메모리 거울. 브라우저가 죽어도 남는 것 = data */
export class FakeMirror implements MirrorBackend {
  data = new Map<string, string>();
  /** 트랜잭션 하나씩, 보낸 순서대로 */
  batches: MirrorOp[][] = [];
  fail: Error | null = null;
  async all() { return new Map(this.data); }
  async write(ops: MirrorOp[]) {
    if (this.fail) throw this.fail;
    this.batches.push(ops);
    for (const [k, v] of ops) {
      if (v !== null) this.data.set(k, v);
      else for (const x of [...this.data.keys()]) if (x.startsWith(k)) this.data.delete(x);
    }
  }
  of(code: string) { return Object.fromEntries([...this.data].filter(([k]) => k.startsWith(hostKey(code, ''))).sort()); }
}

export const fakeDeps = (store = new FakeStore(), locks: FakeLocks | null = new FakeLocks()) => ({ store, locks });
const asDeps = (d: ReturnType<typeof fakeDeps>) => d as unknown as HostDeps;

export class Remote implements HostConn {
  sent: ServerMsg[] = [];
  closes: (number | undefined)[] = [];
  port!: ReturnType<HostRoom['accept']>;
  constructor(host: HostRoom) { this.port = host.accept(this); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close(code?: number) { this.closes.push(code); }
  say(m: unknown) { this.port.message(JSON.stringify(m)); }
  of<T extends ServerMsg['t']>(t: T) { return this.sent.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[]; }
  last<T extends ServerMsg['t']>(t: T) { return this.of(t).at(-1); }
}

export class Direct {
  sent: ServerMsg[] = [];
  closes: (number | undefined)[] = [];
  sock: SocketLike;
  constructor(host: HostRoom) {
    this.sock = host.loopback();
    this.sock.onmessage = (e) => { this.sent.push(JSON.parse(e.data as string)); };
    this.sock.onclose = (e) => { this.closes.push(e.code); };
  }
  async say(m: unknown) { await flush(); this.sock.send(JSON.stringify(m)); await flush(); }
  of<T extends ServerMsg['t']>(t: T) { return this.sent.filter((m) => m.t === t) as Extract<ServerMsg, { t: T }>[]; }
  last<T extends ServerMsg['t']>(t: T) { return this.of(t).at(-1); }
}

/** 쌓인 microtask 를 다 돌린다 */
export const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
export const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** 탭이 통째로 멈춘 시간: 시계만 가고 타이머는 하나도 안 돈다 */
export const freeze = (ms: number) => { vi.setSystemTime(Date.now() + ms); };

export function fakeClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(T0);
  seedCrypto();
}

export async function newHost(deps = fakeDeps(), settings: Settings = SETTINGS) {
  const host = (await createHostRoom(settings, asDeps(deps)))!;
  return { host, deps, store: deps.store, code: host.code };
}
export async function reopen(code: string, deps: ReturnType<typeof fakeDeps>) {
  await flush(); // 앞 탭의 잠금 해제는 microtask 로 끝난다
  return openHostRoom(code, asDeps(deps));
}
export async function mustOpen(code: string, deps: ReturnType<typeof fakeDeps>) {
  const h = await reopen(code, deps);
  if (typeof h === 'string') throw new Error(h);
  return h;
}

/** 방장(자리 0) + 원격 n 명, 시작까지. 나머지 자리는 봇 */
export async function started(n = 0, deps = fakeDeps(), settings: Settings = SETTINGS) {
  const h = await newHost(deps, settings);
  const direct = new Direct(h.host);
  await direct.say({ t: 'hello', charId: 0 });
  const remotes = Array.from({ length: n }, (_, i) => { const r = new Remote(h.host); r.say({ t: 'hello', charId: i + 1 }); return r; });
  await direct.say({ t: 'start' });
  return { ...h, direct, remotes };
}

/** 자리 0 이 타이(2) 첫 방문 → 문항 단계 */
export async function atQuestion(n = 0) {
  const s = await started(n);
  s.host.room.game = withDice(s.host.room.game!, 1, 1);
  await s.direct.say({ t: 'act', a: { type: 'roll' } });
  await tick(s.host.room.rec!.deadlineAt! - Date.now());
  if (s.host.room.game!.turn.step !== 'question') throw new Error(s.host.room.game!.turn.step);
  return s;
}
export const snap = (h: HostRoom) => JSON.parse(JSON.stringify({ rec: { ...h.room.rec, game: null }, game: h.room.game }));
