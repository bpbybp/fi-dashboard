// st1-curve 단위 테스트 — node --test (인자 없이 자동탐색).
//
// 초점 셋:
//  ① 좌표의 기준일이 **row.date** 인가 (오늘 기준이면 점이 통째로 밀려 선이 왜곡된다)
//  ② 계보가 kind 로 먼저 갈리는가 (예담이 회사채 A1 에 섞이면 적합선이 오염된다)
//  ③ 가중치가 실제로 오래된 점의 영향을 줄이는가 (안 줄면 반감기 컨트롤이 장식이다)
// 셋 다 "틀려도 화면은 멀쩡해 보이는" 종류라 여기서 못 박는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  residualDays, seriesKey, weekAge, fitLog, residualBp, buildSeries,
  SERIES_ORDER, MIN_FIT_POINTS, DEFAULT_HALF_LIFE_WEEKS, DEFAULT_MAX_WEEKS,
} from '../js/st1-curve.js';

const REF = '2026-09-01';
const near = (got, want, tol, msg) =>
  assert.ok(Math.abs(got - want) < tol, `${msg ?? ''} — got ${got}, want ≈${want} (±${tol})`);

/** 최소 행 — 필요한 필드만 채운다(파서 스키마의 부분집합이면 충분하다). */
const row = (over = {}) => ({
  date: REF, issuer: 'OO', kind: 'CP', grade: 'A1',
  maturity_ym: null, maturity_date: null, rate: 3.5, ...over,
});

// ── ① 잔존일수: 기준일은 row.date ───────────────────────────────────────

test('잔존일수는 row.date 기준이다 — 오늘 기준이면 여기서 깨진다', () => {
  // 2026-01-15 에 적은 2026-04-15 만기 호가 = 그날 기준 90일물.
  // 오늘(2026 년 하반기) 기준으로 재면 이미 만기가 지나 null 이 된다.
  const r = row({ date: '2026-01-15', maturity_date: '2026-04-15' });
  assert.equal(residualDays(r), 90, '기록 시점(1/15) 기준 90일이어야 한다');

  // 같은 종목을 두 날에 적었다면 좌표도 달라야 한다. 오늘 기준이면 둘이 같아진다.
  const early = row({ date: '2026-06-01', maturity_date: '2026-08-30' });
  const later = row({ date: '2026-07-01', maturity_date: '2026-08-30' });
  assert.equal(residualDays(early), 90);
  assert.equal(residualDays(later), 60);
  assert.notEqual(residualDays(early), residualDays(later), '두 기록이 같은 좌표에 겹쳤다');
});

test('maturity_ym 만 있으면 그 달 15일로 근사한다', () => {
  // 2026-08-01 → 2026-09-15 = 45일
  assert.equal(residualDays(row({ date: '2026-08-01', maturity_ym: '2026-09' })), 45);
  // 2026-08-15 → 2027-08-15 = 365일
  assert.equal(residualDays(row({ date: '2026-08-15', maturity_ym: '2027-08' })), 365);
});

test('정확만기가 있으면 15일 근사보다 우선한다', () => {
  const r = row({ date: '2026-08-01', maturity_ym: '2026-09', maturity_date: '2026-09-30' });
  assert.equal(residualDays(r), 60, '연-월 근사(45일)가 아니라 정확일자(60일)여야 한다');
});

test('만기가 지났거나 당일이면 null', () => {
  assert.equal(residualDays(row({ date: '2026-08-01', maturity_date: '2026-07-01' })), null, '과거 만기');
  assert.equal(residualDays(row({ date: '2026-08-01', maturity_date: '2026-08-01' })), null, '당일 만기');
  assert.equal(residualDays(row({ date: '2026-09-20', maturity_ym: '2026-09' })), null, '15일 근사가 기준일보다 앞');
});

test('날짜를 못 읽으면 null (원장 행은 남고 좌표만 안 생긴다)', () => {
  assert.equal(residualDays(row({ maturity_ym: null, maturity_date: null })), null);
  assert.equal(residualDays(row({ date: null, maturity_ym: '2027-03' })), null);
  assert.equal(residualDays(row({ date: 'bad', maturity_ym: '2027-03' })), null);
  assert.equal(residualDays(null), null);
});

