// 방장 = 자리 0(PRD §9.5 '방장 = 자리 0', §8-15)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Direct, Remote, fakeClock, flush, freeze, mustOpen, newHost, started } from './helpers';

beforeEach(fakeClock);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('원격 hello 보류', () => {
  it('P1E11 방장이 앉기 전 원격 hello 는 연결마다 마지막 하나만 보류 → 방장 welcome 직후 도착 순서대로', async () => {
    const { host } = await newHost();
    const direct = new Direct(host);
    const [a, b] = [new Remote(host), new Remote(host)];
    for (const charId of [1, 2, 3]) a.say({ t: 'hello', charId });
    b.say({ t: 'hello', charId: 5 });
    expect(host.room.rec!.seats.every((s) => !s.claimed)).toBe(true);
    expect([...a.of('welcome'), ...b.of('welcome'), ...a.of('error')]).toEqual([]);
    await direct.say({ t: 'hello', charId: 0 });
    expect(direct.last('welcome')!.seat).toBe(0);
    expect([a.last('welcome')!.seat, b.last('welcome')!.seat]).toEqual([1, 2]);
    expect(host.room.rec!.seats.map((s) => s.charId)).toEqual([0, 3, 5, 0]);
    expect(host.room.rec!.hostSeat).toBe(0);
    const late = new Remote(host); // 방장이 앉은 뒤엔 바로
    late.say({ t: 'hello', charId: 4 });
    expect(late.last('welcome')!.seat).toBe(3);
  });

  it('P1E11 보류한 채 끊긴 연결은 자리를 받지 않는다. 방장 판에 hello 를 못 넘기는 동안에도 다른 메시지는 그대로', async () => {
    const { host } = await newHost();
    const direct = new Direct(host);
    const [a, b] = [new Remote(host), new Remote(host)];
    a.say({ t: 'hello', charId: 1 });
    b.say({ t: 'hello', charId: 2 });
    b.say({ t: 'start' });
    expect(b.last('error')!.code).toBe('notHost');
    b.port.message('{');
    expect(b.last('error')!.code).toBe('bad');
    a.port.closed();
    await direct.say({ t: 'hello', charId: 0 });
    expect(b.last('welcome')!.seat).toBe(1);
    expect(host.room.rec!.seats.filter((s) => s.claimed).length).toBe(2);
  });
});

describe('자리 0 복귀', () => {
  it('P1E12 원격 rejoin 자리 0 은 PIN 이 맞아도·6번 틀려도 error pin 뿐, 방장은 그대로', async () => {
    const { host, direct, remotes } = await started(1);
    const pin = host.room.rec!.seats[0].pin;
    const before = JSON.stringify(host.room.rec);
    const kid = new Remote(host);
    kid.say({ t: 'rejoin', seat: 0, pin });
    for (let i = 0; i < 6; i++) kid.say({ t: 'rejoin', seat: 0, pin: pin === '0000' ? '1111' : '0000' });
    remotes[0].say({ t: 'rejoin', seat: 0, pin });
    await flush();
    expect(kid.of('error').map((e) => e.code)).toEqual(Array(7).fill('pin'));
    expect(remotes[0].last('error')!.code).toBe('pin');
    expect(kid.of('welcome')).toEqual([]);
    expect(JSON.stringify(host.room.rec)).toBe(before);
    expect(direct.closes).toEqual([]);
    const d2 = new Direct(host); // 방장 기기의 새 직결은 통과(옛 직결은 4000)
    await d2.say({ t: 'rejoin', seat: 0, pin });
    expect(d2.last('welcome')).toEqual({ t: 'welcome', seat: 0, pin });
    expect(direct.closes).toEqual([4000]);
    remotes[0].port.closed(); // 다른 자리의 원격 복귀는 지금 규칙 그대로
    const back = new Remote(host);
    back.say({ t: 'rejoin', seat: 1, pin: host.room.rec!.seats[1].pin });
    expect(back.last('welcome')!.seat).toBe(1);
  });

  it('P1E13 다시 열면 rec 에서 자리 0 의 PIN 을 내준다(tw.seat 와 무관). 그 PIN 은 원격 어디에도 안 나간다', async () => {
    const { host, deps, store, code } = await started(1);
    store.data.set('tw.seat', JSON.stringify({ roomCode: 'ZZZZZZ', seatNo: 2, seatPin: '9999' }));
    const pin = host.room.rec!.seats[0].pin;
    host.close();
    freeze(60_000);
    const again = await mustOpen(code, deps);
    expect(again.hostRejoin()).toEqual({ seat: 0, pin });
    const direct = new Direct(again);
    const kid = new Remote(again);
    kid.say({ t: 'rejoin', seat: 1, pin: again.room.rec!.seats[1].pin });
    await direct.say({ t: 'rejoin', ...again.hostRejoin()! });
    expect(direct.last('welcome')).toEqual({ t: 'welcome', seat: 0, pin });
    await direct.say({ t: 'resume' });
    await direct.say({ t: 'pause' });
    expect(kid.last('pins')!.pins).toEqual([{ seat: 1, pin: again.room.rec!.seats[1].pin }]);
    expect(kid.sent.some((m) => JSON.stringify(m).includes(`"${pin}"`))).toBe(false);
  });

  it('P1bE13 다시 연 대기실·진행 중 판에 직결 hello: 자리 0 의 rejoin 으로 넘긴다(자리 1 을 차지하지 않는다)', async () => {
    const lobby = await newHost();
    await new Direct(lobby.host).say({ t: 'hello', charId: 2 });
    const playing = await started(1);
    for (const s of [lobby, playing]) {
      const seats = JSON.parse(JSON.stringify(s.host.room.rec!.seats));
      s.host.close();
      const again = await mustOpen(s.code, s.deps);
      const d = new Direct(again);
      await d.say({ t: 'hello', charId: 5 });
      expect(d.last('welcome')).toEqual({ t: 'welcome', seat: 0, pin: seats[0].pin });
      expect(again.room.rec!.seats[0]).toMatchObject({ claimed: true, connected: true, charId: seats[0].charId });
      expect(again.room.rec!.seats.slice(1).map((x) => x.claimed)).toEqual(seats.slice(1).map((x: { claimed: boolean }) => x.claimed));
      for (const t of [s === lobby ? 'start' : 'resume', 'pause', 'end']) await d.say({ t });
      expect(d.of('error')).toEqual([]);
      expect(again.room.rec).toBeNull();
    }
  });

  it('P1bE13 직결로 다른 자리 rejoin: 맞는 PIN 이어도 error pin, 자리 상태 변화 0', async () => {
    const { host, deps, code } = await started(1);
    host.close();
    const again = await mustOpen(code, deps);
    const d = new Direct(again);
    const before = JSON.stringify(again.room.rec!.seats);
    await d.say({ t: 'rejoin', seat: 1, pin: again.room.rec!.seats[1].pin });
    expect(d.last('error')!.code).toBe('pin');
    expect(d.of('welcome')).toEqual([]);
    expect(JSON.stringify(again.room.rec!.seats)).toBe(before);
  });

  it('P1E13 방장이 아직 안 앉은 방은 줄 PIN 이 없다', async () => {
    const { host } = await newHost();
    expect(host.hostRejoin()).toBeNull();
  });
});
