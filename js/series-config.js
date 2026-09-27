// series-config.js — 시리즈 메타데이터 (조회 페이지 + admin 공유).
// Fenrir series-config.ts에서 이 프로젝트에 필요한 필드만 추림.
// 데이터 자체는 data/*.js에 있고, 여기엔 "성질"(type/frequency/소스/표시명)만.

export const SERIES_CONFIG = {
  'kr-cpi-headline': {
    series_id: 'kr-cpi-headline',
    display_name: 'KR CPI 총지수 (NSA)',
    source: 'kosis',
    unit: '2020=100',
    value_type: 'index',
    frequency: 'monthly',
    // KOSIS CSV에서 이 시리즈를 식별하는 힌트 (admin 자동 매칭용)
    kosis_hint: { account: '총지수', transform: '원자료' },
  },
  'kr-cpi-core': {
    series_id: 'kr-cpi-core',
    display_name: 'KR Core CPI (식료품·에너지 제외, OECD)',
    source: 'kosis',
    unit: '2020=100',
    value_type: 'index',
    frequency: 'monthly',
    kosis_hint: { account: '식료품및에너지제외지수', transform: '원자료' },
  },
  'kr-cpi-lifecost': {
    series_id: 'kr-cpi-lifecost',
    display_name: 'KR 생활물가지수',
    source: 'kosis',
    unit: '2020=100',
    value_type: 'index',
    frequency: 'monthly',
    // 정확 일치 우선 — '전월세포함 생활물가지수' 등 파생 라벨과 오매칭 방지.
    kosis_hint: { account: '생활물가지수', transform: '원자료' },
  },
  'us-cpi-headline': {
    series_id: 'us-cpi-headline',
    display_name: 'US CPI All Items (NSA)',
    source: 'bls',
    unit: '1982-84=100',
    value_type: 'index',
    frequency: 'monthly',
  },
  'us-cpi-core': {
    series_id: 'us-cpi-core',
    display_name: 'US CPI ex Food & Energy (NSA)',
    source: 'bls',
    unit: '1982-84=100',
    value_type: 'index',
    frequency: 'monthly',
  },
};

export const ALL_SERIES_IDS = Object.keys(SERIES_CONFIG);

// 시즈널 표본 이상치 제외 (방법론 v1.1, 2026-09-27). 해당 달의 m-m 을 시즈널 창 표본에서 드롭한다
// (창 길이는 늘리지 않음 → 단순평균 기준 "나머지 해 평균으로 대체"와 동일).
//   kind 'shock'  : 일시 충격 달. 추세 참고값(c2)에서는 이 달 지수 수준을 기저 정상화 대상으로 쓴다.
//   kind 'rebound': 충격 해소 반등 달. 시즈널 표본에서만 드롭, 지수 수준은 건드리지 않는다.
// calc 는 무의존 — 호출자(admin·조회 페이지)가 seasonalExclusionsFor(id) 를 meta.seasonal_exclusions 로 넘긴다.
//   group: 각주 묶음 라벨.
const TELECOM_2025 = [
  { period: '2025-08', kind: 'shock', reason: '통신요금 50% 한시 할인', group: '통신요금 한시 할인' },
  { period: '2025-09', kind: 'rebound', reason: '할인 종료 반등', group: '통신요금 한시 할인' },
];
export const SEASONAL_EXCLUSIONS = ['kr-cpi-headline', 'kr-cpi-core', 'kr-cpi-lifecost']
  .flatMap((series) => TELECOM_2025.map((e) => ({ series, ...e })));

export function seasonalExclusionsFor(seriesId) {
  return SEASONAL_EXCLUSIONS.filter((e) => e.series === seriesId).map(({ series, ...e }) => e);
}

// guide.excluded → "시즈널 제외: 2025-08, 2025-09 (통신요금 한시 할인)". 비었으면 ''.
export function exclusionFootnote(excluded) {
  if (!excluded?.length) return '';
  const groups = [...new Set(excluded.map((e) => e.group || e.reason))];
  return `시즈널 제외: ${excluded.map((e) => e.period).join(', ')} (${groups.join(' · ')})`;
}

export function getConfig(seriesId) {
  return SERIES_CONFIG[seriesId] ?? null;
}

// 조회 페이지가 data/*.js가 등록한 데이터를 읽는 진입점.
// 각 data 파일은 window.FENRIR_SERIES[series_id] = { meta, series } 로 자기 등록.
export function getSeriesData(seriesId) {
  const reg = (typeof window !== 'undefined' && window.FENRIR_SERIES) || {};
  return reg[seriesId] ?? null;
}
