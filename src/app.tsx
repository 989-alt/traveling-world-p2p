// 화면 고르기: 서버 상태 하나로 입장 → 로비 → 게임/저장/재개/끝 을 정한다.
import { useEffect, useRef, useState } from 'preact/hooks';
import { ROTATE_WIDE, boardKeys, bootKeys, gameStartKeys } from './assets/manifest';
import { preload } from './assets/preload';
import { armOnFirstGesture, audio } from './audio/engine';
import { FullscreenButton } from './ui/device/FullscreenButton';
import { armFullscreenOnFirstGesture } from './ui/device/fullscreen';
import { holdWakeLock } from './ui/device/wake-lock';
import { sweepRooms } from './host/storage';
import { TRANSPORT } from './net/config';
import { GameClient, useClient } from './state/client';
import { hostCover } from './state/store';
import { Connecting, Entry, Replaced } from './ui/screens/Entry';
import { Game } from './ui/screens/Game';
import { MONO } from './ui/board/Board';
import { Lobby, PinEntry, SAVE_TEXT } from './ui/screens/Lobby';
import { Finished, OldBoardNotice, Paused } from './ui/screens/Pause';

export const client = new GameClient();
/** 끝낸 뒤 첫 화면 띠 시간(tokens duration.banner-end) */
const BANNER_END_MS = 4_000;

