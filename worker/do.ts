// Cloudflare 판(롤백용) 덮개: Durable Object 하나 = 방 하나. 방 로직은 전부 room.ts, 여기는 fetch 입구만.
import { parseSettings } from '../src/shared/protocol';
import { Room as RoomCore } from './room';

/** 클래스 이름은 wrangler.toml 의 class_name 과 같아야 한다 */
export class Room extends RoomCore {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/init') {
      const body = (await req.json().catch(() => null)) as { code?: unknown; settings?: unknown } | null;
      const settings = parseSettings(body?.settings);
      if (!settings || typeof body?.code !== 'string') return new Response(null, { status: 400 });
      return new Response(null, { status: this.init(body.code, settings) ? 201 : 409 });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 426 });
    if (!this.rec) return new Response(null, { status: 404 });
    const pair = new WebSocketPair();
    this.accept(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}
