// 확산지수 계산코어 앵커 테스트 — node --test (자동탐색, 인자 없이 실행).
// Fenrir calculator.test.ts 이식본. diffusion-core.mjs가 원본과 동일하게 거동하는지
// 검증 → 이중 구현 드리프트 방지 게이트(키 불필요).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeDiffusion, computeZScores, buildRecord, Z_MIN_HISTORY, US_THRESHOLD_OPTS,
} from '../scripts/lib/diffusion-core.mjs';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);

function snap(items, extras = {}) {
  return {
    country: 'US-CPI', period: '2026-03', headline_yoy: 3.0, core_yoy: 2.5,
    items, source_url: 'test', fetched_at: '2026-05-03T00:00:00.000Z', ...extras,
  };
}
const diffusionWithGe2 = (v) => ({
  weighted: { ge0: 50, ge2: v, ge25: 30, ge3: 25 },
  unweighted: { ge0: 50, ge2: v, ge25: 30, ge3: 25 },
});

test('computeDiffusion: 가중+비가중 3-item', () => {
  const r = computeDiffusion(snap([
    { code: 'A', name: 'A', weight: 50, yoy: 3.0 },
    { code: 'B', name: 'B', weight: 30, yoy: 1.0 },
    { code: 'C', name: 'C', weight: 20, yoy: -1.0 },
  ]));
  near(r.weighted.ge0, 80); near(r.weighted.ge2, 50);
  near(r.weighted.ge25, 50); near(r.weighted.ge3, 50);
  near(r.unweighted.ge0, 200 / 3); near(r.unweighted.ge2, 100 / 3);
});

test('computeDiffusion: ge2.5 경계 포함 (yoy=2.5 → ≥2.5)', () => {
  const r = computeDiffusion(snap([{ code: 'X', name: 'X', weight: 100, yoy: 2.5 }]));
  near(r.weighted.ge25, 100); near(r.weighted.ge3, 0);
});

test('computeDiffusion: weight=null은 가중 제외·비가중 포함', () => {
  const r = computeDiffusion(snap([
    { code: 'A', name: 'A', weight: 50, yoy: 3.0 },
    { code: 'B', name: 'B', weight: null, yoy: 3.0 },
    { code: 'C', name: 'C', weight: 50, yoy: -1.0 },
  ]));
  near(r.weighted.ge2, 50); near(r.unweighted.ge2, 200 / 3);
});

test('computeDiffusion: yoy=null은 양쪽 제외', () => {
  const r = computeDiffusion(snap([
    { code: 'A', name: 'A', weight: 50, yoy: 3.0 },
    { code: 'B', name: 'B', weight: 30, yoy: null },
    { code: 'C', name: 'C', weight: 20, yoy: 1.0 },
  ]));
  near(r.weighted.ge0, 100); near(r.weighted.ge2, (50 / 70) * 100);
  near(r.unweighted.ge0, 100); near(r.unweighted.ge2, 50);
});

test('computeDiffusion: 전부 yoy=null → 전부 0', () => {
  const r = computeDiffusion(snap([
    { code: 'A', name: 'A', weight: 50, yoy: null },
    { code: 'B', name: 'B', weight: 50, yoy: null },
  ]));
  assert.equal(r.weighted.ge0, 0); assert.equal(r.weighted.ge2, 0);
  assert.equal(r.unweighted.ge0, 0); assert.equal(r.unweighted.ge2, 0);
});

test('computeDiffusion: ge0 ≥ ge2 ≥ ge25 ≥ ge3 단조', () => {
  const r = computeDiffusion(snap([
    { code: 'A', name: 'A', weight: 25, yoy: 4.0 },
    { code: 'B', name: 'B', weight: 25, yoy: 2.7 },
    { code: 'C', name: 'C', weight: 25, yoy: 2.1 },
    { code: 'D', name: 'D', weight: 25, yoy: 0.5 },
  ]));
  assert.ok(r.weighted.ge0 >= r.weighted.ge2);
  assert.ok(r.weighted.ge2 >= r.weighted.ge25);
  assert.ok(r.weighted.ge25 >= r.weighted.ge3);
  assert.ok(r.unweighted.ge0 >= r.unweighted.ge2);
});

