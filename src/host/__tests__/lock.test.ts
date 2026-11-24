// 같은 기기 두 탭(PRD §9.5 '같은 기기 두 탭')
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { acquireLock } from '../lock';
import { SETTINGS } from '../../../worker/__tests__/fakes';
import { createHostRoom } from '../host-room';
import { hostKey } from '../storage';
import { Direct, FakeLocks, fakeClock, fakeDeps, freeze, mustOpen, newHost, reopen, tick } from './helpers';

beforeEach(fakeClock);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** 신선도 길은 한 번 다시 보려고 기다린다 */
async function waited<T>(p: Promise<T>) { await tick(3_500); return p; }

describe('탭 잠금', () => {
  it('P1E10 잠금을 잡은 탭만 방을 돌린다. 다른 탭은 busy + 저장소 읽기·쓰기 0, 첫 탭이 닫히면 열 수 있다', async () => {
    const { host, deps, store, code } = await newHost();
    await tick(10_000);
    const n = store.ops.length;
    expect(await reopen(code, deps)).toBe('busy');
    expect(store.ops.length).toBe(n);
    expect([...deps.locks!.held]).toEqual([`tw.host.${code}`]);
    host.close();
    const again = await mustOpen(code, deps);
    expect(again.room.rec!.code).toBe(code);
    expect(await reopen(code, deps)).toBe('busy');
  });

  it('P1E10 navigator.locks 가 없으면 alive 3초 신선도로 같은 결과', async () => {
    const { host, deps, code } = await newHost(fakeDeps(undefined, null));
    await tick(2_500);
    expect(await waited(reopen(code, deps))).toBe('busy');
    host.close();
    freeze(3_100);
    const again = await mustOpen(code, deps);
    expect(again.room.rec!.code).toBe(code);
    expect(await waited(reopen(code, deps))).toBe('busy'); // 연 탭이 바로 alive 를 적는다
  });

  it('P1E10 잠금 요청 자체가 막히면(SecurityError) 신선도로', async () => {
    const locks = new FakeLocks();
    vi.spyOn(locks, 'request').mockRejectedValue(new Error('SecurityError'));
    const { host, deps, code } = await newHost(fakeDeps(undefined, locks));
    expect(await waited(reopen(code, deps))).toBe('busy');
    host.close();
    freeze(60_000);
    expect(typeof await reopen(code, deps)).toBe('object');
  });

  for (const blocked of [false, true]) {
    const why = blocked ? '잠금 요청이 막힘' : 'navigator.locks 없음';
    const make = async () => {
      const locks = blocked ? new FakeLocks() : null;
      if (locks) vi.spyOn(locks, 'request').mockRejectedValue(new Error('SecurityError'));
      return newHost(fakeDeps(undefined, locks));
    };

    it(`P1bE08 ${why}: 닫은 지 1초 뒤 다시 열면 alive 가 3초를 넘길 때까지 기다렸다가 멈춘 판으로 연다`, async () => {
      const { host, deps, store, code } = await make();
      const d = new Direct(host);
      await d.say({ t: 'hello', charId: 0 });
      await d.say({ t: 'start' });
      await tick(5_000);
      host.close();
      freeze(1_000);
      const t = Date.now();
      let opened: Awaited<ReturnType<typeof reopen>> | null = null;
      void reopen(code, deps).then((r) => { opened = r; });
      const n = store.touched(code);
      await tick(1_900);
      expect(opened).toBeNull();
      expect(store.touched(code)).toBe(n);
      while (!opened && Date.now() - t < 10_000) await tick(50);
      expect(Date.now() - t).toBeLessThanOrEqual(3_500);
      expect(typeof opened).toBe('object');
      const h = opened as unknown as typeof host;
      expect(h.room.game!.phase).toBe('paused');
      expect(h.room.rec!.seats[0].connected).toBe(false);
    });

    it(`P1bE09 ${why}: 다른 탭이 돌리는 중이면 한 번만 다시 보고 busy, 쓰기·지우기 0, 남는 타이머 0`, async () => {
      const { host, deps, store, code } = await make();
      await tick(2_500);
      const t = Date.now();
      const timers = vi.getTimerCount();
      const reads = () => store.ops.filter((o) => o === `get ${hostKey(code, 'alive')}`).length;
      const r0 = reads();
      let got: unknown = null;
      const own = vi.spyOn(host.storage, 'putAlive'); // 첫 탭의 심박은 흉내만(쓰기 수에 섞이지 않게)
      own.mockImplementation((at) => { store.data.set(hostKey(code, 'alive'), String(at)); });
      const n = store.touched(code);
      void reopen(code, deps).then((r) => { got = r; });
      while (!got && Date.now() - t < 10_000) await tick(50);
      expect(got).toBe('busy');
      expect(Date.now() - t).toBeLessThanOrEqual(3_500);
      expect(reads() - r0).toBeLessThanOrEqual(3); // 신선한지 · 얼마나 기다릴지 · 다시 한 번
      await tick(10_000);
      expect(reads() - r0).toBeLessThanOrEqual(3);
      expect(store.touched(code)).toBe(n);
      expect(vi.getTimerCount()).toBe(timers);
    });
  }

  it('P1bE09 다시 보는 때는 탭마다 흔들리고(0~0.25초) 기다림은 3.5초를 넘지 않는다', async () => {
    const { host, deps, code } = await newHost(fakeDeps(undefined, null));
    host.close();
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.999);
    const t = Date.now();
    const got: [string, number][] = [];
    for (let i = 0; i < 2; i++) void reopen(code, deps).then((r) => { got.push([typeof r === 'string' ? r : 'open', Date.now() - t]); });
    while (got.length < 2 && Date.now() - t < 10_000) await tick(10);
    expect(got.map(([r]) => r)).toEqual(['open', 'busy']);
    expect(got[0][1]).toBe(3_100);
    expect(got[1][1]).toBeGreaterThan(3_300);
    expect(got[1][1]).toBeLessThanOrEqual(3_500);
  });

  it('P1bE09 Web Locks 로 막히면 기다리지 않고 바로 busy', async () => {
    const { deps, code } = await newHost();
    const timers = vi.getTimerCount();
    const t = Date.now();
    expect(await reopen(code, deps)).toBe('busy');
    expect(Date.now()).toBe(t);
    expect(vi.getTimerCount()).toBe(timers);
  });

  it('P1bE09 createHostRoom 은 다시 보지 않고 다른 코드를 뽑는다', async () => {
    const deps = fakeDeps(undefined, null);
    deps.store.data.set(hostKey('AAAAAA', 'alive'), String(Date.now())); // room 은 아직 안 쓴 다른 탭
    const seq = ['AAAAAA', 'BBBBBB'];
    const host = await createHostRoom(SETTINGS, deps as never, () => seq.shift()!);
    expect(host!.code).toBe('BBBBBB');
  });

  it.skipIf(!globalThis.navigator?.locks)('P1E10 진짜 Web Locks 로도 한 탭만', async () => {
    vi.useRealTimers();
    const [a, b] = [await acquireLock('REALAA', null, navigator.locks), await acquireLock('REALAA', null, navigator.locks)];
    expect(a).toBeTypeOf('function');
    expect(b).toBeNull();
    a!();
    await new Promise((r) => setTimeout(r, 20));
    const c = await acquireLock('REALAA', null, navigator.locks);
    expect(c).toBeTypeOf('function');
    c!();
  });
});
