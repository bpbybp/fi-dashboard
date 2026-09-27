// us-inflation-calc.js — 미국 물가전망 gap-aware 계산.
// 공용 calc.js는 수정하지 않는다. 순수 헬퍼·시즈널·투영 함수는 calc.js에서 그대로 import하고,
// gap(결측월)에 취약한 m-m만 US 전용으로 다시 구현한다.
//
// 결측 배경: 2025년 미 연방정부 셧다운으로 BLS가 CPI 2025-10을 미발표 → FRED 값 공백.
//   · m-m: calc.js computeMM은 정렬 후 "연속 두 항"을 무조건 나눠, 2025-11이 2025-11/2025-09
//     (2개월 변화)로 오염된다. → 여기선 정확히 1개월 차이일 때만 산출, 아니면 결측.
//   · y-y: calc.js computeYY는 t-12를 map으로 조회해 없으면 skip → 이미 gap-safe. 그대로 사용
//     (2025-10, 2026-10 y-y는 자연히 결측).

import {
  nextPeriod,
  comparePeriods,
  computeYY,
  rollingSeasonalAvgMM,
  seasonalAvgMM,
  seasonalTrimmedAvgMM,
  assertSeasonalCoverage,
  insufficientMonths,
  recentAvgMM,
  resolveForecastMM,
  projectIndex,
  annualYoYSummary,
} from './calc.js';

function sortByPeriod(points) {
  return [...points].sort((a, b) => comparePeriods(a.period, b.period));
}

// gap-aware m-m: 연속 두 관측이 정확히 1개월 차이일 때만 ((idx[t]/idx[t-1])-1)*100.
// 그 외(중간에 빠진 달)는 산출하지 않음 → 오염된 다개월 변화가 시즈널 표본에 섞이지 않음.
export function computeMMGapAware(history) {
  const s = sortByPeriod(history);
  const out = [];
  for (let i = 1; i < s.length; i++) {
    const prev = s[i - 1];
    const cur = s[i];
    if (nextPeriod(prev.period) !== cur.period) continue; // gap → m-m 결측
    if (prev.value === 0) continue;
    out.push({ period: cur.period, value: (cur.value / prev.value - 1) * 100 });
  }
  return out;
}

// 당해년도·익년도 연평균 y-y 요약(US). 공용 annualYoYSummary에 gap-aware m-m 변환기를 주입 —
// 계산 규약(고정 윈도우 가이드·익년 12월 연장·gap 월 제외)은 동일하고, m-m 표본만 gap-aware.
// gap 월(예: base 2025-10 결측)의 y-y는 computeYY가 자연히 배제 → 해당 연도는 "N개월 평균"으로 표기됨.
export function annualYoYSummaryUS(index_history, scenario, meta) {
  return annualYoYSummary(index_history, scenario, meta, computeMMGapAware);
}

// 첫~마지막 사이 빠진 달 목록 (차트 gap 표기·각주 판정용).
export function missingPeriods(history) {
  const s = sortByPeriod(history);
  if (s.length === 0) return [];
  const have = new Set(s.map((p) => p.period));
  const out = [];
  let p = s[0].period;
  const end = s[s.length - 1].period;
  while (comparePeriods(p, end) < 0) {
    p = nextPeriod(p);
    if (comparePeriods(p, end) <= 0 && !have.has(p)) out.push(p);
  }
  return out;
}

const EMPTY_GUIDE = () => ({
  seasonal_avg_window: [],
  seasonal_trimmed_window: [],
  recent_6m_avg: 0,
  recent_12m_avg: 0,
  insufficient_months: [],
});

// buildForecast(calc.js) 월간·index 전용 경로와 동일한 수식이되, m-m만 gap-aware.
// 지수 체인: I(t) = I(t-1) × (1 + m-m/100). y-y는 history+forecast 지수로 계산 후 forecast 구간 추출.
export function buildForecastUS(index_history, scenario, meta, forecastMonths = 12) {
  const sorted = sortByPeriod(index_history);
  if (sorted.length === 0) {
    return {
      series_id: scenario.series_id,
      scenario_id: scenario.scenario_id,
      index_history: [],
      index_forecast: [],
      mm_history: [],
      mm_forecast: [],
      yoy_history: [],
      yoy_forecast: [],
      guide: EMPTY_GUIDE(),
      mm_guide_full: [],
    };
  }

  const mm_history = computeMMGapAware(sorted);
  const yoy_history = computeYY(sorted); // gap-safe
  const lastIndex = sorted[sorted.length - 1];
  const endPeriod = lastIndex.period;

  // forecast periods: nextPeriod(endPeriod)부터 forecastMonths개월 (연속, gap 없음).
  const forecastPeriods = [];
  {
    let cur = nextPeriod(endPeriod);
    for (let i = 0; i < forecastMonths; i++) {
      forecastPeriods.push(cur);
      cur = nextPeriod(cur);
    }
  }

  // 시즈널 가이드: 최종 실측 기준 "고정 윈도우"(같은 month-of-year 최근 N년 m-m 평균, 동결).
  // 입력 mm_history가 gap-aware이므로 오염된 표본이 자동 배제됨.
  // 지평 1~12M는 rolling과 표본 동일(값 불변), 12M 초과 연장 구간만 rolling과 갈림 →
  // 연평균 카드(annualYoYSummaryUS, 익년 12월까지 고정 윈도우 연장)와 차트 전망선을 정렬하기 위해 고정 사용.
  const seasonalAvgFixed = seasonalAvgMM(mm_history, meta.window_years, endPeriod, forecastMonths);
  assertSeasonalCoverage(seasonalAvgFixed);
  const guide = {
    seasonal_avg_window: seasonalAvgFixed,
    seasonal_trimmed_window: seasonalTrimmedAvgMM(mm_history, meta.window_years, endPeriod, forecastMonths),
    recent_6m_avg: recentAvgMM(mm_history, 6),
    recent_12m_avg: recentAvgMM(mm_history, 12),
    insufficient_months: insufficientMonths(seasonalAvgFixed),
  };

  const last24 = mm_history.slice(-24).map((p) => p.period);
  const mm_guide_full = [
    ...rollingSeasonalAvgMM(mm_history, meta.window_years, last24),
    ...seasonalAvgFixed,
  ];

  const mm_forecast = resolveForecastMM(scenario, guide.seasonal_avg_window);
  const index_forecast = projectIndex(lastIndex, mm_forecast);

  const forecastStart = index_forecast[0]?.period;
  const yoy_forecast = forecastStart
    ? computeYY([...sorted, ...index_forecast]).filter(
        (p) => comparePeriods(p.period, forecastStart) >= 0,
      )
    : [];

  return {
    series_id: scenario.series_id,
    scenario_id: scenario.scenario_id,
    index_history: sorted,
    index_forecast,
    mm_history,
    mm_forecast,
    yoy_history,
    yoy_forecast,
    guide,
    mm_guide_full,
  };
}