export function App() {
  const s = useClient(client);
  useEffect(() => {
    armOnFirstGesture(); // T11: 첫 터치에서 소리 잠금 풀기
    armFullscreenOnFirstGesture(); // U7: 첫 탭에서 전체 화면(휴대폰 상단바 숨김) · 가로 고정. 거부되면 그냥 진행
    sweepRooms(); // 14일 지난 방 청소(PRD §9.5). 자동 복귀보다 먼저
    client.resumeSaved();
    const vis = () => { if (!document.hidden) client.resync(); };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, []);

  const phase = s.room?.phase;
  // 독점승(DESIGN §16.5): 엔진은 독점과 같은 갱신에서 판을 끝낸다(서버 기준 그대로). 이 기기가 진행 중에 그 갱신을 받았으면
  // 보드를 3.0초(모션 줄이기 2초) 더 두어 독점 연출을 보이고 결과로 넘어간다. 재접속·전체 다시 받기로 처음 본 '끝'은 바로 결과.
  const lastPhase = useRef(phase);
  const holdUntil = useRef(0);
  const [, rerender] = useState(0);
  if (lastPhase.current === 'playing' && phase === 'finished' && !s.resynced && s.fresh.some((e) => e.ev === 'event' && e.kind === 'monopoly')) {
    const reduced = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    holdUntil.current = Date.now() + (reduced ? MONO.reducedBanner : MONO.end);
  }
  // U16 §21.2.2: 놀이 시간이 다 돼 판이 끝나는 갱신 → 학교 종(결과 화면 직전)
  if (lastPhase.current === 'playing' && phase === 'finished' && !s.resynced && s.fresh.some((e) => e.ev === 'clock' && e.kind === 'end' && e.by === 'timeout')) audio.playSfx('bell');
  lastPhase.current = phase;
  const monoHold = phase === 'finished' && Date.now() < holdUntil.current;
  useEffect(() => {
    if (!monoHold) return;
    const h = setTimeout(() => rerender((x) => x + 1), holdUntil.current - Date.now() + 20);
    return () => clearTimeout(h);
  }, [monoHold]);
  // U14: 방장이 끝내서 첫 화면으로 온 기기는 띠 "방장이 게임을 끝냈어요" 4초(DESIGN §20.3, 토큰 duration.banner-end)
  useEffect(() => {
    if (!s.bye) return;
    const h = setTimeout(() => client.dismissBye(), BANNER_END_MS);
    return () => clearTimeout(h);
  }, [s.bye]);
  const awake = !!phase && phase !== 'finished';
  useEffect(() => (awake ? holdWakeLock() : undefined), [awake]);
  const started = useRef(false);
  useEffect(() => {
    // U4: 세로 안내 가로판은 ui.rotate 와 같이 첫 로드에 받되, 움직임을 줄인 기기는 요청하지 않는다(DESIGN §4.2)
    const motion = typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (phase === 'lobby') void preload(motion ? [...bootKeys(), ROTATE_WIDE] : bootKeys()).then(() => preload(boardKeys())); // 판 그림은 첫 로드 뒤 이어서(R4)
    // 로비를 거치지 않고 판에 들어온 경우(새로고침·재접속·PIN 복귀)도 판 그림을 먼저 받는다(Game 은 받는 동안 '판 펼치는 중')
    if (phase && phase !== 'lobby' && !started.current) { started.current = true; void preload(boardKeys()).then(() => preload(gameStartKeys())); } // T11 인계
  }, [phase]);

  // 방장 기다림(§8-18)을 그리는 화면은 대기실과 판뿐: 이어 하기·자리 번호 화면에는 끊김 띠가 다시 이어질 때까지 남는다
  const resuming = phase === 'paused' && !s.pins;
  const waitShown = s.away !== null && (phase === 'lobby' || (s.seat !== null && !resuming));

  return (
    <div class="app" data-phase={phase ?? 'entry'} data-mono-hold={monoHold ? '1' : undefined} data-conn={s.conn}>
      {screen()}
      <FullscreenButton />
      {s.room && !waitShown && (s.conn === 'connecting' || s.conn === 'retrying' || (s.conn === 'open' && s.away !== null)) && (
        <p class="net-banner" role="alert">연결이 잠깐 끊겼어요. 다시 잇는 중이에요…</p>
      )}
      {s.bye === 'ended' && <p class="net-banner net-banner--bye" role="status" data-bye="ended">방장이 게임을 끝냈어요</p>}
      {s.host && s.host.save !== 'ok' && s.room && phase !== 'lobby' && phase !== 'finished' && (
        <p class="net-banner net-banner--bye" role="status" data-save={s.host.save}>{SAVE_TEXT[s.host.save]}</p>
      )}
    </div>
  );

  /** 방에 들어가는 중. 계속 안 이어지면(없는 방·꺼진 방장·인터넷 끊김) 돌아갈 길을 준다 */
  function joining() {
    if (TRANSPORT === 'ws' && s.conn === 'retrying') return { text: '방에 들어갈 수 없어요. 코드가 맞는지, 인터넷이 잘 되는지 확인해 주세요.', onBack: () => client.leave() };
    if (s.late) return { text: '방에 들어갈 수 없어요. 코드가 맞는지, 방장 기기가 켜져 있는지 확인해 주세요. 학교 와이파이에서 안 되면 선생님께 알려 주세요', onBack: () => client.home() };
    return { text: '방에 들어가는 중이에요…', onBack: s.host ? undefined : () => client.home() }; // 방장은 곧 앉는다
  }

  function screen() {
    if (!s.code) return <Entry client={client} />;
    if (s.conn === 'replaced') return <Replaced onAgain={() => { if (!client.resumeSaved()) client.leave(); }} />;
    const cover = hostCover(s);
    if (cover === 'busy') return <Connecting text="이 방은 다른 창에서 열려 있어요. 그 창에서 계속해 주세요" onBack={() => client.home()} />;
    if (cover === 'stuck') return <Connecting text="방을 다시 열지 못했어요" code={s.code} onAgain={() => client.retryHost()} onBack={() => client.giveUp()} />;
    if (cover === 'opening') return <Connecting text="방을 다시 여는 중이에요…" />;
    if (!s.room) return <Connecting {...joining()} />;
    if (s.room.phase === 'lobby') return <>{s.room.notice && <OldBoardNotice kind={s.room.notice} />}<Lobby client={client} s={s} /></>;
    if (s.seat === null) return <PinEntry client={client} s={s} />;
    // U14: 멈춘 순간 판에 있던 기기(자리 PIN 을 받음)는 판 위 멈춤 모달, 다시 들어온 기기는 이어 하기 화면
    if (resuming) return <Paused client={client} s={s} />;
    if (s.room.phase === 'finished' && !monoHold) return <Finished client={client} s={s} />;
    return <Game client={client} s={s} ending={monoHold} />;
  }
}
