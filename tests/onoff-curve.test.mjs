// OO-커브 단면 계산 테스트 — node --test (자동탐색)
//
// [라이선스] 원본 민평 수익률(%)은 이 계보에 존재하지 않는다. js/onoff-curve.js 는 파생 상대금리(bp)만
// 다루므로 합성 fixture 로 대부분을 검증하고, 실데이터 회귀(7·8번)는 커밋 산출물
// data/onoff-bonds.js 를 읽어 확인한다(원본 재배포 아님). 산출물이 없으면 해당 케이스만 skip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  snapshot, series, segmentSlopes, allDates, residualMonths,
  WINDOW_MIN_M, WINDOW_MAX_M, MIN_FIT_BONDS,
} from '../js/onoff-curve.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- 합성 fixture 헬퍼 ---
// 한 일자짜리 데이터셋. maturity 는 'YYYY-MM', bp 는 그날의 상대금리.
// first 는 지표물 판정(계열별 최신)에 쓰이므로 명시적으로 준다.
const mk = (date, rows) => ({
  updated: date,
  anchorNote: 'fixture',
  anchorLog: [],
  bonds: rows.map(r => ({
    tag: r.tag, tenor: r.tenor, maturity: r.maturity, coupon: r.coupon ?? 3,
    first: r.first, last: date, series: [[date, r.bp]],
  })),
});

const D = '2026-06-15'; // 관측월 2026-06 → 잔존 = 만기월 − 2026-06

// 잔존 12/18/24/30개월 사다리. A·B·C 는 경과물, D3 가 3Y 지표물(first 최신).
//   x(년) 1.0 / 1.5 / 2.0 / 2.5,  bp 0 / 20 / 30 / 45
const LADDER = mk(D, [
  { tag: '24-4',  tenor: '3Y', maturity: '2027-06', bp: 0,  first: '2024-04-09' },
  { tag: '24-12', tenor: '3Y', maturity: '2027-12', bp: 20, first: '2024-10-15' },
  { tag: '25-4',  tenor: '3Y', maturity: '2028-06', bp: 30, first: '2025-05-13' },
  { tag: '25-10', tenor: '3Y', maturity: '2028-12', bp: 45, first: '2025-11-11' },
]);
const resOf = (snap, tag, method) => {
  const r = snap.residuals.find(z => z.tag === tag && z.method === method);
  return r ? r.value : undefined;
};

// ─────────────────────────────────────────────────────────────
test('1. 지표물 판정 — tenor 계열별 1개, first 가 가장 늦은 종목', () => {
  const ds = mk(D, [
    { tag: 'a2', tenor: '2Y', maturity: '2027-06', bp: 0,  first: '2025-01-02' },
    { tag: 'b2', tenor: '2Y', maturity: '2027-12', bp: 20, first: '2025-07-02' }, // 2Y 최신
    { tag: 'a3', tenor: '3Y', maturity: '2028-06', bp: 30, first: '2025-05-13' },
    { tag: 'b3', tenor: '3Y', maturity: '2028-12', bp: 45, first: '2025-11-11' }, // 3Y 최신
  ]);
  const snap = snapshot(ds, D);
  const on = snap.bonds.filter(b => b.isOnTheRun).map(b => b.tag).sort();
  assert.deepEqual(on, ['b2', 'b3']);
  assert.equal(snap.bonds.filter(b => b.isOnTheRun && b.tenor === '2Y').length, 1);
  assert.equal(snap.bonds.filter(b => b.isOnTheRun && b.tenor === '3Y').length, 1);
  // 만기 순서가 아니라 first 순서로 뽑는다 — 만기는 길지만 먼저 발행된 종목은 지표물이 아니다
  const ds2 = mk(D, [
    { tag: 'old_long', tenor: '3Y', maturity: '2029-06', bp: 60, first: '2024-01-02' },
    { tag: 'new_short', tenor: '3Y', maturity: '2028-06', bp: 30, first: '2026-01-02' },
    { tag: 'mid', tenor: '3Y', maturity: '2027-12', bp: 20, first: '2025-01-02' },
  ]);
  assert.deepEqual(snapshot(ds2, D).bonds.filter(b => b.isOnTheRun).map(b => b.tag), ['new_short']);
});

