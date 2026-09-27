// 시즈널 이상치 제외 테스트 — node --test (인자 없이 자동탐색).
//
// 초점: meta.seasonal_exclusions 로 넘긴 (period) m-m 표본을 시즈널 창에서 드롭한다.
// 목록이 없으면(US·나우캐스트·골든) 출력 불변. 기대값은 gap 2차 분석(8e171c2)의 "나머지 9년 평균 대체"값 —
// 단순평균에서는 드롭과 대체가 같다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import * as calc from '../js/calc.js';
import * as config from '../js/series-config.js';

const { buildForecast, computeMM, seasonalAvgMM } = calc;
const AS_OF = '2026-08'; // 이후 data 갱신과 무관하게 같은 입력
const IDS = ['kr-cpi-headline', 'kr-cpi-core', 'kr-cpi-lifecost'];

function loadStored(id) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(new URL(`../data/${id}.js`, import.meta.url), 'utf8'), ctx);
  return ctx.window.FENRIR_SERIES[id].series.filter((p) => p.period <= AS_OF);
}
const exclusionsFor = (id) => (typeof config.seasonalExclusionsFor === 'function' ? config.seasonalExclusionsFor(id) : undefined);
const forecast = (id, exclusions) => buildForecast(loadStored(id),
  { series_id: id, scenario_id: 'base', label: 'Base', mm_overrides: [] },
  { series_id: id, window_years: 10, notes: '', comparison_label: '', ...(exclusions ? { seasonal_exclusions: exclusions } : {}) }, 12);
const guideAt = (r, period) => r.guide.seasonal_avg_window.find((g) => g.period === period);

// ── 설정 ────────────────────────────────────────────────────────────────

test('series-config — KR 3종 각각 2025-08(shock)·2025-09(rebound) 제외 항목', () => {
  assert.ok(Array.isArray(config.SEASONAL_EXCLUSIONS));
  for (const id of IDS) {
    const ex = exclusionsFor(id);
    assert.deepEqual(ex.map((e) => [e.period, e.kind]), [['2025-08', 'shock'], ['2025-09', 'rebound']], id);
    assert.ok(ex.every((e) => typeof e.reason === 'string' && e.reason.length > 0), id);
  }
});

test('series-config — 목록에 없는 시리즈(US 등)는 빈 배열', () => {
  assert.deepEqual(exclusionsFor('us-cpi-headline'), []);
  assert.deepEqual(exclusionsFor('nope'), []);
});

