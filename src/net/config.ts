// 기기 간 통신 설정 한 곳(PRD §9.5). 빌드 환경 변수 VITE_TW_* 로 덮어쓴다(e2e: 로컬 시그널링 서버와 빈 iceServers).
// 중계 서버는 쓰지 않는다: PeerJS 기본값에 중계가 들어 있어 iceServers 를 늘 명시한다(PRD §0 B-3).
const env = import.meta.env as Record<string, string | undefined>;
const num = (name: string, d: number) => Number(env[`VITE_TW_${name}`] || d);

export const TRANSPORT = (env.VITE_TW_NET || 'peer') as 'peer' | 'ws';

const ICE_SERVERS: RTCIceServer[] = env.VITE_TW_ICE_SERVERS
  ? (JSON.parse(env.VITE_TW_ICE_SERVERS) as RTCIceServer[])
  : [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

/** PeerJS 에 넘기는 값 */
export const PEER_OPTIONS = {
  host: env.VITE_TW_PEER_HOST || '0.peerjs.com',
  port: num('PEER_PORT', 443),
  path: env.VITE_TW_PEER_PATH || '/',
  secure: env.VITE_TW_PEER_SECURE !== 'false',
  config: { iceServers: ICE_SERVERS },
  debug: 0,
};
export const CONNECT_OPTIONS = { serialization: 'json', reliable: true };

/** 방장의 연결 ID = 접두어 + 방 코드(공용 시그널링 서버의 다른 앱과 겹침을 줄인다) */
export const hostId = (code: string) => `twj1-${code}`;
export const FRAME_V = 1;

export const NET = {
  helloMs: num('HELLO_MS', 5_000),
  /** 이보다 긴 메시지는 조각으로 */
  inlineChars: num('INLINE_CHARS', 3_000),
  /** PeerJS 는 부호화한 프레임이 16,300바이트 이상이면 안 보낸다. 이 길이가 15,000바이트를 지키고 시험이 잰다 */
  chunkChars: num('CHUNK_CHARS', 4_000),
  maxChunks: num('MAX_CHUNKS', 2_048),
  /** 조립 중인 메시지 전부의 합 */
  maxChars: num('MAX_CHARS', 4_194_304),
  /** 기억하는 버린 메시지 수 */
  maxDropped: num('MAX_DROPPED', 64),
  assembleMs: num('ASSEMBLE_MS', 15_000),
  beatMs: num('BEAT_MS', 2_000),
  /** 학생: 이만큼 조용하면 '방장 기다림' 알림 */
  silentMs: num('SILENT_MS', 6_000),
  /** 양쪽: 이만큼 조용하면 끊는다 */
  deadMs: num('DEAD_MS', 10_000),
  closeWaitMs: num('CLOSE_WAIT_MS', 3_000),
  maxRemotes: num('MAX_REMOTES', 6),
  /** 아직 열리지 않은 원격 연결(열린 연결과 따로 센다) */
  maxPending: num('MAX_PENDING', 24),
  /** PeerJS 가 쌓아 둔 메시지 수(bufferSize). 넘으면 받지 않는 기기로 보고 끊는다 */
  maxBuffered: num('MAX_BUFFERED', 2_048),
  seatlessMs: num('SEATLESS_MS', 120_000),
  floodCount: num('FLOOD_COUNT', 40),
  floodMs: num('FLOOD_MS', 2_000),
  /** 연결 한 번이 열릴 때까지 */
  openMs: num('OPEN_MS', 20_000),
  registerMs: num('REGISTER_MS', 15_000),
  maxRepicks: num('MAX_REPICKS', 5),
  retakeMs: num('RETAKE_MS', 2_000),
  /** 시그널링 서버가 옛 등록을 쥐는 90초(peer 1.0.2 alive_timeout)보다 길게 */
  retakeGiveUpMs: num('RETAKE_GIVE_UP_MS', 100_000),
  /** 판을 이어 간 뒤(끝난 판 포함) 연결 ID 를 끝내 못 잡았을 때 뒤에서 다시 등록하기까지(§8-19 ⓖ) */
  reopenGapMs: num('REOPEN_GAP_MS', 10_000),
  reconnectMs: num('RECONNECT_MS', 1_000),
  reconnectMaxMs: num('RECONNECT_MAX_MS', 30_000),
};
