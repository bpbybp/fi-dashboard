// ⚠️ Fenrir calculator.ts 미반영 — 임계값 매개변수화(2026-09-16). opts 미지정 호출은
//    원본과 동일(ge0/ge2/ge25/ge3 + ex_energy ge0/ge2). US만 opts로 ge3_5·ex_energy 확장 계열
//    추가 산출. 방법론(가중식·재정규화·z-score·flash) 자체 변경 아님.
// ⚠️ 이식본 (PORTED) — 원본: Fenrir src/lib/inflation-diffusion/calculator.ts (+ types.ts)
//    기준 커밋: a242949 (기본 8계열) + 1266dfc·51c7abd (ex_energy 재정규화 추가).
//    이 파일의 방법론(임계치·가중식·z-score·flash 판정·ex_energy) 수정 시 반드시 Fenrir
//    원본과 동시 반영할 것. (이중 구현 드리프트 방지 — 한쪽만 고치면 확산지수가 조용히 갈라짐.)
//    TS→ESM 손이식. 로직·상수는 원본과 1:1, 타입 주석만 제거.
//
// 확산지수 방법론 요약:
//   - 변화율: YoY (전년동월비). MoM 아님(노이즈 과다).
//   - 임계 4종 × 가중/비가중 = 8계열.
//   - 가중:  Σ(임계초과 품목 가중치) / Σ(유효 품목 가중치) × 100
//   - 비가중: (임계초과 품목수) / (유효 품목수) × 100
//   - yoy=null → 분모·분자 양쪽 제외. weight=null → 가중 버전에서만 제외.
//   - ex_energy(ge0/ge2): 에너지 직계+파급 제외 후 비제외 가중 합으로 재정규화(코어 판독).
//     제외 테이블(diffusion-exclusions.mjs) 없는 국가는 전체 가중 시리즈와 동일(퇴화).
//   - z-score: 5년 rolling, population std. history<12개월 → 0(warmup, UI 회색).
//   - flash: 유효 yoy 비율 < 20% → 레코드 null(z-score baseline 오염 방지).

import { exclusionCodeSet } from './diffusion-exclusions.mjs';

/** 임계치 상수 (ge0=≥0%, ge2=≥2%, ge25=≥2.5%, ge3=≥3%) */
export const THRESHOLDS = { ge0: 0, ge2: 2, ge25: 2.5, ge3: 3 };
const THRESHOLD_KEYS = Object.keys(THRESHOLDS);

/** ex-energy 재정규화 시리즈에서 산출하는 임계치 (ge0/ge2만). */
const EX_ENERGY_THRESHOLDS = [
  ['ge0', THRESHOLDS.ge0],
  ['ge2', THRESHOLDS.ge2],
];

/**
 * US 전용 임계값 확장 (FOMC 위원 프레임 대조용 토글: 2 / 2.5 / 3 / 3.5%).
 *   extraThresholds: 기본 4종에 더해 산출할 임계(가중·비가중·z) — ge3_5=≥3.5%.
 *   exEnergyKeys: ex_energy에서 산출할 임계 키 (기본 ge0/ge2 → 2.5·3·3.5 추가).
 * 타국은 opts 미지정 → 출력 키·값 기존과 동일.
 */
export const US_THRESHOLD_OPTS = Object.freeze({
  extraThresholds: Object.freeze({ ge3_5: 3.5 }),
  exEnergyKeys: Object.freeze(['ge0', 'ge2', 'ge25', 'ge3', 'ge3_5']),
});

/** Z-score warmup: 최소 이만큼의 history 개월이 있어야 의미 있는 z. */
export const Z_MIN_HISTORY = 12;

function emptyThresholdRecord() {
  return { ge0: 0, ge2: 0, ge25: 0, ge3: 0 };
}

/**
 * 단일 스냅샷 → 8계열 확산 결과.
 * yoy=null 품목은 가중·비가중 양쪽 분모/분자에서 제외.
 * weight=null(또는 ≤0) 품목은 가중 버전에서만 제외, 비가중엔 포함.
 * 반환값은 0~100 범위.
 */
export function computeDiffusion(snapshot, opts = {}) {
  const validItems = snapshot.items.filter((i) => i.yoy !== null);
  const itemsWithWeight = validItems.filter(
    (i) => i.weight !== null && i.weight > 0
  );
  const totalWeight = itemsWithWeight.reduce((s, i) => s + i.weight, 0);

  const thresholds = opts.extraThresholds ? { ...THRESHOLDS, ...opts.extraThresholds } : THRESHOLDS;
  const weighted = emptyThresholdRecord();
  const unweighted = emptyThresholdRecord();

  for (const key of Object.keys(thresholds)) {
    const tau = thresholds[key];
    if (!(key in weighted)) { weighted[key] = 0; unweighted[key] = 0; }

    if (totalWeight > 0) {
      const matchingWeight = itemsWithWeight
        .filter((i) => i.yoy >= tau)
        .reduce((s, i) => s + i.weight, 0);
      weighted[key] = (matchingWeight / totalWeight) * 100;
    }

    if (validItems.length > 0) {
      const matchingCount = validItems.filter((i) => i.yoy >= tau).length;
      unweighted[key] = (matchingCount / validItems.length) * 100;
    }
  }

  return {
    weighted, unweighted,
    ex_energy: computeExEnergy(snapshot, itemsWithWeight, thresholds, opts.exEnergyKeys),
  };
}

