// crv1-history.js — CRV-1 Phase 4. 구간별 비중 **이력 시계열**과 윈도우 통계. 순수 함수, DOM 의존 없음.
//
// [왜 별도 파일인가] crv1-calc.js 의 snapshot() 은 설계상 최신일만 반환한다(그 파일 41-43행).
//   창 안의 일자별 값을 이미 만들면서도 min/max 를 낸 뒤 버린다. Phase 4 가 필요로 하는 것이
//   바로 그 버려지는 시계열이다. snapshot() 을 고쳐 시계열을 흘리게 만들면 표(상단 패널)와
//   차트가 한 함수를 공유한 채 서로의 요구로 서서히 부풀게 되므로, **계산은 재사용하고 파일만
//   나눈다.** crv1-calc.js·crv1-dur.js 는 이 작업에서 한 글자도 고치지 않는다.
//
// [산식 무복제] ratio·neutral·gap·flag 는 전부 crv1-calc.js 의 weightsAt() 을 그대로 호출해
//   얻는다. 여기서 다시 만들거나 보정하지 않는다 — 표와 차트가 같은 날 다른 숫자를 내면
//   둘 중 어느 쪽이 맞는지 화면에서 판별할 방법이 없다. 반올림(소수 2자리)·tight 임계(5bp)·
//   부동소수 여유(EPS_BP)도 전부 calc 의 것을 물려받는다.
//   ※ weightsAt 은 TRIPLES 를 map 한 결과라 반환 순서가 TRIPLES 순서와 항상 같다. 행마다
//     키를 다시 맞추지 않고 인덱스로 꽂는 근거가 이것이다(2,629행 × 9조합에서 유의미한 절약).
//
// [중립도 시계열이다] duration 기준의 중립은 듀레이션 비율이고 듀레이션은 금리 수준에 따라
//   매일 달라진다 → neutral 배열은 평평하지 않다. time 기준은 만기 비율이라 값이 상수이며
//   화면에서 완전한 수평선으로 보인다. 둘 다 정상이다.
//
// [제외 일자] ratio 가 null 인 날은 통계 표본에서 뺀다. 사유는 두 갈래다.
//   tight   양끝 금리차 < 5bp — 비중이 발산해 숫자가 의미를 잃는다(calc 규약)
//   missing 입력 금리 결측(50Y 는 2016-10-11 관측 개시)
//   실측 밀도는 구간·창에 따라 250일 창의 0~9% 에서 전체 창의 55% 까지 벌어진다. 이 사실을
//   평균 옆 숫자로 반드시 노출한다 — 제외를 감추면 n 이 다른 평균끼리 나란히 놓이게 된다.
//
// [표준편차] 표본표준편차(÷ n−1)를 쓴다. gc-calc·us-credit-spread 의 z250 은 모집단식(÷n)이지만
//   그쪽은 결측 없는 연속 시계열이라 창 전체가 곧 표본이었다. 여기서는 제외가 상시적이라
//   남은 관측이 창의 부분표본이고, 그럴 때 맞는 것은 불편추정량이다.

import { TRIPLES, nodeColumns, pickNodes, nodeDurations, weightsAt } from './crv1-calc.js';

/** 윈도우 선택지. 250=1년, 750=3년, 'all'=전체 이력. */
export const WINDOWS = [250, 750, 'all'];

/** 윈도우 라벨. 화면 토글과 캡션이 같은 문구를 쓰도록 여기 한 곳에 둔다. */
export const WINDOW_LABEL = { 250: '250일', 750: '3년', all: '전체' };

export const DEFAULT_WINDOW = 250;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

/**
 * 창 길이 → 실제 사용 행수. 'all' 이거나 데이터가 모자라면 가용 행수로 줄어든다.
 * (crv1-calc.snapshot 의 부분 창 규약과 같다 — 표본이 적으면 좁을 뿐이고, 그 사실은 감추지 않는다.)
 * @param {number} total  전체 행수
 * @param {number|'all'} window
 */
export function windowRows(total, window = DEFAULT_WINDOW) {
  if (window === 'all') return total;
  const w = Number(window);
  if (!Number.isFinite(w) || w <= 0) throw new Error(`crv1: window 는 양수 또는 'all' 이어야 합니다 (받은 값: ${window})`);
  return Math.min(Math.floor(w), total);
}

