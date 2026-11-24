// 방장 기다림(PRD §8-18, 학생 기기): 멈춤 모달과 같은 틀(DESIGN §20). 판에서는 Game 의 멈춤 UI 가 같은 상자에 띄우고, 여기는 대기실용.
import { useRef } from 'preact/hooks';
import { PauseLayer, PauseModal, useInertSiblings } from './PauseModal';

export function HostWait({ onHome }: { onHome: () => void }) {
  const layer = useRef<HTMLDivElement>(null);
  useInertSiblings(true, layer);
  return <PauseLayer layerRef={layer}><PauseModal kind="H-W" onHome={onHome} /></PauseLayer>;
}
