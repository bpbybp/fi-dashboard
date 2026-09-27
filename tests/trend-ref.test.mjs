// 추세 보정 참고값(trend-ref) 테스트 — node --test (인자 없이 자동탐색).
//
// 기대값: gap 2차 분석(8e171c2) analysis/cpi-gap-trend-candidates.csv, 2026-08 기준, ±0.002.
//   W  = 10년 창 m-m 합 / 10 (제외 월 대체 없음 — b 추정 때 x 정의와 일치)
//   c2 = 12개월 y-y, shock 달 지수를 "전월 실제 × (1 + 시즈널 가이드)"로 정상화
//   c3 = W + 12 × mean(최근 6개월 실제 m-m − 제외 적용 시즈널 가이드)
//   제안 보정 = round2(b × mean((c2−W)/12, (c3−W)/12))
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import * as trendRef from '../js/trend-ref.js';
import * as config from '../js/series-config.js';

const AS_OF = '2026-08';
const IDS = ['kr-cpi-headline', 'kr-cpi-core', 'kr-cpi-lifecost'];

function loadStored(id) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(new URL(`../data/${id}.js`, import.meta.url), 'utf8'), ctx);
  return ctx.window.FENRIR_SERIES[id].series.filter((p) => p.period <= AS_OF);
}
const compute = (id, windowYears = 10) => trendRef.computeTrendRef(loadStored(id), {
  windowYears, exclusions: config.seasonalExclusionsFor(id), b: config.TREND_B?.[id]?.b,
});

const EXPECT = {
  'kr-cpi-headline': { W: 2.278, c2: 2.559, c3: 3.3199, suggestion: 0.04, b: 0.69 },
  'kr-cpi-core': { W: 1.879, c2: 2.598, c3: 3.0424, suggestion: 0.06, b: 0.81 },
  'kr-cpi-lifecost': { W: 2.576, c2: 2.186, c3: 2.7505, suggestion: -0.01, b: 0.60 },
};
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('series-config — b 상수(2025-08·09 제외 추정, 10년 창)', () => {
  for (const id of IDS) {
    assert.equal(config.TREND_B[id].b, EXPECT[id].b, id);
    assert.equal(config.TREND_B[id].windowYears, 10, id);
  }
  assert.equal(config.TREND_B['us-cpi-headline'], undefined);
});

for (const id of IDS) {
  test(`${id} — W·c2·c3 가 2차 분석값과 일치(±0.002), 기준월 ${AS_OF}`, () => {
    const r = compute(id);
    const e = EXPECT[id];
    assert.equal(r.asOf, AS_OF);
    near(r.W, e.W, 0.002, 'W');
    near(r.c2, e.c2, 0.002, 'c2');
    near(r.c3, e.c3, 0.002, 'c3');
  });

  test(`${id} — 월 차이 = (c − W)/12, 제안 보정 = ${EXPECT[id].suggestion}`, () => {
    const r = compute(id);
    for (const k of ['c1', 'c2', 'c3']) near(r.diff[k], (r[k] - r.W) / 12, 1e-12, k);
    assert.equal(r.b, EXPECT[id].b);
    near(r.suggestionRaw, r.b * ((r.diff.c2 + r.diff.c3) / 2), 1e-12, 'raw');
    assert.equal(r.suggestion, EXPECT[id].suggestion);
  });
}

test('c1 = 원계열 12개월 y-y (참고용, 정상화 없음)', () => {
  near(compute('kr-cpi-headline').c1, 3.0915, 0.0005, 'c1');
});

test('c2 — shock 달이 창에 없으면 c1 과 같다 (2026-10 이후 가정: 제외 목록 없이 계산)', () => {
  const pts = loadStored('kr-cpi-headline');
  const r = trendRef.computeTrendRef(pts, { windowYears: 10, exclusions: [], b: 0.69 });
  assert.equal(r.c2, r.c1);
});

test('창 선택 — 10년이 아니면 b 정확도 경고, 계산은 선택 창으로', () => {
  const r10 = compute('kr-cpi-core', 10);
  const r5 = compute('kr-cpi-core', 5);
  assert.equal(r10.bWarning, null);
  assert.match(r5.bWarning, /b는 10년 창 기준 추정 — 다른 창에서는 참고 정확도 낮음/);
  assert.notEqual(r5.W, r10.W);
  assert.equal(r5.windowYears, 5);
});

test('b 가 없으면 제안 보정은 null (US 등)', () => {
  const r = trendRef.computeTrendRef(loadStored('kr-cpi-headline'), { windowYears: 10, exclusions: [] });
  assert.equal(r.suggestion, null);
});

test('창이 모자라면 null 반환(던지지 않음)', () => {
  assert.equal(trendRef.computeTrendRef(loadStored('kr-cpi-headline').slice(-60), { windowYears: 10, exclusions: [], b: 0.69 }), null);
});

test('순수 모듈 — DOM·localStorage 미사용, 입력 배열을 변형하지 않음', () => {
  const src = readFileSync(new URL('../js/trend-ref.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /document\.|localStorage|window\./);
  const pts = loadStored('kr-cpi-core');
  const before = JSON.stringify(pts);
  trendRef.computeTrendRef(pts, { windowYears: 10, exclusions: config.seasonalExclusionsFor('kr-cpi-core'), b: 0.81 });
  assert.equal(JSON.stringify(pts), before);
});

test('조회 페이지 — 참고값 라벨, 자동 입력 경로 없음', () => {
  const src = readFileSync(new URL('../js/forecast-ui.js', import.meta.url), 'utf8');
  assert.match(src, /참고값 — 자동 적용되지 않음\. override는 직접 입력/);
  assert.match(src, /computeTrendRef\(/);
  // 제안값이 override 저장소로 흘러가는 코드가 없어야 한다
  assert.doesNotMatch(src, /suggestion[^;\n]*(currentOverrides|overridesBySeries|save\()/);
});
