// PeerJS 를 부르는 유일한 파일(만들기·연결 사건) + 학생 쪽 연결: RoomSocket 의 make 에 꽂는 SocketLike(PRD §9.5).
import Peer, { type DataConnection } from 'peerjs';
import type { ClientMsg } from '../shared/protocol';
import { CONNECT_OPTIONS, FRAME_V, hostId, NET, PEER_OPTIONS } from './config';
import { Assembler, parseFrame, type Frame } from './frames';
import type { SocketLike } from './socket';

/** id 가 없으면 시그널링 서버가 임의 값을 준다 */
export const newPeer = (id?: string) => (id ? new Peer(id, PEER_OPTIONS) : new Peer(PEER_OPTIONS));

/** PeerJS 연결의 사건을 셋으로: 열림 · 데이터 · 끝(한 번). max = 이보다 큰 프레임은 JSON 으로 풀지 않고 틀이 아닌 값으로 */
export function bindConn(dc: DataConnection, on: { open(): void; data(x: unknown): void; end(): void }, max = Infinity) {
  // PeerJS JSON 채널은 JSON 이 아닌 것·null 에 예외만 던지고 data 를 안 낸다(peerjs 1.5.5 bundler.mjs 1395~1404행) → 틀이 아닌 값(0)으로 넘긴다
  const utf8 = new TextDecoder();
  Object.assign(dc, {
    decoder: { decode: (d: unknown) => d },
    parse: (d: string | ArrayBuffer): unknown => { if ((typeof d === 'string' ? d.length : d.byteLength) > max) return 0; try { return JSON.parse(typeof d === 'string' ? d : utf8.decode(d)) ?? 0; } catch { return 0; } },
  });
  let ended = false;
  const end = () => { if (!ended) { ended = true; on.end(); } };
  dc.on('open', on.open);
  dc.on('data', on.data);
  dc.on('close', end);
  // 보내기 오류는 채널을 닫지 않는다. 열리기 전 협상 실패는 close 없이 error 만 온다
  dc.on('error', (e) => { if (e.type !== 'message-too-big' && e.type !== 'not-open-yet') end(); });
}

/** 학생: 방 코드로 방장에게 붙는 소켓을 만드는 함수. onHostSilent = 방장 신호가 끊김/돌아옴(연결은 그대로, §8-18) */
export function peerMake(o: { onHostSilent?: (silent: boolean) => void } = {}): (code: string) => SocketLike {
  let silent = false;
  const setSilent = (v: boolean) => { if (v !== silent) { silent = v; o.onHostSilent?.(v); } };
  /** 끝났지만 마지막 프레임을 흘려보내는 앞 소켓 정리. 새로 이을 때 남기지 않는다 */
  let sweep = () => {};

  return (code) => {
    sweep();
    const peer = newPeer();
    let dc: DataConnection | undefined;
    let beat: ReturnType<typeof setInterval> | undefined;
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let dead: ReturnType<typeof setTimeout> | undefined = setTimeout(() => finish(), NET.openMs);
    const put = (f: Frame) => { void dc!.send(f); };
    const asm = new Assembler(
      (d) => s.onmessage?.({ data: d }),
      () => put({ t: 'm', d: JSON.stringify({ t: 'sync' } satisfies ClientMsg) }),
    );

    const s: SocketLike = {
      readyState: 0, onopen: null, onclose: null, onmessage: null, onerror: null,
      send: (d) => { if (s.readyState === 1) put({ t: 'm', d }); },
      close: (c) => {
        if (s.readyState === 1) dc!.close({ flush: true }); // 닫기 직전에 보낸 것(leave)을 버리지 않게
        finish(c, s.readyState === 1);
        setSilent(false);
      },
    };

    const kill = () => {
      clearTimeout(dead);
      // 서버가 ID 를 주기 전에 부수면 PeerJS 가 그 뒤에 시그널링 소켓을 열어 둔다(bundler.mjs _initialize) → ID 를 받은 뒤 부순다.
      // 시그널링이 끊겨도 id 가 비므로(같은 파일 1762~1772행) 끊김 상태를 함께 본다
      if (peer.id || peer.disconnected || peer.destroyed) peer.destroy();
      else peer.on('open', () => peer.destroy());
    };
    /** 이 소켓을 끝낸다(한 번). linger = 마지막 프레임이 나가도록 실제 연결을 잠깐 둔다 */
    const finish = (c?: number, linger = false) => {
      if (s.readyState === 3) return;
      s.readyState = 3;
      clearInterval(beat);
      clearTimeout(quiet);
      clearTimeout(dead);
      asm.clear();
      if (linger) { dead = setTimeout(kill, NET.closeWaitMs); sweep = kill; } else kill();
      queueMicrotask(() => s.onclose?.({ code: c }));
    };
    const heard = () => {
      setSilent(false);
      clearTimeout(quiet);
      clearTimeout(dead);
      quiet = setTimeout(() => setSilent(true), NET.silentMs);
      dead = setTimeout(() => finish(), NET.deadMs);
    };

    // 붙은 뒤의 시그널링 오류는 이미 맺은 연결과 무관하다. 맺는 중의 webrtc 는 후보 하나의 실패일 수 있다(20초 시한이 덮는다)
    peer.on('error', (e) => { if (s.readyState === 0 && e.type !== 'webrtc') finish(); });
    peer.on('open', () => {
      if (s.readyState !== 0) return;
      bindConn(dc = peer.connect(hostId(code), CONNECT_OPTIONS), {
        open: () => {
          if (s.readyState !== 0) return;
          s.readyState = 1;
          put({ t: 'h', v: FRAME_V, code });
          beat = setInterval(() => put({ t: 'b' }), NET.beatMs);
          heard();
          s.onopen?.({});
        },
        data: (x) => {
          if (s.readyState !== 1) return;
          heard();
          const f = parseFrame(x);
          if (f?.t === 'm') s.onmessage?.({ data: f.d });
          else if (f?.t === 'p') asm.add(f);
          else if (f?.t === 'c') { put({ t: 'a' }); finish(f.code, true); }
        },
        end: () => { if (s.readyState === 3) kill(); else finish(); },
      });
    });
    return s;
  };
}