// ── ② 계보 ──────────────────────────────────────────────────────────────

test('예담은 등급이 A1 이어도 CP-A1 에 섞이지 않는다', () => {
  assert.equal(seriesKey(row({ kind: '예담', grade: 'A1' })), '예담', '실질 크레딧이 은행인 예담이 회사채 A1 곡선에 올라탔다');
  assert.equal(seriesKey(row({ kind: '예담', grade: 'A2' })), '예담');
  assert.equal(seriesKey(row({ kind: '예담', grade: null })), '예담', '등급 무관');
});

test('A2 계열(A2+/A2/A2-)은 한 계보로 묶인다', () => {
  for (const g of ['A2+', 'A2', 'A2-']) {
    assert.equal(seriesKey(row({ kind: 'CP', grade: g })), 'CP-A2', `${g} 가 CP-A2 로 안 묶였다`);
  }
  assert.equal(seriesKey(row({ kind: 'CP', grade: 'a2+' })), 'CP-A2', '소문자 표기도 같은 계보');
});

test('그 밖은 전부 OTHER', () => {
  assert.equal(seriesKey(row({ kind: 'CP', grade: 'A3' })), 'OTHER');
  assert.equal(seriesKey(row({ kind: 'CP', grade: null })), 'OTHER', '등급 없는 CP');
  assert.equal(seriesKey(row({ kind: '전단채', grade: 'A1' })), 'OTHER');
  assert.equal(seriesKey(row({ kind: 'ABSTB', grade: 'A1' })), 'OTHER');
  assert.equal(seriesKey(row({ kind: null, grade: 'A1' })), 'OTHER');
  assert.equal(seriesKey(null), 'OTHER');
});

test('CP-A1 은 CP + A1 일 때만', () => {
  assert.equal(seriesKey(row({ kind: 'CP', grade: 'A1' })), 'CP-A1');
  assert.equal(seriesKey(row({ kind: 'CP', grade: 'a1' })), 'CP-A1');
});

test('SERIES_ORDER 는 seriesKey 가 낼 수 있는 값을 모두 덮는다', () => {
  const produced = new Set([
    seriesKey(row({ kind: '예담' })),
    seriesKey(row({ kind: 'CP', grade: 'A1' })),
    seriesKey(row({ kind: 'CP', grade: 'A2' })),
    seriesKey(row({ kind: '전단채' })),
  ]);
  for (const k of produced) assert.ok(SERIES_ORDER.includes(k), `SERIES_ORDER 에 ${k} 가 없다`);
});

// ── 경과 주수 ────────────────────────────────────────────────────────────

test('경과 주수 — 내림, 0 = 당주', () => {
  assert.equal(weekAge(row({ date: REF }), REF), 0, '당일');
  assert.equal(weekAge(row({ date: '2026-08-26' }), REF), 0, '6일 전은 아직 0주');
  assert.equal(weekAge(row({ date: '2026-08-25' }), REF), 1, '7일 전이면 1주');
  assert.equal(weekAge(row({ date: '2026-07-07' }), REF), 8, '56일 전 = 8주');
  assert.equal(weekAge(row({ date: '2026-06-23' }), REF), 10, '70일 전 = 10주');
});

test('경과 주수 — 미래 일자는 0 으로 접는다', () => {
  // 음수를 그대로 두면 0.5**음수 > 1 이라 미래 호가가 오늘 호가보다 무거워진다.
  assert.equal(weekAge(row({ date: '2026-09-20' }), REF), 0);
});

test('경과 주수 — 날짜를 못 읽으면 null', () => {
  assert.equal(weekAge(row({ date: 'bad' }), REF), null);
  assert.equal(weekAge(row(), 'bad'), null);
  assert.equal(weekAge(null, REF), null);
});

// ── ③ 적합 ──────────────────────────────────────────────────────────────