test('calc 무의존 유지 — calc.js 에 import 없음', () => {
  const src = readFileSync(new URL('../js/calc.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^\s*import\s/m);
});

// ── a) 목록 비면 불변 ────────────────────────────────────────────────────

test('a) seasonal_exclusions = [] 이면 목록 없을 때와 출력 동일(골든 경로)', () => {
  for (const id of IDS) {
    const none = forecast(id, undefined);
    const empty = forecast(id, []);
    assert.deepEqual(empty.mm_forecast, none.mm_forecast, id);
    assert.deepEqual(empty.mm_guide_full.map((g) => g.value), none.mm_guide_full.map((g) => g.value), id);
    assert.deepEqual(empty.guide.excluded, [], id);
  }
});

// ── b) 제외 적용 = 2차 분석 대체값 ──────────────────────────────────────

const EXPECT = {
  'kr-cpi-headline': { '2026-09': 0.398, '2027-08': 0.459 },
  'kr-cpi-core': { '2026-09': -0.169, '2027-08': 0.191 },
  'kr-cpi-lifecost': { '2026-09': 0.842, '2027-08': 0.569 },
};

test('b) 제외 적용 시 2026-09·2027-08 가이드 m-m 이 2차 분석값과 일치(±0.001)', () => {
  for (const id of IDS) {
    const r = forecast(id, exclusionsFor(id));
    for (const [period, want] of Object.entries(EXPECT[id])) {
      const g = guideAt(r, period);
      assert.ok(Math.abs(g.value - want) <= 0.001, `${id} ${period}: ${g.value} vs ${want}`);
      assert.equal(g.samples, 9, `${id} ${period} 표본 10→9`);
    }
    // 전망 경로도 같은 가이드를 쓴다
    assert.equal(r.mm_forecast.find((p) => p.period === '2026-09').value, guideAt(r, '2026-09').value);
  }
});

test('b) 제외 달이 아닌 달력월(예: 2027-01)은 값 불변', () => {
  for (const id of IDS) {
    assert.equal(guideAt(forecast(id, exclusionsFor(id)), '2027-01').value, guideAt(forecast(id, undefined), '2027-01').value, id);
  }
});

test('b) trimmed 가이드도 같은 표본 집합(9개)을 쓴다', () => {
  const r = forecast('kr-cpi-core', exclusionsFor('kr-cpi-core'));
  assert.equal(r.guide.seasonal_trimmed_window.find((g) => g.period === '2027-08').samples, 9);
});

// ── rolling(차트 과거 점선)도 제외 ──────────────────────────────────────

test('rolling — 과거 구간 2026-08 점선은 2016~2024년 8월 평균(2025-08 드롭)', () => {
  const id = 'kr-cpi-headline';
  const mm = computeMM(loadStored(id));
  const want = mm.filter((p) => p.period.endsWith('-08') && p.period >= '2016-08' && p.period <= '2024-08');
  const mean = want.reduce((s, p) => s + p.value, 0) / want.length;
  const r = forecast(id, exclusionsFor(id));
  const hist = r.mm_guide_full.find((g) => g.period === '2026-08');
  assert.ok(Math.abs(hist.value - mean) < 1e-12, `${hist.value} vs ${mean}`);
});

// ── c) 목록 없는 경로 불변 ──────────────────────────────────────────────

test('c) seasonalAvgMM 을 제외 인자 없이 부르면 종전과 같은 표본(10개)', () => {
  const mm = computeMM(loadStored('kr-cpi-headline'));
  const g = seasonalAvgMM(mm, 10, AS_OF, 12).find((x) => x.period === '2027-08');
  assert.equal(g.samples, 10);
});
// US·나우캐스트 출력 불변은 tests/calc-seasonal-guard.test.mjs 골든(입력 포함 fixture)이 고정한다.

// ── d) excluded 노출 ───────────────────────────────────────────────────

test('d) guide.excluded 에 창 안에서 드롭된 항목 노출', () => {
  const r = forecast('kr-cpi-headline', exclusionsFor('kr-cpi-headline'));
  assert.deepEqual(r.guide.excluded.map((e) => [e.period, e.kind]), [['2025-08', 'shock'], ['2025-09', 'rebound']]);
  assert.ok(r.guide.excluded.every((e) => e.reason));
});

test('d) 창 밖 제외 항목은 excluded 에 없음 (2025-06 기준 전망)', () => {
  const id = 'kr-cpi-headline';
  const hist = loadStored(id).filter((p) => p.period <= '2025-06');
  const r = buildForecast(hist, { series_id: id, scenario_id: 'base', label: 'Base', mm_overrides: [] },
    { series_id: id, window_years: 10, notes: '', comparison_label: '', seasonal_exclusions: exclusionsFor(id) }, 12);
  assert.deepEqual(r.guide.excluded, []);
});

test('연평균 카드(annualYoYSummary)도 같은 제외를 받는다 — 목록 유무에 따라 값이 달라짐', () => {
  const id = 'kr-cpi-core';
  const s = { series_id: id, scenario_id: 'base', label: 'Base', mm_overrides: [] };
  const m = { series_id: id, window_years: 10, notes: '', comparison_label: '' };
  const without = calc.annualYoYSummary(loadStored(id), s, m);
  const withEx = calc.annualYoYSummary(loadStored(id), s, { ...m, seasonal_exclusions: exclusionsFor(id) });
  assert.notDeepEqual(withEx.years[1], without.years[1]);
});

// ── 호출자 배선 ─────────────────────────────────────────────────────────

test('호출자 — admin·조회 페이지가 series-config 의 제외 목록을 meta 로 넘긴다', () => {
  for (const f of ['admin-ui.js', 'forecast-ui.js']) {
    const src = readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
    assert.match(src, /seasonal_exclusions:\s*seasonalExclusionsFor\(/, f);
  }
});

test('조회 페이지 방법론 라벨 v1.1 + 변경 이력 한 줄', () => {
  const src = readFileSync(new URL('../js/forecast-ui.js', import.meta.url), 'utf8');
  assert.match(src, /방법론 v1\.1/);
  assert.match(src, /v1\.1 \(2026-09-27\): 시즈널 표본 이상치 제외 목록 추가 — 2025-08·09 통신요금 한시 할인/);
});
