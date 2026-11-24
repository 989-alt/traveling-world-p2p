// 웹소켓 길(VITE_TW_NET=ws 빌드에만 든다: Cloudflare 판 롤백·기존 e2e). 기본(peer) 빌드는 이 파일을 싣지 않는다.
import type { TotalMinutes } from '../shared/types';

export const roomUrl = (code: string, loc: Pick<Location, 'protocol' | 'host'> = location) =>
  `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/api/rooms/${code}/ws`;

export async function createRoom(settings: { totalMinutes: TotalMinutes }): Promise<string | null> {
  try {
    const res = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...settings, touristQuiz: false }) });
    if (!res.ok) return null;
    return ((await res.json()) as { code: string }).code;
  } catch { return null; }
}
