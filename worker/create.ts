// 방 만들기. 진입 모듈(index.ts)은 핸들러·DO 클래스만 export 할 수 있어 따로 둔다(workerd 실측).
import { CODE_CHARS } from '../src/shared/protocol';
import type { Settings } from '../src/shared/types';

export const MAX_CODE_TRIES = 5;

export function randomCode(): string {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

/** DurableObjectNamespace 에서 쓰는 면만. 이 파일의 randomCode 를 방장 기기(src/host)도 쓰므로 Cloudflare 타입을 두지 않는다 */
interface RoomNamespace<Id> { idFromName(name: string): Id; get(id: Id): { fetch(url: string, init: RequestInit): Promise<Response> } }

/** 방 코드가 이미 있으면 다시 뽑는다(최대 5회) */
export async function createRoom<Id>(ns: RoomNamespace<Id>, settings: Settings, gen = randomCode): Promise<Response> {
  for (let i = 0; i < MAX_CODE_TRIES; i++) {
    const code = gen();
    const res = await ns.get(ns.idFromName(code)).fetch('https://room/init', {
      method: 'POST', body: JSON.stringify({ code, settings }),
    });
    if (res.status === 201) return Response.json({ code }, { status: 201 });
    if (res.status !== 409) return new Response(null, { status: 500 });
  }
  return new Response(null, { status: 503 });
}
