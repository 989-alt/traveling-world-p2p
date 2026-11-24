// 기기 간 통신 틀(PRD §9.5): 게임 메시지 문자열을 한 겹 싼다. 조각은 방장 → 학생만.
import { NET } from './config';

export type Frame =
  | { t: 'h'; v: number; code: string }
  | { t: 'm'; d: string }
  | { t: 'p'; id: number; i: number; n: number; d: string }
  | { t: 'b' }
  | { t: 'c'; code: number }
  | { t: 'a' };
export type Piece = Extract<Frame, { t: 'p' }>;

const int = Number.isInteger;

/** 선에서 온 것 → 틀. 모르는 종류·모양이 다르면 null */
export function parseFrame(x: unknown): Frame | null {
  if (typeof x !== 'object' || x === null) return null;
  const f = x as Frame;
  switch (f.t) {
    case 'h': return int(f.v) && typeof f.code === 'string' ? f : null;
    case 'm': return typeof f.d === 'string' ? f : null;
    case 'p': return int(f.id) && int(f.i) && int(f.n) && typeof f.d === 'string' ? f : null;
    case 'c': return int(f.code) ? f : null;
    case 'b': case 'a': return f;
    default: return null;
  }
}

/** 메시지 → 프레임들. d 는 JSON 글자라 날 제어 문자가 없다 → 글자당 최대 3바이트, 4,000자 조각은 15,000바이트를 못 넘는다 */
export function pack(d: string, id: number): Frame[] {
  if (d.length <= NET.inlineChars) return [{ t: 'm', d }];
  const n = Math.ceil(d.length / NET.chunkChars);
  return Array.from({ length: n }, (_, i) => ({ t: 'p', id, i, n, d: d.slice(i * NET.chunkChars, (i + 1) * NET.chunkChars) }));
}

interface Part { n: number; chars: number; got: Map<number, string>; timer: ReturnType<typeof setTimeout> }

/** 조각 조립. 상한을 넘거나 어긋나거나 제때 다 안 오면 그 메시지를 버리고 onDrop 을 한 번 부른다(같은 id 의 남은 조각은 무시) */
export class Assembler {
  private parts = new Map<number, Part>();
  private dropped = new Set<number>();
  /** 조립 중인 메시지 전부의 길이 */
  private chars = 0;
  constructor(private onDone: (d: string) => void, private onDrop: () => void) {}

  get size() { return this.parts.size; }

  add({ id, i, n, d }: Piece) {
    if (this.dropped.has(id)) return;
    let p = this.parts.get(id);
    if (n < 1 || n > NET.maxChunks || i < 0 || i >= n || d.length > NET.chunkChars || (p && (p.n !== n || p.got.has(i)))
      || this.chars + d.length > NET.maxChars) return this.drop(id);
    if (!p) this.parts.set(id, p = { n, chars: 0, got: new Map(), timer: setTimeout(() => this.drop(id), NET.assembleMs) });
    p.got.set(i, d);
    p.chars += d.length;
    this.chars += d.length;
    if (p.got.size < n) return;
    this.forget(id);
    const got = p.got;
    this.onDone(Array.from({ length: n }, (_, k) => got.get(k)!).join(''));
  }

  clear() { for (const id of [...this.parts.keys()]) this.forget(id); }

  private drop(id: number) {
    this.forget(id);
    this.dropped.add(id);
    if (this.dropped.size > NET.maxDropped) this.dropped.delete(this.dropped.values().next().value!); // 가장 오래된 것
    this.onDrop();
  }

  private forget(id: number) {
    const p = this.parts.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.chars -= p.chars;
    this.parts.delete(id);
  }
}