test('유효점 3개 미만이면 선을 만들지 않는다', () => {
  const two = [{ tau: 30, rate: 3.0 }, { tau: 90, rate: 3.2 }];
  const f = fitLog(two);
  assert.equal(f.ok, false);
  assert.equal(f.n, 2);
  assert.equal(f.predict, undefined, 'ok:false 면 predict 를 주면 안 된다');

  assert.equal(fitLog([]).ok, false);
  assert.equal(fitLog(null).ok, false);
  assert.equal(fitLog([{ tau: 30, rate: 3.0 }]).n, 0 + 1);
  assert.equal(MIN_FIT_POINTS, 3);
});

test('좌표를 못 만드는 점은 유효점에서 빠진다', () => {
  const pts = [
    { tau: 30, rate: 3.0 }, { tau: 90, rate: 3.2 }, { tau: 180, rate: 3.4 },
    { tau: 0, rate: 3.5 },        // ln 불가
    { tau: -10, rate: 3.5 },      // 만기 지남
    { tau: 60, rate: null },      // 금리 없음
    null,
  ];
  assert.equal(fitLog(pts).n, 3, '무효 점이 n 에 섞였다');
});

test('완전 선형(로그축) 데이터에서 계수를 복원한다', () => {
  // r = 3.00 + 0.25·ln(τ) 위의 점 4개.
  const A = 3.0, B = 0.25;
  const taus = [1, Math.E, Math.E ** 2, Math.E ** 3];
  const f = fitLog(taus.map((tau) => ({ tau, rate: A + B * Math.log(tau) })), { halfLifeWeeks: null });

  assert.equal(f.ok, true);
  assert.equal(f.n, 4);
  near(f.a, A, 1e-9, 'a');
  near(f.b, B, 1e-9, 'b');
  near(f.sigma, 0, 1e-9, '완전 적합이면 σ 는 0');
  near(f.predict(Math.E ** 4), A + B * 4, 1e-9, 'predict 가 모델과 어긋난다');
});

test('predict 는 τ ≤ 0 에서 null (선을 억지로 늘리지 않는다)', () => {
  const f = fitLog([{ tau: 30, rate: 3.0 }, { tau: 90, rate: 3.2 }, { tau: 180, rate: 3.4 }]);
  assert.equal(f.ok, true);
  assert.equal(f.predict(0), null);
  assert.equal(f.predict(-5), null);
  assert.equal(f.predict('nope'), null);
});

test('잔존일수가 한 점에 몰리면 점이 많아도 선을 만들지 않는다', () => {
  // 같은 만기 같은 날 호가만 4건 — 기울기가 정의되지 않는다(수직선).
  const f = fitLog([90, 90, 90, 90].map((tau, i) => ({ tau, rate: 3.0 + i * 0.01 })));
  assert.equal(f.ok, false, '수직선에 선을 그었다');
  assert.equal(f.n, 4, 'n 은 유효점 수 그대로여야 한다');
});

test('가중치가 오래된 점의 영향을 줄인다', () => {
  // 당주 점 3개는 3.00% 평탄. 8주 전 이상치 하나가 4.00% 로 튄다.
  const clean = [30, 90, 180].map((tau) => ({ tau, rate: 3.0, weekAge: 0 }));
  const stale = { tau: 90, rate: 4.0, weekAge: 8 };
  const pts = [...clean, stale];

  const flat = fitLog(pts, { halfLifeWeeks: null });   // 가중없음
  const decay = fitLog(pts, { halfLifeWeeks: 1 });      // 반감기 1주 → 8주 전 가중 = 0.5**8

  assert.equal(flat.ok, true);
  assert.equal(decay.ok, true);
  assert.ok(flat.predict(90) > decay.predict(90), '가중을 걸어도 이상치가 그대로 끌어올렸다');
  near(decay.predict(90), 3.0, 0.02, '반감기 1주에서 8주 전 점이 거의 그대로 실렸다');
  assert.ok(flat.predict(90) > 3.1, '가중없음이면 이상치가 선을 끌어올려야 한다');
});

