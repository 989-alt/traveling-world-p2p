// 거울이 꺼진 세션 다음에 앱을 열 때(PRD §9.5 거울, P2P-7b): 진짜 HostRoom 저장 + 진짜 boot. 거울과 localStorage 만 가짜
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openMirror } from '../../host/mirror';
import { Direct, FakeLocks, FakeMirror, FakeStore, fakeClock, fakeDeps, flush, mustOpen, quotaError, started, tick } from '../../host/__tests__/helpers';

import { GameClient } from '../client';
import { loadSeat, saveSeat } from '../seat-store';

beforeEach(fakeClock);
afterEach(async () => {
  await openMirror(() => { throw new Error('끔'); });
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Off = '중간 꺼짐' | '처음부터 꺼짐';

/** 방장 기기: 방 하나가 거울에 있고(자리 0), 이번 세션은 거울이 꺼졌다 */
async function session(off: Off) {
  const m = new FakeMirror();
  const deps = fakeDeps(new FakeStore(), new FakeLocks());
  const { store } = deps;
  vi.stubGlobal('localStorage', store);
  vi.stubGlobal('navigator', { locks: deps.locks });
  await openMirror(() => m);
  const s = await started(0, deps);
  const { code } = s;
  const seat = { roomCode: code, seatNo: 0 as const, seatPin: s.host.room.rec!.seats[0].pin };
  saveSeat(seat);
  await tick(3_000);
  await flush();
  expect(m.of(code)).toEqual(store.of(code));
  let { host, direct } = s;
  if (off === '중간 꺼짐') {
    m.fail = quotaError();
    await tick(1_000);
    m.fail = null;
  } else {
    // 새로고침한 탭: 거울이 2초 안에 답하지 않는다
    host.close();
    await flush();
    let first = true;
    const p = openMirror(() => { if (!first) return m; first = false; return { all: () => new Promise(() => {}), write: (ops) => m.write(ops) }; });
    await tick(2_000);
    expect(await p).toBeNull();
    host = await mustOpen(code, deps);
    direct = new Direct(host);
    await direct.say({ t: 'rejoin', ...host.hostRejoin()! });
    await direct.say({ t: 'resume' });
  }
  const last = m.of(code);
  return { m, deps, store, code, seat, host, direct, last };
}

/** 다음 앱 열기(거울 켜짐) */
async function open(m: FakeMirror) {
  const opened: string[] = [];
  const c = new GameClient(() => ({ readyState: 0, send: () => {}, close: () => {}, onopen: null, onclose: null, onmessage: null, onerror: null }), undefined,
    async () => ({ createHost: async () => null, openHost: async (code: string) => { opened.push(code); return 'busy' as const; } }));
  await c.boot(() => m);
  await flush();
  const { code } = c.state;
  c.close();
  return { code, opened };
}

describe('P7bE03 꺼진 세션 × 한 일 × 다음 열기 켜짐 × localStorage', () => {
  for (const off of ['중간 꺼짐', '처음부터 꺼짐'] as const) for (const ls of ['그대로', '사라짐'] as const) {
    const on = `다음 열기 켜짐 × localStorage ${ls}`;
    const lose = (store: FakeStore) => { if (ls === '사라짐') store.data.clear(); };

    it(`P7bE03 ${off} × 새로 씀 × ${on}`, async () => {
      const r = await session(off);
      await r.direct.say({ t: 'pause' });
      await r.direct.say({ t: 'resume' });
      await tick(8_000);
      expect(r.m.of(r.code)).toEqual(r.last); // 방 데이터는 안 들어갔다
      r.host.close();
      await flush();
      const before = r.store.of(r.code);
      expect(Object.keys(before).length).toBeGreaterThan(Object.keys(r.last).length);
      lose(r.store);
      const got = await open(r.m);
      expect(got).toEqual({ code: r.code, opened: [r.code] });
      expect(r.store.of(r.code)).toEqual(ls === '그대로' ? before : r.last);
      expect(loadSeat()).toEqual(r.seat);
      const again = await mustOpen(r.code, r.deps); // 로그가 온전하지 않으면 열리지 않는다
      expect(again.room.rec!.logLen).toBe(again.room.game!.log.length);
    });

    it(`P7bE03 ${off} × 끝내기 × ${on}`, async () => {
      const r = await session(off);
      await r.direct.say({ t: 'end' });
      saveSeat(null); // 방장 화면이 첫 화면으로(client.finish)
      await flush();
      lose(r.store);
      expect(await open(r.m)).toEqual({ code: null, opened: [] });
      expect([r.store.keys(r.code), r.store.data.get('tw.seat'), r.m.of(r.code)]).toEqual([[], undefined, {}]);
    });

    for (const how of ['방 A 묘비 뒤 방 B 값', '묘비 없이 A→B'] as const) it(`P7bE03 ${off} × 자리 바꿈(${how}) × ${on}`, async () => {
      const r = await session(off);
      const b = { roomCode: 'GGGGGG', seatNo: 2 as const, seatPin: '1111' };
      await tick(1_000);
      if (how === '방 A 묘비 뒤 방 B 값') { saveSeat(null); await flush(); await tick(1_000); }
      saveSeat(b);
      await flush();
      r.host.close();
      await flush();
      lose(r.store);
      const got = await open(r.m);
      expect([got.code, loadSeat()]).toEqual(['GGGGGG', b]);
      expect(got.opened).toEqual([]); // 방장 길이 아니라 학생 길
    });
  }
});

describe('P7bE03 거울이 켜진 세션(대조)', () => {
  for (const ls of ['그대로', '사라짐'] as const) it(`P7bE03 켜짐 × 끝내기 × 다음 열기 켜짐 × localStorage ${ls}`, async () => {
    const m = new FakeMirror();
    const deps = fakeDeps();
    vi.stubGlobal('localStorage', deps.store);
    vi.stubGlobal('navigator', { locks: deps.locks });
    await openMirror(() => m);
    const s = await started(0, deps);
    saveSeat({ roomCode: s.code, seatNo: 0, seatPin: '0000' });
    await s.direct.say({ t: 'end' });
    saveSeat(null);
    await flush();
    if (ls === '사라짐') deps.store.data.clear();
    expect(await open(m)).toEqual({ code: null, opened: [] });
    expect(deps.store.keys(s.code)).toEqual([]);
  });
});