test('computeZScores: warmup(history<12) → 0', () => {
  const history = Array.from({ length: Z_MIN_HISTORY - 1 }, () => diffusionWithGe2(50));
  assert.equal(computeZScores(diffusionWithGe2(50), history).weighted.ge2, 0);
});

test('computeZScores: 분산 있으면 current>mean → z>0', () => {
  const history = [];
  for (let i = 0; i < 60; i++) history.push(diffusionWithGe2(40 + (i % 21)));
  assert.ok(computeZScores(diffusionWithGe2(70), history).weighted.ge2 > 0);
});

test('computeZScores: std=0(상수) → 0', () => {
  const history = Array.from({ length: 60 }, () => diffusionWithGe2(50));
  assert.equal(computeZScores(diffusionWithGe2(70), history).weighted.ge2, 0);
});

test('computeZScores: 12개월 정확계산 z=(cur-μ)/σ', () => {
  const series = [40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62];
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const std = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length);
  const history = series.map((v) => diffusionWithGe2(v));
  near(computeZScores(diffusionWithGe2(51), history).weighted.ge2, (51 - mean) / std);
});

test('buildRecord: end-to-end, 빈 history → z=0·메타 보존', () => {
  const rec = buildRecord(snap([
    { code: 'A', name: 'A', weight: 60, yoy: 3.5 },
    { code: 'B', name: 'B', weight: 40, yoy: 1.5 },
  ], { country: 'KR', period: '2026-04', core_yoy_intl: 2.1 }), []);
  assert.ok(rec);
  assert.equal(rec.country, 'KR');
  assert.equal(rec.period, '2026-04');
  assert.equal(rec.core_yoy_intl, 2.1);
  assert.equal(rec.weight_coverage, 1);
  near(rec.diffusion.weighted.ge2, 60);
  assert.equal(rec.z_scores_5y.weighted.ge2, 0);
  assert.equal(rec.item_count, 2);
});

test('buildRecord: weight_coverage는 양수 가중치 비율', () => {
  const rec = buildRecord(snap([
    { code: 'A', name: 'A', weight: 50, yoy: 3.0 },
    { code: 'B', name: 'B', weight: null, yoy: 1.0 },
    { code: 'C', name: 'C', weight: 0, yoy: 1.0 },
    { code: 'D', name: 'D', weight: 50, yoy: 2.0 },
  ]), []);
  assert.ok(rec);
  near(rec.weight_coverage, 0.5);
});

test('buildRecord: core_yoy_intl 누락 시 null 보존', () => {
  const s = snap([{ code: 'A', name: 'A', weight: 100, yoy: 2.0 }]);
  delete s.core_yoy_intl;
  const rec = buildRecord(s, []);
  assert.ok(rec);
  assert.equal(rec.core_yoy_intl, null);
});

test('buildRecord: flash(유효 yoy<20%) → null', () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    code: 'C' + i, name: 'c', weight: 1, yoy: i < 10 ? 2.0 : null,
  }));
  assert.equal(buildRecord(snap(items), []), null);
});

// ── ex_energy 재정규화 앵커 (Fenrir calculator.test.ts 이식) ──
// US-CPI 제외 코드(diffusion-exclusions.mjs): SETB01=Gasoline(direct), SETG01=Airline(spillover).

test('ex_energy: 제외 품목만 2% 초과 → ge2=0, ge0=100', () => {
  const r = computeDiffusion(snap([
    { code: 'SETB01', name: 'Gasoline', weight: 30, yoy: 5.0 }, // 제외·초과
    { code: 'A', name: 'A', weight: 40, yoy: 1.0 },             // 비제외·미달
    { code: 'B', name: 'B', weight: 30, yoy: 0.5 },             // 비제외·미달
  ]));
  near(r.weighted.ge2, 30);            // 전체 가중은 별개 유지
  near(r.ex_energy.weighted.ge2, 0);
  near(r.ex_energy.weighted.ge0, 100); // 비제외 A,B 모두 ≥0
});