/**
 * 전체 이력의 구간별 비중 시계열.
 *
 * @param {{grid: number[], rows: Array}} curve  window.KTB_CURVE 형태
 * @param {{neutral?: 'duration'|'time'}} [opts]
 * @returns {{
 *   neutral: 'duration'|'time',
 *   dates: string[],
 *   series: Array<{
 *     key: string, s: number, m: number, l: number, dates: string[],
 *     ratio: Array<number|null>, neutral: Array<number|null>,
 *     gap: Array<number|null>, flag: Array<string|null>
 *   }>
 * }}  series[i].dates 는 상위 dates 와 **같은 배열 참조**다(복제하지 않는다).
 */
export function history(curve, { neutral = 'duration' } = {}) {
  if (!curve || !Array.isArray(curve.grid) || !Array.isArray(curve.rows) || curve.rows.length === 0) {
    throw new Error('crv1: curve 는 {grid:[], rows:[…]} 형태여야 하고 rows 가 비면 안 됩니다');
  }
  const cols = nodeColumns(curve.grid);          // 노드 결측이면 여기서 던진다(calc 규약)
  const dates = curve.rows.map((r) => r[0]);

  const series = TRIPLES.map(([s, m, l]) => ({
    key: `${s}-${m}-${l}`, s, m, l, dates,
    ratio: [], neutral: [], gap: [], flag: [],
  }));

  for (const row of curve.rows) {
    const y = pickNodes(row, cols);
    const w = weightsAt(y, nodeDurations(y), { neutral });
    for (let i = 0; i < series.length; i++) {
      const it = w[i];
      series[i].ratio.push(it.ratio);
      series[i].neutral.push(it.neutral);
      series[i].gap.push(it.gap);
      series[i].flag.push(it.flag);
    }
  }

  return { neutral, dates, series };
}

/**
 * 창 통계. null 은 표본에서 빼고 **제외 사유를 세어 함께 낸다**.
 *
 * 현재값(current)은 창의 마지막 값이다 — 창은 언제나 최신일에서 끝난다.
 * n < 2 이면 sd·z 를 내지 않는다(관측 하나로 산포를 말하지 않는다).
 * sd 가 0 이면(창 내내 같은 값) z 도 내지 않는다 — 0 으로 나누지 않는다.
 *
 * @param {Array<number|null>} values  전 구간 값(마지막 원소가 최신일)
 * @param {number|'all'} [window]
 * @param {Array<string|null>} [flags]  같은 길이의 flag 배열. 주면 제외 사유를 쪼개 센다.
 * @returns {{
 *   mean: number|null, sd: number|null, n: number, used: number,
 *   excluded: number, tight: number, missing: number, other: number,
 *   current: number|null, z: number|null
 * }}
 */
export function stats(values, window = DEFAULT_WINDOW, flags = null) {
  if (!Array.isArray(values)) throw new Error('crv1: stats 의 values 는 배열이어야 합니다');
  const total = values.length;
  const used = windowRows(total, window);
  const from = total - used;

  let sum = 0, n = 0, tight = 0, missing = 0, other = 0;
  for (let i = from; i < total; i++) {
    const v = values[i];
    if (isNum(v)) { sum += v; n++; continue; }
    const f = flags ? flags[i] : null;
    if (f === 'tight') tight++;
    else if (f === 'missing') missing++;
    else other++;                          // degenerate·flag 미제공 — 감추지 않고 따로 센다
  }
  const excluded = used - n;
  const current = total > 0 && isNum(values[total - 1]) ? values[total - 1] : null;

  if (n === 0) {
    return { mean: null, sd: null, n: 0, used, excluded, tight, missing, other, current, z: null };
  }

  const mean = sum / n;
  let sd = null;
  if (n >= 2) {
    let ss = 0;
    for (let i = from; i < total; i++) { const v = values[i]; if (isNum(v)) ss += (v - mean) ** 2; }
    sd = Math.sqrt(ss / (n - 1));
  }
  // z 는 반올림 전 mean·sd 로 낸다 — 표시용 2자리 반올림을 z 산출에 먹이면 값이 어긋난다.
  const z = (current != null && sd != null && sd > 0) ? round2((current - mean) / sd) : null;

  return { mean: round2(mean), sd: sd == null ? null : round2(sd), n, used, excluded, tight, missing, other, current, z };
}

/**
 * 창 구간으로 자른 값 배열. 이력은 basis 당 한 번만 만들고 창·행 전환은 이 슬라이스만 한다.
 * @param {Array} arr
 * @param {number|'all'} [window]
 */
export function slice(arr, window = DEFAULT_WINDOW) {
  return arr.slice(arr.length - windowRows(arr.length, window));
}