test('2. 잔존 창 필터 — 12개월 미만·36개월 초과는 inWindow=false, role=excluded', () => {
  const ds = mk(D, [
    { tag: 'short', tenor: '3Y', maturity: '2027-05', bp: -5, first: '2024-05-01' },  // 11M
    { tag: 'edgeLo', tenor: '3Y', maturity: '2027-06', bp: 0,  first: '2024-06-01' }, // 12M
    { tag: 'mid',   tenor: '3Y', maturity: '2027-12', bp: 20, first: '2024-12-01' },  // 18M
    { tag: 'edgeHi', tenor: '3Y', maturity: '2029-06', bp: 60, first: '2026-06-01' }, // 36M
    { tag: 'long',  tenor: '3Y', maturity: '2029-07', bp: 62, first: '2026-07-01' },  // 37M
  ]);
  const snap = snapshot(ds, D);
  const by = t => snap.bonds.find(b => b.tag === t);
  assert.equal(by('short').residualMonths, 11);
  assert.equal(by('short').inWindow, false);
  assert.equal(by('short').role, 'excluded');
  assert.equal(by('long').residualMonths, 37);
  assert.equal(by('long').inWindow, false);
  // 경계값은 포함
  assert.equal(by('edgeLo').residualMonths, WINDOW_MIN_M);
  assert.equal(by('edgeLo').inWindow, true);
  assert.equal(by('edgeHi').residualMonths, WINDOW_MAX_M);
  assert.equal(by('edgeHi').inWindow, true);
  // 창 밖 종목은 인접 기울기에도 들어가지 않는다
  const touched = new Set(snap.slopes.flatMap(s => [s.from, s.to]));
  assert.equal(touched.has('short'), false);
  assert.equal(touched.has('long'), false);
});

test('3. 국소보간 — 좌우 인접 2점 대비, 경계점은 null', () => {
  const snap = snapshot(LADDER, D);
  const fit = snap.bonds.filter(b => b.role === 'fit').map(b => b.tag);
  assert.deepEqual(fit, ['24-4', '24-12', '25-4']); // 25-10 은 지표물
  // 내부점 24-12: 24-4(x=1.0,bp=0) 와 25-4(x=2.0,bp=30) 의 x=1.5 보간 = 15 → 20 − 15 = +5
  assert.equal(resOf(snap, '24-12', 'localInterp'), 5);
  // 경계점은 보간 불가
  assert.equal(resOf(snap, '24-4', 'localInterp'), null);
  assert.equal(resOf(snap, '25-4', 'localInterp'), null);
});

test('4. 3Y 차분 — R, W, P 관계 (P = R − W)', () => {
  const snap = snapshot(LADDER, D);
  // 기울기(12~30M 경과물 A,B,C 1차 적합) = 30.0 bp/년, 준거 = 25-4(24M, first 최신 경과물 3Y)
  // R = (45 − 30) − 30.0 × 6/12 = 0
  assert.equal(snap.detail.on3.ref, '25-4');
  assert.equal(snap.detail.on3.slope, 30);
  assert.equal(snap.detail.on3.gapMonths, 6);
  assert.equal(resOf(snap, '25-10', 'pairAdjusted'), 0);
  // 위약: 대상 25-4(24M), 준거 24-12(18M), 기울기'(A,B) = 40 → (30 − 20) − 40 × 6/12 = −10
  assert.equal(snap.detail.placebo.tag, '25-4');
  assert.equal(snap.detail.placebo.ref, '24-12');
  assert.equal(snap.detail.placebo.slope, 40);
  assert.equal(resOf(snap, '25-4', 'placebo'), -10);
  // P = R − W
  const R = resOf(snap, '25-10', 'pairAdjusted');
  const W = resOf(snap, '25-4', 'placebo');
  const P = resOf(snap, '25-10', 'premium');
  assert.equal(P, 10);
  assert.equal(P, Math.round((R - W) * 100) / 100);
});