test('ex_energy: 전 품목 2% 초과 → ge2=100', () => {
  const r = computeDiffusion(snap([
    { code: 'SETB01', name: 'Gasoline', weight: 30, yoy: 5.0 },      // 제외
    { code: 'SETG01', name: 'Airline fares', weight: 10, yoy: 4.0 }, // 제외
    { code: 'A', name: 'A', weight: 40, yoy: 3.0 },                  // 비제외·초과
    { code: 'B', name: 'B', weight: 20, yoy: 2.0 },                  // 비제외·경계
  ]));
  near(r.ex_energy.weighted.ge2, 100);
  near(r.ex_energy.weighted.ge0, 100);
});

test('ex_energy: 재정규화 분모 = 비제외 가중 합', () => {
  const r = computeDiffusion(snap([
    { code: 'SETB01', name: 'Gasoline', weight: 50, yoy: 10.0 }, // 제외 (거대 가중)
    { code: 'A', name: 'A', weight: 30, yoy: 3.0 },              // 비제외·초과
    { code: 'B', name: 'B', weight: 20, yoy: 1.0 },              // 비제외·미달
  ]));
  near(r.weighted.ge2, 80);          // 에너지 포함 분모 100 → (50+30)/100
  near(r.ex_energy.weighted.ge2, 60); // 분모 50, 분자 A(30) → 60
});

test('ex_energy: yoy=null·weight=null 비제외는 분모에서 제외', () => {
  const r = computeDiffusion(snap([
    { code: 'SETB01', name: 'Gasoline', weight: 50, yoy: 9.0 }, // 제외
    { code: 'A', name: 'A', weight: 30, yoy: 3.0 },             // 계수
    { code: 'B', name: 'B', weight: null, yoy: 3.0 },           // weight=null → 제외
    { code: 'C', name: 'C', weight: 20, yoy: null },            // yoy=null → 제외
  ]));
  near(r.ex_energy.weighted.ge2, 100); // 분모=A(30)만, 분자=A(30)
});

test('ex_energy: 비제외 전멸 → 분모 0 → 0', () => {
  const r = computeDiffusion(snap([
    { code: 'SETB01', name: 'Gasoline', weight: 60, yoy: 5.0 },
    { code: 'SEHF01', name: 'Electricity', weight: 40, yoy: 4.0 },
  ]));
  near(r.ex_energy.weighted.ge2, 0);
  near(r.ex_energy.weighted.ge0, 0);
});

// ── 임계값 매개변수화 (US 토글, 2026-09-16) ──
const US_MIX = [
  { code: 'SETB01', name: 'Gasoline', weight: 20, yoy: 6.0 },      // 제외
  { code: 'SETG01', name: 'Airline fares', weight: 5, yoy: 3.2 },  // 제외
  { code: 'A', name: 'A', weight: 15, yoy: 4.1 },
  { code: 'B', name: 'B', weight: 20, yoy: 3.5 },                  // 3.5 경계
  { code: 'C', name: 'C', weight: 10, yoy: 3.0 },                  // 3 경계
  { code: 'D', name: 'D', weight: 10, yoy: 2.5 },                  // 2.5 경계
  { code: 'E', name: 'E', weight: 10, yoy: 2.0 },                  // 2 경계
  { code: 'F', name: 'F', weight: 10, yoy: -0.4 },
];

test('opts 미지정: 출력 키·순서 원본 동일 (타국 zero-diff)', () => {
  const r = computeDiffusion(snap(US_MIX));
  assert.deepEqual(Object.keys(r.weighted), ['ge0', 'ge2', 'ge25', 'ge3']);
  assert.deepEqual(Object.keys(r.unweighted), ['ge0', 'ge2', 'ge25', 'ge3']);
  assert.deepEqual(Object.keys(r.ex_energy.weighted), ['ge0', 'ge2']);
});

