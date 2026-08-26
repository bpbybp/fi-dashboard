// crv1-dur.js — CRV-1(국고 커브 RV) 듀레이션. 순수 함수, DOM 의존 없음.
//
// [복제 사유] 정본은 curve-efficiency.html:253-258 의 modDur 다. CE 는 무빌드 단일 HTML 이라
//   함수가 인라인 <script> 안에 있고 export 되지 않아 import 할 길이 없다. 기존 파일을
//   수정하지 않는다는 규약에 따라 **로직을 한 글자도 바꾸지 않고** 여기에 복제한다.
//   CE 원본과 동일 입력 → 동일 출력이어야 하며, tests/crv1-calc.test.mjs 가 이를 고정한다
//   (하드코딩 앵커 3+건 + CE 원문에서 함수를 추출해 대조하는 패리티 스윕).
//   CE 의 modDur 이 바뀌면 패리티 테스트가 깨진다 — 그때 여기도 같이 고쳐야 한다는 신호다.
//
// [미복제] CE 의 분수 만기 보간 Dat(curve-efficiency.html:260-268)은 복제하지 않는다.
//   CRV-1 은 정수 격자 8노드(1·2·3·5·10·20·30·50)만 쓰므로 노드 간 보간이 필요 없다.
//   CE 는 롤다운 상대만기 τ−h 가 격자에 없어서 보간이 필요했던 것이고, CRV-1 의 지표는
//   전부 관측 노드끼리의 차이라 보간 지점이 생기지 않는다.
//
// [가정] 액면(par) 채권 — 이표율 = 해당 만기의 커브 금리. 반기 이표, 반기복리 할인.
//   기간수 n = round(m × 2) 로 반올림하므로 만기가 반기 격자에 안 맞으면 가장 가까운
//   반기로 스냅된다(정수 만기 8노드에서는 항상 정확히 맞는다).
//   실제 지표물의 이표·경과이자는 반영하지 않는다 — CE 와 동일한 수준의 근사다.

/**
 * 액면 반기 이표채 수정듀레이션(년).
 * curve-efficiency.html:253-258 modDur 무변경 복제.
 *
 * @param {number} m  만기(년). 0 이하이면 0.
 * @param {number} yt 해당 만기 금리(연 %, 예: 3.797)
 * @returns {number} 수정듀레이션(년)
 */
export function modDur(m, yt) {
  if (m <= 0) return 0;
  var f = 2, n = Math.max(1, Math.round(m * f)), i = (yt / 100) / f, c = i * 100, pv = 0, w = 0, t, cf, df;
  for (t = 1; t <= n; t++) { cf = c + (t === n ? 100 : 0); df = Math.pow(1 + i, -t); pv += cf * df; w += (t / f) * cf * df; }
  return (w / pv) / (1 + i);
}