test('5. 구간 기울기 — 해당 구간에 인접쌍 없으면 null', () => {
  const snap = snapshot(LADDER, D);
  // 인접 중점 15 / 21 / 27 개월 → 30~36 구간에는 쌍이 없다
  assert.deepEqual(snap.slopes, [
    { from: '24-4', to: '24-12', bpPerYear: 40 },
    { from: '24-12', to: '25-4', bpPerYear: 20 },
    { from: '25-4', to: '25-10', bpPerYear: 30 },
  ]);
  assert.equal(snap.segments.m12_18, 40);
  assert.equal(snap.segments.m18_24, 20);
  assert.equal(snap.segments.m24_30, 30);
  assert.equal(snap.segments.m30_36, null);
  // 같은 구간에 쌍이 둘이면 평균
  const ds = mk(D, [
    { tag: 'p1', tenor: '3Y', maturity: '2027-06', bp: 0,  first: '2024-01-01' }, // 12M
    { tag: 'p2', tenor: '3Y', maturity: '2027-09', bp: 5,  first: '2024-02-01' }, // 15M  중점 13.5
    { tag: 'p3', tenor: '3Y', maturity: '2027-12', bp: 25, first: '2024-03-01' }, // 18M  중점 16.5
    { tag: 'p4', tenor: '3Y', maturity: '2028-06', bp: 40, first: '2024-04-01' }, // 24M
  ]);
  const s2 = snapshot(ds, D);
  // (5−0)/0.25 = 20, (25−5)/0.25 = 80 → 평균 50
  assert.equal(s2.segments.m12_18, 50);
});

test('6. 경과물 3종목 미만 — 계산 불가 처리 (예외 없이 빈 잔차)', () => {
  const ds = mk(D, [
    { tag: 'x1', tenor: '3Y', maturity: '2027-06', bp: 0,  first: '2024-01-01' },
    { tag: 'x2', tenor: '3Y', maturity: '2027-12', bp: 20, first: '2025-01-01' },
    { tag: 'x3', tenor: '3Y', maturity: '2028-06', bp: 30, first: '2026-01-01' }, // 지표물 → 경과물 2개
  ]);
  const snap = snapshot(ds, D);
  assert.equal(snap.bonds.filter(b => b.role === 'fit').length, 2);
  assert.ok(snap.bonds.filter(b => b.role === 'fit').length < MIN_FIT_BONDS);
  assert.deepEqual(snap.residuals, []);
  assert.equal(snap.detail.insufficientFit, true);
  assert.equal(snap.detail.fitCount, 2);
  // 종목이 아예 없는 일자도 던지지 않는다
  const empty = snapshot(ds, '1999-01-04');
  assert.deepEqual(empty.bonds, []);
  assert.deepEqual(empty.residuals, []);
  assert.equal(empty.fit.slope, null);
});

// --- 실데이터 회귀 (7·8) ---
const OUT = join(ROOT, 'data', 'onoff-bonds.js');
function loadReal() {
  if (!existsSync(OUT)) return null;
  const sandbox = { window: {} };
  runInNewContext(readFileSync(OUT, 'utf8'), sandbox);
  return sandbox.window.ONOFF_BONDS || null;
}

