// 로비(PRD §8-2, v3 08): 방 코드 알약, 자리 4칸(빈자리는 로봇), 캐릭터 6종 고르기, 방장의 시작 버튼.
import { useEffect, useRef, useState } from 'preact/hooks';
import { audio } from '../../audio/engine';
import { AssetImg, Pic } from '../../assets/AssetImg';
import { PIN_RE } from '../../shared/protocol';
import type { Seat } from '../../shared/types';
import type { GameClient } from '../../state/client';
import { josa } from '../../state/nick';
import type { ClientState } from '../../state/store';
import { seatViews } from '../../state/view';
import { HostWait } from '../overlays/HostWait';
import { SignButton } from '../overlays/ScrollPanel';
import { SoundSign } from '../overlays/SoundSign';
import { Rules } from './Rules';
import '../../styles/screens.css';

const CHARS = [0, 1, 2, 3, 4, 5];

export function CodePill({ code }: { code: string }) {
  return (
    <div class="code-pill" aria-label={`방 코드 ${code.split('').join(' ')}`}>
      {code.split('').map((c, i) => <span key={i} class="code-box">{c}</span>)}
    </div>
  );
}

/** 저장이 안 되는 방장 기기(§8-20 ③): 대기실에서는 줄, 판에서는 띠(app.tsx) */
export const SAVE_TEXT = {
  never: '이 기기에는 놀이를 저장할 수 없어요. 창을 닫으면 이어 할 수 없어요',
  stopped: '지금부터는 놀이가 저장되지 않아요. 창을 닫으면 조금 전으로 돌아가요',
};

/** 방장 기기: 코드는 등록된 뒤에만 보인다(PRD §8-2). 등록이 안 되면 §8-19 안내 — 출발은 할 수 있다 */
function NoCode({ failed, onAgain }: { failed: boolean; onAgain: () => void }) {
  return (
    <div class="code-pill code-pill--note">
      <p role="status">
        {failed ? <>친구 기기와 연결할 수 없어요. 인터넷이나 학교 와이파이를 확인해 주세요<br />로봇과 함께라면 지금 시작할 수 있어요</> : '코드를 준비하고 있어요…'}
      </p>
      {failed && <button type="button" class="ov-btn ov-btn--secondary ov-btn--small" data-act="net-again" onClick={onAgain}>다시 연결해 보기</button>}
    </div>
  );
}

export function Lobby({ client, s }: { client: GameClient; s: ClientState }) {
  const room = s.room!;
  const seats = seatViews(room);
  const [rules, setRules] = useState(false);
  const [asked, setAsked] = useState<number | null>(null);
  const takenChars = room.seats.filter((x) => x.taken).map((x) => x.charId);
  const host = s.seat !== null && s.seat === room.hostSeat;
  const full = room.seats.every((x) => x.taken);
  const coded = !s.host || s.host.net === 'open';
  // U16 §21.2: 로비 곡(입장과 같은 곡이라 끊김 0) · 자리가 채워지면 착지 '툭'
  useEffect(() => { audio.playBgm('bgm.lobby'); }, []);
  const filled = room.seats.filter((x) => x.taken).length;
  const wasFilled = useRef(filled);
  useEffect(() => { if (filled > wasFilled.current) audio.playSfx('land'); wasFilled.current = filled; }, [filled]);

  return (
    <main class="sc sc--lobby">
      <AssetImg k="ui.boardBg" class="sc-bg" />
      <div class="sc-wrap lobby">
        {coded ? <CodePill code={room.code} /> : <NoCode failed={s.host!.net !== 'wait'} onAgain={() => client.retryHost()} />}
        <p class="lobby-sub">{room.settings.totalMinutes}분 놀이{coded && ' · 친구에게 코드를 알려 주세요'}</p>
        {/* 고르는 중에는 캐릭터 줄까지 높이가 꽉 차 있다(1366×768) → 앉은 뒤부터 */}
        {s.host && s.seat !== null && (s.host.save === 'ok'
          ? <p class="lobby-sub" data-k="host-keep">이 기기가 방을 지켜요. 놀이가 끝날 때까지 이 창을 닫거나 다른 앱으로 가지 마세요</p>
          : <p class="lobby-sub" role="status" data-save={s.host.save}>{SAVE_TEXT[s.host.save]}</p>)}
        <section class="sc-glass lobby-seats" aria-label="자리">
          {seats.map((v) => (
            <div key={v.seat} class={`lb-slot${v.seat === s.seat ? ' is-me' : ''}`} data-seat={v.seat} style={{ '--seat': `var(--seat-${v.seat + 1})` }}>
              {/* v3 08: 위 70% = P01 1024 반신 크롭(빈자리는 로봇 CH7), 아래 = 자리색 띠 + 원 */}
              <div class="lb-slot-art">
                <Pic base k={`char.${v.charId}.p01.big`} class={`lb-slot-char${v.charId === 7 ? ' lb-slot-char--bot' : ''}`} fallback={<AssetImg k={`char.${v.charId}.f00`} class="lb-slot-face" alt="" />} />
                <span class="lb-slot-band">{v.seat + 1}번{v.seat === room.hostSeat && v.taken ? ' · 방장' : ''}</span>
              </div>
              <div class="lb-slot-foot">
                <i class="lb-slot-dot" aria-hidden="true" />
                <b class="lb-slot-name">{v.taken ? v.name : '빈자리'}</b>
                <span class="lb-slot-state">{v.taken ? (v.seat === s.seat ? '나' : v.connected ? '준비됐어요' : '잠시 나갔어요') : '로봇이 함께해요'}</span>
              </div>
            </div>
          ))}
        </section>

        {s.seat === null ? (
          <section class="lobby-pick" aria-label="캐릭터 고르기">
            <h2>{full ? '자리가 다 찼어요' : '함께 여행할 친구를 골라요'}</h2>
            <div class="pick-row">
              {CHARS.map((c) => (
                <button type="button" key={c} class="pick" data-char={c} aria-pressed={asked === c}
                  disabled={full || takenChars.includes(c) || (asked !== null && !s.error)} onClick={() => { setAsked(c); client.join(c); }}>
                  <AssetImg k={`char.${c + 1}.f00`} class="pick-face" alt={`탐험가 ${c + 1}`} />
                </button>
              ))}
            </div>
            {s.error === 'full' && <p class="sc-msg" role="alert">자리가 다 찼어요. 다른 방 코드를 입력해 주세요.</p>}
          </section>
        ) : (
          <div class="lobby-go">
            {host
              ? <button type="button" class="start-btn" data-act="start" onClick={() => { audio.playSfx('fly'); client.send({ t: 'start' }); }}><span class="start-tri" aria-hidden="true" />출발하기</button>
              : <p class="sc-note-line" role="status">{josa(seats[room.hostSeat].name, '이', '가')} 출발을 누르면 바로 시작해요</p>}
          </div>
        )}
        <div class="lobby-signs"><SoundSign /><SignButton label="규칙 보기" onClick={() => setRules(true)}><b class="sign-q">?</b></SignButton></div>
      </div>
      {rules && <Rules onClose={() => setRules(false)} />}
      {s.away !== null && <HostWait onHome={() => client.home()} />}
    </main>
  );
}

