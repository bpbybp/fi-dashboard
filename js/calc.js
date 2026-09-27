// calc.js — Fenrir inflation-forecast/calc.ts 를 순수 JS(ES module)로 1:1 이식.
// 외부 의존 없음. buildForecast가 진입점.
//
// 타입(참고용):
//   IndexPoint      = { period: 'YYYY-MM', value: number }
//   ScenarioRecord  = { series_id, scenario_id, label, mm_overrides: [{period, mm}], last_edited }
//   MetaRecord      = { series_id, window_years: 5|10|15, notes, comparison_label }
//   MmGuide         = { seasonal_avg_window, seasonal_trimmed_window, recent_6m_avg, recent_12m_avg }
//   ForecastResult  = { series_id, scenario_id, index_history, index_forecast,
//                       mm_history, mm_forecast, yoy_history, yoy_forecast, guide, mm_guide_full }

// ─────────────────────────────────────────────────────────────
//  'YYYY-MM' 산수
// ─────────────────────────────────────────────────────────────

function parsePeriod(period) {
  const [y, m] = period.split('-').map(Number);
  return { year: y, month: m };
}

function formatPeriod(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export function nextPeriod(period) {
  const { year, month } = parsePeriod(period);
  return month === 12 ? formatPeriod(year + 1, 1) : formatPeriod(year, month + 1);
}

export function prevPeriod(period, n = 1) {
  let { year, month } = parsePeriod(period);
  month -= n;
  while (month <= 0) {
    month += 12;
    year -= 1;
  }
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  return formatPeriod(year, month);
}

export function periodMonth(period) {
  return parsePeriod(period).month;
}

export function comparePeriods(a, b) {
  // 'YYYY-MM' 형식은 사전식 비교가 곧 시간 순 비교.
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────
//  핵심 계산
// ─────────────────────────────────────────────────────────────

function sortByPeriod(points) {
  return [...points].sort((a, b) => comparePeriods(a.period, b.period));
}

// 인덱스 → m-m: ((idx[t]/idx[t-1]) - 1) * 100
export function computeMM(history) {
  const sorted = sortByPeriod(history);
  const result = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1].value;
    if (prev === 0) continue; // 0 나눗셈 방지
    result.push({
      period: sorted[i].period,
      value: (sorted[i].value / prev - 1) * 100,
    });
  }
  return result;
}

// 인덱스 → y-y: ((idx[t]/idx[t-12]) - 1) * 100. t-12 데이터 없으면 결과 제외.
export function computeYY(history) {
  const sorted = sortByPeriod(history);
  const map = new Map(sorted.map((p) => [p.period, p.value]));
  const result = [];
  for (const p of sorted) {
    const ref = map.get(prevPeriod(p.period, 12));
    if (ref === undefined || ref === 0) continue;
    result.push({
      period: p.period,
      value: (p.value / ref - 1) * 100,
    });
  }
  return result;
}

// 분기 인덱스 → 4-quarter change y-y. 분기 시점은 'YYYY-03/06/09/12'로 인입.
export function computeQuarterlyYY(history) {
  return computeYY(history);
}

// 달력월 표본이 이보다 적으면 시즈널 가이드를 insufficient 로 표시.
export const MIN_SEASONAL_SAMPLES = 3;

// 시즈널 평균 m-m: 1~12월 각각의 N년 평균 (고정 endPeriod 윈도우).
// 각 항목 { period, value, samples, insufficient }. 표본 0개면 value = null (0% 로 대체하지 않음).
export function seasonalAvgMM(mmHistory, windowYears, endPeriod, forecastMonths) {
  const byMonth = collectMonthSamples(mmHistory, windowYears, endPeriod);
  const result = [];
  let p = nextPeriod(endPeriod);
  for (let i = 0; i < forecastMonths; i++) {
    const samples = byMonth.get(periodMonth(p)) ?? [];
    const value = samples.length > 0
      ? samples.reduce((s, v) => s + v, 0) / samples.length
      : null;
    result.push(seasonalPoint(p, value, samples.length));
    p = nextPeriod(p);
  }
  return result;
}