test('7. 2026-07-24 실데이터 회귀', t => {
  const ds = loadReal();
  if (!ds) return t.skip('data/onoff-bonds.js 없음 — tools/convert-onoff-bonds.mjs 실행 필요');
  const snap = snapshot(ds, '2026-07-24');
  // 지표물
  assert.equal(snap.detail.on2.tag, '26-1');
  assert.equal(snap.detail.on3.tag, '26-5');
  // 잔차
  assert.equal(resOf(snap, '26-1', 'localInterp'), 7.1);    // 2Y (내삽)
  assert.equal(resOf(snap, '26-5', 'pairAdjusted'), -10.45); // 3Y R
  assert.equal(resOf(snap, '25-10', 'placebo'), -8.94);      // 위약 W
  assert.equal(resOf(snap, '26-5', 'premium'), -1.51);       // 프리미엄 P
  // 인접 기울기
  assert.deepEqual(snap.slopes, [
    { from: '25-6', to: '24-12', bpPerYear: 17.6 },
    { from: '24-12', to: '26-1', bpPerYear: 71.6 },
    { from: '26-1', to: '25-4', bpPerYear: 14.8 },
    { from: '25-4', to: '25-10', bpPerYear: 18 },
    { from: '25-10', to: '26-5', bpPerYear: 9 },
  ]);
  assert.deepEqual(snap.segments, { m12_18: 17.6, m18_24: 43.2, m24_30: 18, m30_36: 9 });
  assert.equal(snap.fit.n, 4);
});

test('8. 지표물 창 밖 판정 회귀 — 2026-05-12 (26-5 잔존 37M)', t => {
  const ds = loadReal();
  if (!ds) return t.skip('data/onoff-bonds.js 없음 — tools/convert-onoff-bonds.mjs 실행 필요');
  const snap = snapshot(ds, '2026-05-12');
  const b265 = snap.bonds.find(b => b.tag === '26-5');
  const b2510 = snap.bonds.find(b => b.tag === '25-10');
  // 26-5 는 지표물이지만 창 밖 → excluded
  assert.equal(b265.residualMonths, 37);
  assert.equal(b265.isOnTheRun, true);
  assert.equal(b265.inWindow, false);
  assert.equal(b265.role, 'excluded');
  // 25-10 은 더 이상 지표물이 아니다
  assert.equal(b2510.isOnTheRun, false);
  assert.equal(b2510.role, 'fit');
  // 3Y 계열 R/W/P 없음
  assert.equal(snap.residuals.some(r => r.method === 'pairAdjusted'), false);
  assert.equal(snap.residuals.some(r => r.method === 'placebo'), false);
  assert.equal(snap.residuals.some(r => r.method === 'premium'), false);
  assert.equal(snap.detail.on3, undefined);
  // 2Y 지표물은 창 안이므로 잔차가 살아 있다
  assert.equal(snap.detail.on2.tag, '26-1');
  assert.equal(typeof resOf(snap, '26-1', 'localInterp'), 'number');
});

// --- 시계열 함수 ---
test('9. series / segmentSlopes / allDates 기본 형태', t => {
  const ds = loadReal();
  if (!ds) return t.skip('data/onoff-bonds.js 없음');
  const dates = allDates(ds);
  assert.ok(dates.length > 0);
  assert.deepEqual(dates, [...dates].sort());
  const ser = series(ds, '26-5', '2026-05-01', '2026-08-07');
  assert.ok(ser.length > 0);
  for (const r of ser) {
    assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof r.residualMonths, 'number');
    assert.ok(['excluded', 'fit', 'onTheRun'].includes(r.role));
  }
  // 창 밖 구간은 잔차 없음, 창 진입 후 3Y 지표물은 premium
  assert.equal(ser[0].role, 'excluded');
  assert.equal(ser[0].residual, null);
  const last = ser[ser.length - 1];
  assert.equal(last.role, 'onTheRun');
  assert.equal(last.method, 'premium');
  const seg = segmentSlopes(ds, '2026-07-01', '2026-07-31');
  assert.ok(seg.length > 0);
  for (const r of seg) assert.deepEqual(Object.keys(r), ['date', 'm12_18', 'm18_24', 'm24_30', 'm30_36']);
  assert.equal(residualMonths('2029-06', '2026-06-15'), 36);
});
