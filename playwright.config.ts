import { defineConfig } from '@playwright/test';

// 기존 e2e 는 Node 안의 Room + routeWebSocket 으로 돌므로 웹소켓 빌드를 띄운다(기본 빌드는 기기 간 통신 — p2p-*.spec 이 제 빌드를 만든다).
// dist 는 기본 빌드 자리라 따로 두고, git 이 무시하는 곳에 둔다. 에셋 복사 플러그인은 dist 에만 쓰므로 여기는 링크
const DIST_WS = 'node_modules/.cache/dist-ws';

export default defineConfig({
  testDir: './e2e',
  // 비결정적 흔들림은 1회만 다시 돌린다(T12). 두 번 실패하면 결함. 재시도 때 trace, 실패 때 스크린숏
  retries: 1,
  // 재시도로 통과한 시험(flaky)도 실행 실패로 친다: 흔들림을 숨기지 않는다
  failOnFlakyTests: true,
  use: { baseURL: 'http://localhost:4173', viewport: { width: 1366, height: 768 }, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [
    // 성능 측정·4인 가속 통합 시험은 다른 spec 과 CPU 를 나누면 흔들린다(T15 실측: 스로틀 기준 루프 15→36 ms, 가속 시계 shown 창 ≈150 ms).
    // 그래서 먼저 혼자(workers 1) 돌리고, desktop 이 그 뒤에 병렬로 돈다. --project=desktop 은 의존 프로젝트까지 함께 돈다
    { name: 'desktop-solo', testMatch: /(perf|full-lesson)\.spec\.ts$/, workers: 1 },
    { name: 'desktop', testIgnore: /(perf|full-lesson)\.spec\.ts$/, dependencies: ['desktop-solo'] }, // 기본: 1366×768 데스크톱 마우스
    { name: 'tablet-touch', use: { viewport: { width: 1180, height: 820 }, hasTouch: true, isMobile: true } },
  ],
  webServer: {
    command: `npx vite build --outDir ${DIST_WS} && ln -s "$PWD/assets/webp" "$PWD/assets/audio" ${DIST_WS}/ && npx vite preview --outDir ${DIST_WS} --port 4173 --strictPort`,
    env: { VITE_TW_NET: 'ws' },
    port: 4173,
    reuseExistingServer: true,
  },
});
