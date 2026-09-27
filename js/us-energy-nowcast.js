// us-energy-nowcast.js — 미국 헤드라인 CPI 당월 에너지 나우캐스트 (프로덕션 모듈).
//   주간 휘발유(GASREGW)로 당월 에너지 CPI m/m를 추정해, 코어·식품 시즈널은 유지한 채
//   에너지 성분만 대체 합성한 헤드라인 m/m를 산출한다. 백테스트·라이브 페이지가 공유
//   (단일 구현 → 검증-운영 드리프트 방지).
//
// 계절 규약 (v2 Phase 1, 방식 (a) 승인):
//   휘발유 m/m는 NSA라 강한 계절성을 가진다. 에너지 CPI(SA)와 정합시키기 위해 휘발유 m/m에서
//   **10년 고정창 월별 평균(기존 시즈널 가이드와 동일 규약·동일 동결)** 을 차감한 디시즌 입력으로
//   회귀한다. 회귀·앵커는 endPeriod(=나우캐스트 대상월 직전 실측월)에서 동결.
//
// 산식:
//   energy_mm(t) ≈ a + b·gas_des(t),  gas_des(t)=gas_mm(t) − seas_gas(month(t))   [24개월 회귀]
//   nowcast_energy_mm(M) = a + b·gas_des(M)
//   headline_mm = w_c·core_seas + w_f·food_seas + w_e·(energy_seas → nowcast로 대체)
//   (w_c,w_f,w_e): 헤드라인=성분가중합 제약 최소제곱(합=1, 무절편), 점-시점 trailing.

import { seasonalAvgMM, comparePeriods, periodMonth } from './calc.js';

/** month-of-year → 시즈널 m/m 맵. 10y 고정창(endPeriod 앵커, 동결). 12개월 forward가 12달을 모두 덮음. */
export function seasonalMonthMap(mmHistory, windowYears, endPeriod) {
  const proj = seasonalAvgMM(mmHistory, windowYears, endPeriod, 12);
  const map = new Map();
  // 표본 0개 달(value null)은 종전대로 0 — 나우캐스트 입력은 장기 이력이라 실사용에선 발생하지 않음.
  for (const x of proj) map.set(periodMonth(x.period), x.value ?? 0);
  return map;
}

/** 디시즌: m/m − 해당 월 시즈널 성분. 맵에 없으면 0 차감(무변경). */
export function deseasonalizeMM(mmSeries, seasonalMap) {
  return mmSeries.map((p) => ({
    period: p.period,
    value: p.value - (seasonalMap.get(periodMonth(p.period)) ?? 0),
  }));
}

/** 단순 OLS y=a+b·x → {a,b,r2,n}. n<2면 기울기 0. */
export function ols(xs, ys) {
  const n = xs.length;
  if (n < 2) return { a: n === 1 ? ys[0] : 0, b: 0, r2: 0, n };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return { a: my - b * mx, b, r2: syy === 0 ? 0 : (sxy * sxy) / (sxx * syy), n };
}

/**
 * 당월 에너지 CPI m/m 나우캐스트.
 * @param gasMM     휘발유 월평균 m/m 시계열 [{period,value}] (gap-aware)
 * @param energyMM  에너지 CPI m/m 시계열 [{period,value}] (SA, gap-aware)
 * @param endPeriod 앵커(=대상월 직전 실측월). 시즈널·회귀 전부 이 시점까지만.
 * @param targetPeriod 나우캐스트 대상월 M.
 * @returns {value,a,b,r2,n,gasDeseasonInput,seasonalGasComponent}
 */