test('US opts: 기존 키 값 불변 + ge3_5·ex_energy 확장 키 추가', () => {
  const base = computeDiffusion(snap(US_MIX));
  const ext = computeDiffusion(snap(US_MIX), US_THRESHOLD_OPTS);
  for (const k of ['ge0', 'ge2', 'ge25', 'ge3']) {
    assert.equal(ext.weighted[k], base.weighted[k]);
    assert.equal(ext.unweighted[k], base.unweighted[k]);
  }
  assert.equal(ext.ex_energy.weighted.ge0, base.ex_energy.weighted.ge0);
  assert.equal(ext.ex_energy.weighted.ge2, base.ex_energy.weighted.ge2);
  assert.deepEqual(Object.keys(ext.weighted), ['ge0', 'ge2', 'ge25', 'ge3', 'ge3_5']);
  assert.deepEqual(Object.keys(ext.ex_energy.weighted), ['ge0', 'ge2', 'ge25', 'ge3', 'ge3_5']);
  // 값 앵커: 전체 가중 ≥3.5 = SETB01(20)+A(15)+B(20) = 55 / 100
  near(ext.weighted.ge3_5, 55);
  // ex_energy 분모 75(비제외), ≥3 = A+B+C = 45 → 60, ≥3.5 = A+B = 35 → 46.67
  near(ext.ex_energy.weighted.ge3, 60);
  near(ext.ex_energy.weighted.ge3_5, (35 / 75) * 100);
});

test('US opts: 임계값 단조성 ge2 ≥ ge25 ≥ ge3 ≥ ge3_5 (전체·비가중·ex-energy)', () => {
  const r = computeDiffusion(snap(US_MIX), US_THRESHOLD_OPTS);
  for (const s of [r.weighted, r.unweighted, r.ex_energy.weighted]) {
    assert.ok(s.ge2 >= s.ge25 && s.ge25 >= s.ge3 && s.ge3 >= s.ge3_5, JSON.stringify(s));
  }
});

test('US opts: z-score ge3_5도 동일 누적 history로 계산, ge2 z 불변', () => {
  const hist = [];
  const histExt = [];
  for (let t = 0; t < 30; t++) {
    const items = US_MIX.map((it, i) => ({ ...it, yoy: it.yoy + Math.sin(t * 0.7 + i) }));
    const base = buildRecord(snap(items), hist);
    const ext = buildRecord(snap(items), histExt, US_THRESHOLD_OPTS);
    assert.equal(ext.z_scores_5y.weighted.ge2, base.z_scores_5y.weighted.ge2);
    assert.equal(typeof ext.z_scores_5y.weighted.ge3_5, 'number');
    assert.ok(!('ge3_5' in base.z_scores_5y.weighted));
    hist.push(base.diffusion); histExt.push(ext.diffusion);
  }
  const series = histExt.slice(0, -1).map((d) => d.weighted.ge3_5);
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  const std = Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length);
  const last = histExt.at(-1).weighted.ge3_5;
  near(computeZScores(histExt.at(-1), histExt.slice(0, -1)).weighted.ge3_5, (last - mean) / std);
});

test('ex_energy: 제외 테이블 없는 국가(KR)는 전체 가중과 동일(퇴화)', () => {
  const r = computeDiffusion(snap([
    { code: 'SETB01', name: '(KR 코드 아님)', weight: 60, yoy: 3.0 },
    { code: 'B', name: 'B', weight: 40, yoy: 1.0 },
  ], { country: 'KR' }));
  near(r.ex_energy.weighted.ge2, r.weighted.ge2);
  near(r.ex_energy.weighted.ge0, r.weighted.ge0);
  near(r.ex_energy.weighted.ge2, 60);
});
