// 지도 자리·모양(화면과 서버가 같이 쓴다). 정답이 되는 표(이름 → 위치·구역)는 map-spots.ts 에 있고 화면은 그 파일을 읽지 않는다
// — 같은 파일에 두면 방장용 지연 파일과 나눠 쓰느라 첫 로드에 함께 실린다.
export const spotPct = (lon: number, lat: number) => ({ x: ((lon + 180) / 360) * 100, y: ((90 - lat) / 180) * 100 });

export type MapMode = 'spots' | 'zones' | 'plain';
/** 활동 그림 이름 → 지도 모양. 이 목록에 없으면 지도를 쓰지 않는다 */
export const MAP_OF_IMAGE: Record<string, MapMode> = {
  'mi_continents.png': 'spots',
  'mi_oceans.png': 'spots',
  'mi_climate_zones.png': 'zones',
  'mi_true_size.png': 'plain',
};