test('반감기 기본값은 2주이고 weight 명시가 이를 이긴다', () => {
  const pts = [
    { tau: 30, rate: 3.0, weekAge: 0 },
    { tau: 90, rate: 3.0, weekAge: 0 },
    { tau: 180, rate: 3.0, weekAge: 0 },
    { tau: 90, rate: 4.0, weekAge: 8, weight: 1 }, // 나이는 많지만 가중치를 직접 지정
  ];
  assert.equal(DEFAULT_HALF_LIFE_WEEKS, 2);
  const withDefault = fitLog(pts);
  const noAgeWeight = fitLog(pts.map((p) => ({ ...p, weight: 1 })));
  near(withDefault.predict(90), noAgeWeight.predict(90), 1e-9,
    '명시 weight 가 있는데 weekAge 감쇠가 덧씌워졌다');
});

test('σ 는 가중치 절대 크기에 끌려가지 않는다 (상대값이다)', () => {
  const base = [{ tau: 30, rate: 3.0 }, { tau: 90, rate: 3.3 }, { tau: 180, rate: 3.4 }];
  const a = fitLog(base.map((p) => ({ ...p, weight: 1 })));
  const b = fitLog(base.map((p) => ({ ...p, weight: 1000 })));
  near(b.sigma, a.sigma, 1e-9, '가중치를 1000배 했더니 σ 가 움직였다');
  assert.ok(a.sigma > 0, '완전 적합이 아니면 σ 는 양수');
});

// ── 잔차 ─────────────────────────────────────────────────────────────────

const flatFit = () => fitLog(
  [30, 90, 180].map((tau) => ({ tau, rate: 3.0 })), { halfLifeWeeks: null },
); // r = 3.00 평탄 (b = 0)

test('잔차 부호 — 실제가 적합보다 높으면 양수', () => {
  const fit = flatFit();
  // 2026-06-01 → 2026-08-30 = 90일
  const above = row({ date: '2026-06-01', maturity_date: '2026-08-30', rate: 3.10 });
  const below = row({ date: '2026-06-01', maturity_date: '2026-08-30', rate: 2.85 });
  const on = row({ date: '2026-06-01', maturity_date: '2026-08-30', rate: 3.00 });

  near(residualBp(above, fit), 10, 1e-6, '+10bp');
  near(residualBp(below, fit), -15, 1e-6, '−15bp');
  near(residualBp(on, fit), 0, 1e-6);
});

test('잔차 — 적합선이 없으면 null', () => {
  const noFit = fitLog([{ tau: 30, rate: 3.0 }]);
  assert.equal(noFit.ok, false);
  assert.equal(residualBp(row({ maturity_ym: '2027-03' }), noFit), null);
  assert.equal(residualBp(row({ maturity_ym: '2027-03' }), null), null);
});

test('잔차 — 좌표를 못 만들면 null', () => {
  const fit = flatFit();
  assert.equal(residualBp(row({ maturity_ym: null }), fit), null, '만기 없음');
  assert.equal(residualBp(row({ date: '2026-08-01', maturity_date: '2026-07-01' }), fit), null, '만기 지남');
  assert.equal(residualBp(row({ maturity_ym: '2027-03', rate: null }), fit), null, '금리 없음');
  assert.equal(residualBp(null, fit), null);
});

// ── buildSeries ──────────────────────────────────────────────────────────

/** 계보 3개 × 잔존일수 3개, 전부 당주. */
const ledger = () => [
  ...[['2026-09-15', 3.30], ['2026-11-15', 3.40], ['2027-03-15', 3.55]]
    .map(([m, rate]) => row({ kind: 'CP', grade: 'A1', maturity_date: m, rate })),
  ...[['2026-09-15', 3.60], ['2026-11-15', 3.75], ['2027-03-15', 3.95]]
    .map(([m, rate]) => row({ kind: 'CP', grade: 'A2+', maturity_date: m, rate })),
  ...[['2026-09-15', 3.10], ['2026-11-15', 3.18], ['2027-03-15', 3.30]]
    .map(([m, rate]) => row({ kind: '예담', grade: 'A1', maturity_date: m, rate })),
];

test('계보별로 갈라 각각 적합한다', () => {
  const s = buildSeries(ledger(), { refDate: REF });
  assert.deepEqual(Object.keys(s).sort(), ['CP-A1', 'CP-A2', '예담'].sort());
  for (const k of Object.keys(s)) {
    assert.equal(s[k].points.length, 3, `${k} 점 개수`);
    assert.equal(s[k].fit.ok, true, `${k} 적합 실패`);
  }
  // 예담이 CP-A1 에 섞였다면 A1 곡선이 3.10~3.55 를 모두 지나느라 눕는다.
  assert.equal(s['CP-A1'].fit.n, 3, '예담이 CP-A1 곡선에 섞였다');
});