/** 이미 시작한 방에 처음 보는 기기로 왔다: 자리 번호를 고르고 저장 화면에서 찍어 둔 PIN 4자리를 넣는다 */
export function PinEntry({ client, s }: { client: GameClient; s: ClientState }) {
  const seats = seatViews(s.room!);
  useEffect(() => { audio.playBgm('bgm.lobby'); }, []); // PIN 입력도 로비 곡
  const [seat, setSeat] = useState<Seat | null>(null);
  const [pin, setPin] = useState('');
  const ok = seat !== null && PIN_RE.test(pin);
  const err = s.error === 'pin' ? '번호가 맞지 않아요. 찍어 둔 사진을 다시 봐 주세요.'
    : s.error === 'locked' ? '여러 번 틀렸어요. 1분 쉬었다가 다시 해 봐요.' : '';
  return (
    <main class="sc sc--pin">
      <AssetImg k="ui.boardBg" class="sc-bg" />
      <form class="sc-glass pin-box" onSubmit={(e) => { e.preventDefault(); if (ok) client.claim(seat!, pin); }}>
        <h1>내 자리로 돌아가기</h1>
        <p>이미 시작한 방이에요. 내 자리를 고르고 비밀번호 4자리를 넣어 주세요.</p>
        <div class="pin-seats" role="radiogroup" aria-label="내 자리">
          {seats.map((v) => (
            <button type="button" role="radio" key={v.seat} class="pin-seat" aria-checked={seat === v.seat} onClick={() => setSeat(v.seat)}
              style={{ '--seat': `var(--seat-${v.seat + 1})` }}>
              <AssetImg k={`char.${v.charId}.f00`} class="pin-face" alt="" />
              <span>{v.seat + 1}번 · {v.name}</span>
            </button>
          ))}
        </div>
        <label class="entry-label" for="seat-pin">비밀번호 4자리</label>
        <input id="seat-pin" class="code-input pin-input" type="text" inputMode="numeric" autoComplete="off" maxLength={4} pattern="[0-9]{4}"
          value={pin} onInput={(e) => setPin((e.target as HTMLInputElement).value.replace(/[^0-9]/g, '').slice(0, 4))} />
        {err && <p class="sc-msg" role="alert">{err}</p>}
        <div class="pin-btns">
          <button type="submit" class="ov-btn ov-btn--primary" disabled={!ok}>돌아가기</button>
          <button type="button" class="ov-btn ov-btn--secondary" onClick={() => client.leave()}>처음 화면으로</button>
        </div>
      </form>
    </main>
  );
}
