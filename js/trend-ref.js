// trend-ref.js — 추세 보정 참고값 (조회 페이지 표시 전용, 자동 적용 금지). DOM 무관 순수 모듈.
//
// 시즈널 가이드는 10년 창 평균 추세를 전제한다. 최근 추세가 창 평균보다 높으면 1개월 앞 전망이
// 과소가 되는 경향(gap = a + b·x, b≈0.6~0.8, a≈0 — analysis 8e171c2)을 참고값으로 보여 준다.
// 정의(기준월 E = 마지막 실측, 창 = E 포함 최근 windowYears*12개월):
//   W  = 창 m-m 합 / windowYears. 제외 월도 대체하지 않는다 — b 를 추정한 x 가 이 정의였으므로 일관성 우선.
//   c1 = 원계열 12개월 y-y (참고용).
//   c2 = 12개월 y-y, 현재(E) 또는 기준(E−12) 달이 shock 이면 그 달 지수를
//        "전월 실제 지수 × (1 + 시즈널 가이드 m-m)"으로 정상화해 계산. rebound 달은 수준을 건드리지 않는다
//        (반등 m-m 까지 대체하면 기저 외 요인까지 지워짐).
//   c3 = W + 12 × mean(최근 6개월 실제 m-m − 그 달 시즈널 가이드). 가이드는 6개월 직전(E−6) 앵커,
//        제외 적용 — 최근 6개월 자신이 가이드 표본에 섞이지 않게.
//   월 차이 = (c − W)/12, 제안 보정 = round2(b × mean(c2 차이, c3 차이)).

import { computeMM, computeYY, seasonalAvgMM, prevPeriod, periodMonth } from './calc.js';

export const B_WINDOW_YEARS = 10;
const B_WARNING = 'b는 10년 창 기준 추정 — 다른 창에서는 참고 정확도 낮음';

// points: [{ period, value }] 지수. opts: { windowYears, exclusions, b }.
// 창이 모자라면 null.
export function computeTrendRef(points, { windowYears = B_WINDOW_YEARS, exclusions = [], b } = {}) {
  const sorted = [...points].sort((x, y) => (x.period < y.period ? -1 : 1));
  if (sorted.length === 0) return null;
  const E = sorted[sorted.length - 1].period;
  const idx = new Map(sorted.map((p) => [p.period, p.value]));
  const mmHist = computeMM(sorted);
  const mm = new Map(mmHist.map((p) => [p.period, p.value]));

  const n = windowYears * 12;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = mm.get(prevPeriod(E, i));
    if (v === undefined) return null;
    sum += v;
  }
  const W = sum / windowYears;

  const c1 = computeYY(sorted).find((p) => p.period === E)?.value;
  if (c1 === undefined) return null;

  // c2: shock 달 기저 정상화. 가이드는 E 앵커(전망과 같은 가이드), 제외 적용.
  const guideE = monthGuide(mmHist, windowYears, E, exclusions);
  const shocks = new Set(exclusions.filter((e) => e.kind === 'shock').map((e) => e.period));
  const level = (p) => (shocks.has(p) ? idx.get(prevPeriod(p, 1)) * (1 + guideE.get(periodMonth(p)) / 100) : idx.get(p));
  const c2 = shocks.has(E) || shocks.has(prevPeriod(E, 12))
    ? (level(E) / level(prevPeriod(E, 12)) - 1) * 100
    : c1;

  // c3: 최근 6개월 계절조정 근사. 가이드는 E−6 앵커.
  const guide6 = monthGuide(mmHist, windowYears, prevPeriod(E, 6), exclusions);
  let excess = 0;
  for (let i = 0; i < 6; i++) {
    const p = prevPeriod(E, i);
    excess += mm.get(p) - guide6.get(periodMonth(p));
  }
  const c3 = W + 12 * (excess / 6);

  const diff = { c1: (c1 - W) / 12, c2: (c2 - W) / 12, c3: (c3 - W) / 12 };
  const hasB = typeof b === 'number' && Number.isFinite(b);
  const suggestionRaw = hasB ? b * ((diff.c2 + diff.c3) / 2) : null;
  return {
    asOf: E,
    windowYears,
    W, c1, c2, c3, diff,
    b: hasB ? b : null,
    suggestionRaw,
    suggestion: hasB ? Math.round(suggestionRaw * 100) / 100 : null,
    bWarning: windowYears === B_WINDOW_YEARS ? null : B_WARNING,
  };
}

// month-of-year → 시즈널 가이드 m-m (anchor 기준 고정 창, 제외 적용). 12개월이면 12달 모두 덮는다.
function monthGuide(mmHist, windowYears, anchor, exclusions) {
  return new Map(seasonalAvgMM(mmHist, windowYears, anchor, 12, exclusions).map((g) => [periodMonth(g.period), g.value]));
}