test('점이 없는 계보는 결과에 담기지 않는다', () => {
  const s = buildSeries(ledger(), { refDate: REF });
  assert.equal(s.OTHER, undefined);
  assert.deepEqual(Object.keys(buildSeries([], { refDate: REF })), []);
  assert.deepEqual(Object.keys(buildSeries(null, { refDate: REF })), []);
});

test('maxWeeks 초과 행은 제외한다', () => {
  const fresh = row({ date: REF, maturity_date: '2026-11-15', rate: 3.40 });
  const old = row({ date: '2026-06-23', maturity_date: '2026-11-15', rate: 3.90 }); // 10주 전
  const rows = [...ledger(), old];

  assert.equal(DEFAULT_MAX_WEEKS, 8);
  const dflt = buildSeries(rows, { refDate: REF });
  assert.equal(dflt['CP-A1'].points.length, 3, '10주 전 행이 기본 8주 창에 들어왔다');

  const wide = buildSeries(rows, { refDate: REF, maxWeeks: null });
  assert.equal(wide['CP-A1'].points.length, 4, 'maxWeeks null 이면 전체 기간이어야 한다');

  const narrow = buildSeries([...ledger(), fresh], { refDate: REF, maxWeeks: 4 });
  assert.equal(narrow['CP-A1'].points.length, 4, '당주 행이 4주 창에서 빠졌다');
});

test('경계 — 정확히 maxWeeks 주 된 행은 남는다', () => {
  const at8 = row({ date: '2026-07-07', maturity_date: '2026-11-15', rate: 3.40 }); // 8주 전
  const s = buildSeries([...ledger(), at8], { refDate: REF, maxWeeks: 8 });
  assert.equal(s['CP-A1'].points.length, 4, '경계값을 초과로 봤다');
});

test('좌표를 못 만드는 행은 조용히 빠진다 (원장에는 남는다)', () => {
  const rows = [
    ...ledger(),
    row({ maturity_ym: null, maturity_date: null }),                  // 만기 없음
    row({ maturity_date: '2026-08-01' }),                             // 만기 지남
    row({ maturity_date: '2026-11-15', rate: null }),                 // 금리 없음
  ];
  const s = buildSeries(rows, { refDate: REF });
  assert.equal(s['CP-A1'].points.length, 3);
});

test('점에는 좌표·나이·가중치와 원본 행이 함께 실린다 (툴팁·잔차용)', () => {
  const s = buildSeries(ledger(), { refDate: REF });
  const p = s['CP-A1'].points[0];
  assert.equal(typeof p.tau, 'number');
  assert.equal(typeof p.rate, 'number');
  assert.equal(p.weekAge, 0);
  assert.equal(p.weight, 1, '당주 점의 가중치는 1');
  assert.ok(p.row && p.row.kind === 'CP', '원본 행이 실려 있어야 한다');
});

test('점은 잔존일수 오름차순', () => {
  const s = buildSeries([...ledger()].reverse(), { refDate: REF });
  const taus = s['CP-A1'].points.map((p) => p.tau);
  assert.deepEqual(taus, [...taus].sort((a, b) => a - b));
});

test('반감기 옵션이 점의 가중치와 적합에 함께 전달된다', () => {
  const old = row({ date: '2026-08-04', maturity_date: '2026-11-15', rate: 3.40 }); // 4주 전
  const s = buildSeries([...ledger(), old], { refDate: REF, halfLifeWeeks: 2 });
  const p = s['CP-A1'].points.find((q) => q.row === old);
  near(p.weight, 0.25, 1e-9, '반감기 2주 · 4주 전 → 0.25');

  const none = buildSeries([...ledger(), old], { refDate: REF, halfLifeWeeks: null });
  assert.equal(none['CP-A1'].points.find((q) => q.row === old).weight, 1, '가중없음이면 1');
});
