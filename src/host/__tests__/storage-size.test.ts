// P1E20 한 판 저장 크기(PRD §9.5 '용량'): 봇 4명 판을 실제 문항 데이터로 끝까지. TW_MEASURE=1 이면 시드 여럿을 재어 숫자를 찍는다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TotalMinutes } from '../../shared/types';
import { SETTINGS, seedCrypto } from '../../../worker/__tests__/fakes';
import { hostKey } from '../storage';
import { fakeClock, started, tick } from './helpers';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function play(totalMinutes: TotalMinutes, seed: number) {
  fakeClock();
  vi.restoreAllMocks();
  seedCrypto(seed);
  const { host, store, code } = await started(0, undefined, { ...SETTINGS, totalMinutes });
  host.room.game = { ...host.room.game!, seats: host.room.game!.seats.map((s) => ({ ...s, isBot: true })) };
  const t0 = Date.now();
  while (host.room.game!.phase !== 'finished' && Date.now() - t0 < 3 * 3_600_000) await tick(1_000);
  const g = host.room.game!;
  const minutes = Math.round((Date.now() - t0) / 60_000);
  const { logBytes, logChunks, logLen } = host.room.rec!;
  const values = store.keys(code).map((k) => store.data.get(k)!.length);
  const out = {
    totalMinutes, seed, phase: g.phase, minutes, logLen, logChunks, logBytes,
    roomChars: store.data.get(hostKey(code, 'room'))!.length,
    valueChars: values.reduce((a, b) => a + b, 0),
    allChars: store.chars(),
    nonAscii: [...store.data.values()].join('').replace(/[\x00-\x7f]/g, '').length,
  };
  host.close();
  vi.useRealTimers();
  return out;
}

describe('P1E20 한 판 저장 크기', () => {
  const seeds = import.meta.env.TW_MEASURE ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [1];
  for (const m of [40, 80] as const) {
    it(`P1E20 봇 4명 ${m}분 판이 끝까지 돌고 1MB 를 넘지 않는다`, async () => {
      const rows: string[] = [];
      for (const seed of seeds) {
        const r = await play(m, seed);
        rows.push(JSON.stringify(r));
        expect(r.phase).toBe('finished');
        expect(r.allChars).toBeLessThan(1024 * 1024);
      }
      if (import.meta.env.TW_MEASURE) console.log(rows.join('\n'));
    }, 600_000);
  }
});