/**
 * ex-energy 가중 diffusion (ge0/ge2).
 * 에너지 직계+파급 2차 제외 후 **비제외 품목 가중 합**을 분모로 재정규화:
 *   D_ex(τ, t) = Σ_{i ∉ E, π_i ≥ τ} w_i / Σ_{i ∉ E} w_i × 100
 * E = exclusionCodeSet(country), i는 (yoy≠null ∧ weight>0)인 품목.
 * 분모(비제외 가중 합) 0이면 0 반환. 제외 테이블 없는 국가는 E=∅ → 전체 가중과 동일(퇴화).
 */
function computeExEnergy(snapshot, itemsWithWeight, thresholds = THRESHOLDS, exEnergyKeys) {
  const excluded = exclusionCodeSet(snapshot.country);
  const included = itemsWithWeight.filter((i) => !excluded.has(i.code));
  const denom = included.reduce((s, i) => s + i.weight, 0);

  // 기본 ge0/ge2 (원본). exEnergyKeys 지정 시 그 순서대로 확장.
  const pairs = exEnergyKeys
    ? exEnergyKeys.map((k) => [k, thresholds[k]])
    : EX_ENERGY_THRESHOLDS;
  const weighted = {};
  for (const [key] of pairs) weighted[key] = 0;
  if (denom > 0) {
    for (const [key, tau] of pairs) {
      const matchingWeight = included
        .filter((i) => i.yoy >= tau)
        .reduce((s, i) => s + i.weight, 0);
      weighted[key] = (matchingWeight / denom) * 100;
    }
  }
  return { weighted };
}

/**
 * Population standard deviation. z-score 정규화용 — population 분산은 rolling
 * window 크기와 무관하게 일관돼 window가 커져도 z 거동이 매끄럽다.
 */
function populationStd(values, mean) {
  if (values.length === 0) return 0;
  const variance =
    values.reduce((s, x) => s + (x - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * z = (current - μ) / σ. history.length < Z_MIN_HISTORY(12)면 NaN 대신 0 반환
 * (UI가 warmup 구간을 회색 처리 → 0을 중심 신호로 오독하지 않게).
 */
function zScore(current, history) {
  if (history.length < Z_MIN_HISTORY) return 0;
  const mean = history.reduce((s, x) => s + x, 0) / history.length;
  const std = populationStd(history, mean);
  if (std === 0) return 0;
  return (current - mean) / std;
}

/** 가중 버전만 z-score 계산 (의사결정 lens). */
export function computeZScores(current, history) {
  const weighted = emptyThresholdRecord();
  // 기본 4종 + current에 있는 확장 임계(ge3_5 등). 확장 키도 동일 누적 history 윈도우.
  const keys = [...THRESHOLD_KEYS, ...Object.keys(current.weighted).filter((k) => !THRESHOLD_KEYS.includes(k))];
  for (const key of keys) {
    const series = history.map((h) => h.weighted[key]).filter((v) => v !== undefined);
    weighted[key] = zScore(current.weighted[key], series);
  }
  return { weighted };
}

export function computeWeightCoverage(snapshot) {
  if (snapshot.items.length === 0) return 0;
  const withWeight = snapshot.items.filter(
    (i) => i.weight !== null && i.weight > 0
  ).length;
  return withWeight / snapshot.items.length;
}

/**
 * flash release 판정 임계치. 유효 yoy 품목 비율이 이 값 미만이면 flash로 보고
 * 레코드를 생성하지 않음(모든 확산값이 0이 되어 정상 5y baseline 대비 z가 -15σ까지
 * 왜곡되는 것을 방지). EU 2026-04 flash 사례에서 0.20으로 경험적 확정.
 */
export const FLASH_LEAF_RATIO_THRESHOLD = 0.20;

/** 스냅샷이 flash/preliminary release처럼 보이면 true. */
export function isFlashRelease(snapshot) {
  if (snapshot.items.length === 0) return false; // degenerate, not flash
  const withYoy = snapshot.items.filter((i) => i.yoy !== null).length;
  return withYoy / snapshot.items.length < FLASH_LEAF_RATIO_THRESHOLD;
}

/**
 * 스냅샷 + 누적 history → DiffusionRecord.
 * flash release면 null 반환(호출자는 집계 레코드 저장을 건너뜀).
 */
export function buildRecord(snapshot, history, opts = {}) {
  if (isFlashRelease(snapshot)) return null;
  const diffusion = computeDiffusion(snapshot, opts);
  const z_scores_5y = computeZScores(diffusion, history);
  return {
    country: snapshot.country,
    period: snapshot.period,
    headline_yoy: snapshot.headline_yoy,
    core_yoy: snapshot.core_yoy,
    core_yoy_intl: snapshot.core_yoy_intl ?? null,
    diffusion,
    z_scores_5y,
    item_count: snapshot.items.length,
    weight_coverage: computeWeightCoverage(snapshot),
    source_url: snapshot.source_url,
    fetched_at: snapshot.fetched_at,
  };
}

export const calculator = { computeDiffusion, computeZScores, buildRecord };
