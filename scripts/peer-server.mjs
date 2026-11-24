// 로컬 시그널링 서버(개발·e2e). 이 기기(127.0.0.1)에만 묶인다. 포트는 인자(기본 9000, 0 = 빈 포트를 골라 알림).
import { PeerServer } from 'peer';

process.on('uncaughtException', (e) => {
  console.error(`peer-server: ${e.message}`);
  process.exit(1);
});

PeerServer({ host: '127.0.0.1', port: Number(process.argv[2] ?? 9000), path: '/' }, (server) => {
  console.log(`peer-server: http://127.0.0.1:${server.address().port}/`);
});