export function energyNowcast({ gasMM, energyMM, endPeriod, targetPeriod, regWindow = 24, windowYears = 10, deseason = true }) {
  // deseason=true(프로덕션·방식 a): 휘발유 m/m에서 10y 고정창 월별평균 차감 후 회귀.
  //   false는 게이트 비교(구 NSA 방식)용으로만.
  const gasHist = gasMM.filter((p) => comparePeriods(p.period, endPeriod) <= 0);
  const seasMap = deseason ? seasonalMonthMap(gasHist, windowYears, endPeriod) : new Map();
  const gasDesMap = new Map(deseasonalizeMM(gasMM, seasMap).map((p) => [p.period, p.value]));
  const eMap = new Map(energyMM.map((p) => [p.period, p.value]));

  const periods = energyMM
    .filter((e) => comparePeriods(e.period, endPeriod) <= 0 && gasDesMap.has(e.period))
    .map((e) => e.period)
    .slice(-regWindow);
  const xs = periods.map((p) => gasDesMap.get(p));
  const ys = periods.map((p) => eMap.get(p));
  const { a, b, r2, n } = ols(xs, ys);

  const gx = gasDesMap.get(targetPeriod);
  return {
    value: gx == null ? null : a + b * gx,
    a, b, r2, n,
    gasDeseasonInput: gx ?? null,
    seasonalGasComponent: seasMap.get(periodMonth(targetPeriod)) ?? null,
  };
}

/**
 * 성분 가중치 (w_c,w_f,w_e) 제약 최소제곱: h−c = w_f·(f−c) + w_e·(e−c) (무절편 2변수),
 * w_c=1−w_f−w_e. 입력은 이미 trailing window로 잘린 m/m 시계열들.
 * 표본 부족/특이 시 BLS 상대중요도 근사(코어0.8/식품0.135/에너지0.065)로 폴백.
 */
export function estimateWeights(hmm, cmm, fmm, emm) {
  const M = (arr) => new Map(arr.map((p) => [p.period, p.value]));
  const H = M(hmm), C = M(cmm), F = M(fmm), E = M(emm);
  const X1 = [], X2 = [], Y = [];
  for (const [p, h] of H) {
    if (!C.has(p) || !F.has(p) || !E.has(p)) continue;
    const c = C.get(p);
    X1.push(F.get(p) - c); X2.push(E.get(p) - c); Y.push(h - c);
  }
  const n = Y.length;
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0;
  for (let i = 0; i < n; i++) {
    s11 += X1[i] * X1[i]; s12 += X1[i] * X2[i]; s22 += X2[i] * X2[i];
    s1y += X1[i] * Y[i]; s2y += X2[i] * Y[i];
  }
  const det = s11 * s22 - s12 * s12;
  if (n < 6 || Math.abs(det) < 1e-12) return { w_c: 0.8, w_f: 0.135, w_e: 0.065, n, fallback: true };
  const w_f = (s22 * s1y - s12 * s2y) / det;
  const w_e = (s11 * s2y - s12 * s1y) / det;
  return { w_c: 1 - w_f - w_e, w_f, w_e, n, fallback: false };
}

/**
 * 헤드라인 m/m 합성. 코어·식품 시즈널 유지, 에너지는 seasonal/nowcast 두 버전.
 * @returns {seasonal, nowcast} — nowcast는 energyNowcastMM null이면 null.
 */
export function synthesizeHeadlineMM({ coreSeas, foodSeas, energySeas, energyNowcastMM, weights }) {
  const { w_c, w_f, w_e } = weights;
  const base = w_c * coreSeas + w_f * foodSeas;
  return {
    seasonal: base + w_e * energySeas,
    nowcast: energyNowcastMM == null ? null : base + w_e * energyNowcastMM,
  };
}

/** 특정 대상월의 시즈널 m/m (endPeriod 앵커, 10y 고정창, 1개월). */
export function seasonalForPeriod(mmHistory, endPeriod, targetPeriod, windowYears = 10) {
  const g = seasonalAvgMM(mmHistory, windowYears, endPeriod, 1);
  const hit = g.find((x) => x.period === targetPeriod);
  return hit?.value ?? 0; // 표본 0개(null)도 종전대로 0

}
