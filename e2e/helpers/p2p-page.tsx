// P2P-2 시험용 최소 페이지(화면 없음). ?role=host 는 이 탭에서 방을 돌리고, ?role=guest&code= 는 그 방에 붙는다. 손잡이는 window.__p2p.
import { createHostRoom, type HostConn } from '../../src/host/host-room';
import { PeerHost } from '../../src/net/peer-host';
import { peerMake } from '../../src/net/peer-socket';
import type { ClientMsg, ServerMsg } from '../../src/shared/protocol';
import type { LogEvent } from '../../src/shared/types';

const q = new URLSearchParams(location.search);

async function host() {
  const room = (await createHostRoom({ totalMinutes: 40, touristQuiz: false }))!;
  const p2p = { code: room.code, states: [] as string[], conns: [] as HostConn[], sent: 0, closed: 0, start: () => {}, bigLog: (_n: number) => {}, seat1: () => room.room.rec!.seats[1].connected, stop: () => net.close() };
  const direct = room.loopback();
  const say = (m: ClientMsg) => direct.send(JSON.stringify(m));
  direct.onopen = () => say({ t: 'hello', charId: 0 });
  p2p.start = () => say({ t: 'start' });
  /** 판의 로그를 n 글자 넘게 불린다(이미 저장된 것으로 친다): 다음 sync 의 답이 그만큼 커진다 */
  p2p.bigLog = (n) => {
    const e = { ev: 'clock', pad: '가나다 "따옴표" \\ 🌏'.repeat(50) } as unknown as LogEvent;
    const log = Array.from({ length: Math.ceil(n / JSON.stringify(e).length) }, () => e);
    room.room.game!.log = log;
    room.room.rec!.logLen = room.room.rec!.cutsceneScan = log.length;
  };
  const net: PeerHost = new PeerHost({
    code: room.code,
    accept: (conn) => {
      const tap: HostConn = { send: (d) => { p2p.sent = Math.max(p2p.sent, d.length); conn.send(d); }, close: (c, r) => conn.close(c, r) };
      p2p.conns.push(tap);
      const port = room.accept(tap);
      return { ...port, closed: () => { p2p.closed++; port.closed(); } };
    },
  }, { onState: (s) => p2p.states.push(s) });
  return p2p;
}

function guest(code: string) {
  const p2p = { status: [] as string[], closes: [] as (number | null)[], types: [] as string[], biggest: 0, silent: [] as boolean[], say: (m: ClientMsg) => s.send(JSON.stringify(m)), leave: () => s.close(1000) };
  const s = peerMake({ onHostSilent: (v) => p2p.silent.push(v) })(code);
  s.onopen = () => { p2p.status.push('open'); p2p.say({ t: 'hello', charId: 1 }); };
  s.onclose = (e) => { p2p.closes.push(e.code ?? null); };
  s.onmessage = (e) => {
    const d = e.data as string;
    p2p.types.push((JSON.parse(d) as ServerMsg).t);
    p2p.biggest = Math.max(p2p.biggest, d.length);
  };
  return p2p;
}

(window as unknown as { __p2p: unknown }).__p2p = q.get('role') === 'host' ? await host() : guest(q.get('code')!);