// trimmed mean (상하위 trimRatio% 제거. 기본 0.1). trim 후 0개면 trim 없는 평균 폴백.
// 항목 형태·표본 0개 처리는 seasonalAvgMM 과 동일.
export function seasonalTrimmedAvgMM(mmHistory, windowYears, endPeriod, forecastMonths, trimRatio = 0.1) {
  const byMonth = collectMonthSamples(mmHistory, windowYears, endPeriod);
  const result = [];
  let p = nextPeriod(endPeriod);
  for (let i = 0; i < forecastMonths; i++) {
    const samples = byMonth.get(periodMonth(p)) ?? [];
    const value = samples.length > 0 ? trimmedMean(samples, trimRatio) : null;
    result.push(seasonalPoint(p, value, samples.length));
    p = nextPeriod(p);
  }
  return result;
}

function seasonalPoint(period, value, samples) {
  return { period, value, samples, insufficient: samples < MIN_SEASONAL_SAMPLES };
}

// 시즈널 가이드에 표본 0개 달이 있으면 던진다 — 0% 전망으로 조용히 진행하지 않는다.
export function assertSeasonalCoverage(guide) {
  const empty = [...new Set(guide.filter((g) => g.samples === 0).map((g) => periodMonth(g.period)))];
  if (empty.length > 0) {
    throw new Error(`시즈널 표본 0개 — ${empty.join('·')}월 전망 불가 (이력이 너무 짧음)`);
  }
}

// 표본 < MIN_SEASONAL_SAMPLES 인 달력월 목록 [{ month, samples }] (가이드 순서, 중복 제거).
export function insufficientMonths(guide) {
  const seen = new Map();
  for (const g of guide) {
    const month = periodMonth(g.period);
    if (g.insufficient && !seen.has(month)) seen.set(month, { month, samples: g.samples });
  }
  return [...seen.values()];
}

// 시점별 rolling 시즈널 평균. 각 period p마다 윈도우 [p - windowYears*12 .. p-1]을 잡고
// 같은 month-of-year의 m-m을 평균. 실측 갱신 효과 반영.
export function rollingSeasonalAvgMM(mmHistory, windowYears, periods) {
  const sortedHistory = sortByPeriod(mmHistory);
  return periods.map((p) => {
    const monthOfYear = periodMonth(p);
    const windowStart = prevPeriod(p, windowYears * 12);
    const windowEnd = prevPeriod(p, 1);
    const samples = [];
    for (const h of sortedHistory) {
      if (comparePeriods(h.period, windowStart) < 0) continue;
      if (comparePeriods(h.period, windowEnd) > 0) continue;
      if (periodMonth(h.period) !== monthOfYear) continue;
      samples.push(h.value);
    }
    const value = samples.length > 0
      ? samples.reduce((s, v) => s + v, 0) / samples.length
      : 0;
    return { period: p, value };
  });
}

// 최근 N개월 단순 평균. 데이터 부족 시 가용한 만큼만.
export function recentAvgMM(mmHistory, months) {
  const sorted = sortByPeriod(mmHistory);
  const recent = sorted.slice(-months);
  if (recent.length === 0) return 0;
  return recent.reduce((s, p) => s + p.value, 0) / recent.length;
}

// 추정 m-m 결정: override 있으면 그 값, 없으면 guide 값. override는 clipping 없이 그대로.
export function resolveForecastMM(scenario, guideSeasonal) {
  const overrides = new Map(scenario.mm_overrides.map((o) => [o.period, o.mm]));
  return guideSeasonal.map((g) => ({
    period: g.period,
    value: overrides.has(g.period) ? overrides.get(g.period) : g.value,
  }));
}

// 인덱스 forecast: idx[t] = idx[t-1] * (1 + mm[t]/100)
export function projectIndex(lastIndex, mmAssumptions) {
  const result = [];
  let prev = lastIndex.value;
  for (const mm of mmAssumptions) {
    const next = prev * (1 + mm.value / 100);
    result.push({ period: mm.period, value: next });
    prev = next;
  }
  return result;
}

// ─────────────────────────────────────────────────────────────
//  통합
// ─────────────────────────────────────────────────────────────

export function buildGuide(mmHistory, meta, endPeriod, forecastMonths) {
  return {
    seasonal_avg_window: seasonalAvgMM(mmHistory, meta.window_years, endPeriod, forecastMonths),
    seasonal_trimmed_window: seasonalTrimmedAvgMM(mmHistory, meta.window_years, endPeriod, forecastMonths),
    recent_6m_avg: recentAvgMM(mmHistory, 6),
    recent_12m_avg: recentAvgMM(mmHistory, 12),
  };
}

