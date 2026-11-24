import { afterEach, describe, expect, it, vi } from 'vitest';
import { fake, FakePeer } from './fakes';

vi.mock('peerjs', () => ({ default: FakePeer }));
let hosts: { close(): Promise<void> }[] = []; // 시험 뒤에 닫는다: 닫으면 진짜처럼 Peer 의 id 가 비워진다
afterEach(() => { for (const h of hosts) void h.close(); hosts = []; vi.unstubAllEnvs(); vi.resetModules(); fake.peers.length = 0; });

const load = () => import('../config');
/** 방장·학생이 실제로 PeerJS 에 넘긴 것 */
async function passed() {
  const { PeerHost } = await import('../peer-host');
  const { peerMake } = await import('../peer-socket');
  const h = new PeerHost({ code: 'ABCDEF', accept: () => { throw new Error(); } });
  const s = peerMake()('ABCDEF');
  const [host, stu] = fake.peers as unknown as FakePeer[];
  stu.ready();
  s.close();
  hosts.push(h);
  return { host, stu };
}

describe('P2E12 설정', () => {
  it('P2E12 기본값: 공용 시그널링, STUN 2곳, 중계 0, reliable', async () => {
    const { host, stu } = await passed();
    for (const p of [host, stu]) {
      expect(p.opts).toMatchObject({ host: '0.peerjs.com', port: 443, path: '/', secure: true });
      expect(p.opts.config).toEqual({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });
      expect(JSON.stringify(p.opts)).not.toMatch(/turns?:/);
    }
    expect(host.id).toBe('twj1-ABCDEF');
    expect(stu.connectArgs).toEqual([['twj1-ABCDEF', { serialization: 'json', reliable: true }]]);
    expect((await load()).TRANSPORT).toBe('peer');
  });

  it('P2E12 VITE_TW_* 로 시그널링 주소·iceServers(빈 배열)·방식·숫자를 덮는다', async () => {
    vi.stubEnv('VITE_TW_PEER_HOST', '127.0.0.1');
    vi.stubEnv('VITE_TW_PEER_PORT', '9123');
    vi.stubEnv('VITE_TW_PEER_PATH', '/x');
    vi.stubEnv('VITE_TW_PEER_SECURE', 'false');
    vi.stubEnv('VITE_TW_ICE_SERVERS', '[]');
    vi.stubEnv('VITE_TW_NET', 'ws');
    vi.stubEnv('VITE_TW_BEAT_MS', '500');
    vi.stubEnv('VITE_TW_REOPEN_GAP_MS', '700');
    const { host, stu } = await passed();
    for (const p of [host, stu]) {
      expect(p.opts).toMatchObject({ host: '127.0.0.1', port: 9123, path: '/x', secure: false });
      expect(p.opts.config).toEqual({ iceServers: [] });
    }
    const c = await load();
    expect(c.TRANSPORT).toBe('ws');
    expect(c.NET.beatMs).toBe(500);
    expect(c.NET.reopenGapMs).toBe(700);
    expect(c.NET.deadMs).toBe(10_000);
  });

  it('P2E12 틀 숫자 기본값(PRD §9.5)', async () => {
    expect((await load()).NET).toEqual({
      helloMs: 5_000, inlineChars: 3_000, chunkChars: 4_000, maxChunks: 2_048, maxChars: 4_194_304, maxDropped: 64, assembleMs: 15_000,
      beatMs: 2_000, silentMs: 6_000, deadMs: 10_000, closeWaitMs: 3_000, maxRemotes: 6, maxPending: 24, maxBuffered: 2_048, seatlessMs: 120_000, floodCount: 40, floodMs: 2_000,
      openMs: 20_000, registerMs: 15_000, maxRepicks: 5, retakeMs: 2_000, retakeGiveUpMs: 100_000, reopenGapMs: 10_000, reconnectMs: 1_000, reconnectMaxMs: 30_000,
    });
  });

  it('P2bE10 새 숫자 셋과 100초도 VITE_TW_* 로 덮인다', async () => {
    vi.stubEnv('VITE_TW_RETAKE_GIVE_UP_MS', '1');
    vi.stubEnv('VITE_TW_MAX_PENDING', '2');
    vi.stubEnv('VITE_TW_MAX_BUFFERED', '3');
    vi.stubEnv('VITE_TW_MAX_DROPPED', '4');
    expect((await load()).NET).toMatchObject({ retakeGiveUpMs: 1, maxPending: 2, maxBuffered: 3, maxDropped: 4 });
  });
});
