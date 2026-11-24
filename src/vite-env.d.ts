/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 통신 방식: peer(기본) | ws. 분기를 빌드가 지울 수 있게 ws 전용 import 는 이 값을 바로 견준다(net/config 의 TRANSPORT 와 같은 값) */
  readonly VITE_TW_NET?: 'peer' | 'ws';
}