const EMPTY_GUIDE = () => ({
  seasonal_avg_window: [],
  seasonal_trimmed_window: [],
  recent_6m_avg: 0,
  recent_12m_avg: 0,
  insufficient_months: [],
});

export function buildForecast(
  index_history,
  scenario,
  meta,
  forecastMonths = 12,
  valueType = 'index',
  frequency = 'monthly',
) {
  const sorted = sortByPeriod(index_history);

  // 분기 발표 시리즈 — m-m/forecast 미사용, y-y는 4-quarter change.
  if (frequency === 'quarterly') {
    return {
      series_id: scenario.series_id,
      scenario_id: scenario.scenario_id,
      index_history: sorted,
      index_forecast: [],
      mm_history: [],
      mm_forecast: [],
      yoy_history: computeQuarterlyYY(sorted),
      yoy_forecast: [],
      guide: EMPTY_GUIDE(),
      mm_guide_full: [],
    };
  }

  // rate 시리즈 — 값이 이미 y-y율.
  if (valueType === 'rate') {
    return {
      series_id: scenario.series_id,
      scenario_id: scenario.scenario_id,
      index_history: sorted,
      index_forecast: [],
      mm_history: [],
      mm_forecast: [],
      yoy_history: sorted,
      yoy_forecast: [],
      guide: EMPTY_GUIDE(),
      mm_guide_full: [],
    };
  }

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

  const mm_history = computeMM(sorted);
  const yoy_history = computeYY(sorted);
  const lastIndex = sorted[sorted.length - 1];
  const endPeriod = lastIndex.period;

  // forecast periods: nextPeriod(endPeriod)부터 forecastMonths개월
  const forecastPeriods = [];
  {
    let cur = nextPeriod(endPeriod);
    for (let i = 0; i < forecastMonths; i++) {
      forecastPeriods.push(cur);
      cur = nextPeriod(cur);
    }
  }

  // guide.seasonal_avg_window: 전망 시점 시즈널 가이드 — 최종 실측 기준 "고정 윈도우"(동결).
  // 지평 1~12M 구간은 rolling과 표본이 수학적으로 동일하고(값 불변), 12M 초과 연장 구간에서만
  // rolling과 갈린다. 연평균 요약 카드(annualYoYSummary)가 익년 12월까지 고정 윈도우로 연장하므로,
  // 카드와 차트 전망선이 전 지평에서 일치하도록 엔진도 고정 윈도우로 정렬.
  const seasonalAvgFixed = seasonalAvgMM(mm_history, meta.window_years, endPeriod, forecastMonths);
  assertSeasonalCoverage(seasonalAvgFixed);
  const guide = {
    seasonal_avg_window: seasonalAvgFixed,
    seasonal_trimmed_window: seasonalTrimmedAvgMM(mm_history, meta.window_years, endPeriod, forecastMonths),
    recent_6m_avg: recentAvgMM(mm_history, 6),
    recent_12m_avg: recentAvgMM(mm_history, 12),
    insufficient_months: insufficientMonths(seasonalAvgFixed),
  };

  // mm_guide_full: history 마지막 24개월(회고적 rolling) + forecast 구간(고정 윈도우, 위 가이드와 동일).
  const last24HistoryPeriods = mm_history.slice(-24).map((p) => p.period);
  const mm_guide_full = [
    ...rollingSeasonalAvgMM(mm_history, meta.window_years, last24HistoryPeriods),
    ...seasonalAvgFixed,
  ];

  const mm_forecast = resolveForecastMM(scenario, guide.seasonal_avg_window);
  const index_forecast = projectIndex(lastIndex, mm_forecast);

  // forecast 구간 y-y는 history+forecast 인덱스 합쳐 계산 후 forecast 구간만 추출.
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

// ─────────────────────────────────────────────────────────────
//  연평균 y-y 요약 (당해년도·익년도)
// ─────────────────────────────────────────────────────────────

// 전망 경로(입력>시즈널 가이드)로 당해년도·익년도 연평균 y-y를 산출.
// 규약:
//   · 경로 = 실측 구간은 실측, 전망 구간은 resolved(override 우선, 미입력은 시즈널 가이드).
//   · 체인 연장: 사용자 입력 지평과 무관하게 익년 12월까지 가이드로 자동 연장(계산 전용).
//   · 시즈널 가이드는 최종 실측 기준 "고정 윈도우"(seasonalAvgMM) — 차트 전망 경로와 동일 소스
//     (기본 12M 지평 내에서는 rolling과 표본이 일치, 연장 구간은 고정 윈도우로 확장).
//   · 연도는 최종 실측 period 기준 동적 산출(하드코딩 없음).
//   · 연평균 = 해당 연도 가용 월별 y-y의 단순평균. y-y 산출 불가 월(gap)은 제외하고 개월수 함께 반환.
//   · mmFn: 인덱스→m-m 변환기 주입(공용 computeMM / US gap-aware computeMMGapAware).
export function annualYoYSummary(index_history, scenario, meta, mmFn = computeMM) {
  const sorted = sortByPeriod(index_history);
  if (sorted.length === 0) return { current_year: null, next_year: null, years: [] };

  const lastIndex = sorted[sorted.length - 1];
  const lastPeriod = lastIndex.period;
  const currentYear = parsePeriod(lastPeriod).year;
  const nextYear = currentYear + 1;
  const endTarget = formatPeriod(nextYear, 12);

  // 연장 전망 시점: 최종 실측 다음 달 ~ 익년 12월 (입력 지평 무관).
  const periods = [];
  {
    let cur = nextPeriod(lastPeriod);
    while (comparePeriods(cur, endTarget) <= 0) {
      periods.push(cur);
      cur = nextPeriod(cur);
    }
  }

  const mmHistory = mmFn(sorted);
  const guide = seasonalAvgMM(mmHistory, meta.window_years, lastPeriod, periods.length);
  assertSeasonalCoverage(guide);
  const overrides = new Map(scenario.mm_overrides.map((o) => [o.period, o.mm]));

  // 성분 출처: 실측 / 입력(override) / 가이드.
  const source = new Map();
  for (const p of sorted) source.set(p.period, 'actual');
  const resolvedMM = guide.map((g) => {
    const has = overrides.has(g.period);
    source.set(g.period, has ? 'input' : 'guide');
    return { period: g.period, value: has ? overrides.get(g.period) : g.value };
  });

  const indexForecast = projectIndex(lastIndex, resolvedMM);
  const yoyMap = new Map(
    computeYY([...sorted, ...indexForecast]).map((p) => [p.period, p.value]),
  );

  const years = [currentYear, nextYear].map((year) => summarizeYear(year, yoyMap, source));
  return { current_year: currentYear, next_year: nextYear, years };
}

// 한 해 12개월 중 y-y 가용 월만 단순평균 + 성분 개월수 집계(gap 월 제외).
function summarizeYear(year, yoyMap, source) {
  let sum = 0, months = 0, actual = 0, input = 0, guide = 0;
  for (let m = 1; m <= 12; m++) {
    const period = formatPeriod(year, m);
    if (!yoyMap.has(period)) continue; // y-y 산출 불가 월(예: base 결측) 제외
    sum += yoyMap.get(period);
    months += 1;
    const s = source.get(period);
    if (s === 'actual') actual += 1;
    else if (s === 'input') input += 1;
    else guide += 1;
  }
  return {
    year,
    avg: months > 0 ? sum / months : null,
    months,
    complete: months === 12,
    actual,
    input,
    guide,
  };
}

// ─────────────────────────────────────────────────────────────
//  내부 유틸
// ─────────────────────────────────────────────────────────────

// endPeriod로부터 windowYears*12개월 내(endPeriod 포함) 샘플을 month-of-year별로 모음.
function collectMonthSamples(mmHistory, windowYears, endPeriod) {
  const sorted = sortByPeriod(mmHistory);
  const windowStart = prevPeriod(endPeriod, windowYears * 12 - 1);
  const byMonth = new Map();
  for (const p of sorted) {
    if (comparePeriods(p.period, windowStart) < 0) continue;
    if (comparePeriods(p.period, endPeriod) > 0) continue;
    const m = periodMonth(p.period);
    const list = byMonth.get(m);
    if (list) list.push(p.value);
    else byMonth.set(m, [p.value]);
  }
  return byMonth;
}

function trimmedMean(samples, trimRatio) {
  if (samples.length === 0) return 0;
  const sortedAsc = [...samples].sort((a, b) => a - b);
  const trimCount = Math.floor(sortedAsc.length * trimRatio);
  const trimmed = sortedAsc.slice(trimCount, sortedAsc.length - trimCount);
  if (trimmed.length === 0) {
    return sortedAsc.reduce((s, v) => s + v, 0) / sortedAsc.length;
  }
  return trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
}
