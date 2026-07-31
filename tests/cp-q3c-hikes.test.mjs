// CP-Q3c 인상 마커 도출 테스트 — node --test. (승인 구성: 25건)
//   A 마커크기 · B toRelativeX · C buildHikeMarkers · D KR 도출 · E US 런 내부정합 ·
//   F US 런↔사이클 매핑(t0 ∈ 런 인상일 집합) · G 실데이터 특성화(앵커).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hikeMarkerSize, toRelativeX, buildHikeMarkers, deriveKRHikes, US_HIKE_RUNS, usHikesFlat } from '../js/curve-phase/cp-hikes.js';
import { slopeSeries, eventAligned } from '../js/curve-phase/cp-overlay.js';

const R = (p) => JSON.parse(readFileSync(new URL('../' + p, import.meta.url)));
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
// points 헬퍼: offset i, date 'd<i>', bp = 임의 라인값.
const pts = (arr) => arr.map(([offset, date, bp]) => ({ offset, date, bp }));

// ── A. 마커 크기 = max(8, 6 + 0.16·bp) (앵커 25→10 · 50→14) ──
test('A1 · 마커크기 25bp → 10', () => near(hikeMarkerSize(25), 10));
test('A2 · 마커크기 50→14 · 75→18', () => { near(hikeMarkerSize(50), 14); near(hikeMarkerSize(75), 18); });
test('A3 · 하한 8(작은 인상)·앵커 위 단조', () => {
  near(hikeMarkerSize(0), 8); near(hikeMarkerSize(10), 8); // 6+0.16·10=7.6 < 8 → 하한
  assert.ok(hikeMarkerSize(25) < hikeMarkerSize(50) && hikeMarkerSize(50) < hikeMarkerSize(75));
});

// ── B. toRelativeX: 인상일 → 상대좌표(계단 carry-forward, 창 밖 null) ──
const P = pts([[-2, '2020-01-01', 10], [-1, '2020-01-02', 11], [0, '2020-01-06', 12], [1, '2020-01-07', 13], [2, '2020-01-08', 14]]);
test('B1 · 정확 일치일 → 해당 offset·y', () => assert.deepEqual(toRelativeX(P, '2020-01-06'), { offset: 0, y: 12 }));
test('B2 · 거래일 사이(주말) → 첫 이상일로 매핑', () => assert.deepEqual(toRelativeX(P, '2020-01-04'), { offset: 0, y: 12 }));
test('B3 · 마지막 포인트 이후(창 오른쪽) → null', () => assert.equal(toRelativeX(P, '2020-02-01'), null));
test('B4 · 첫 포인트 이전(창 왼쪽)·빈 points → null', () => {
  assert.equal(toRelativeX(P, '2019-12-01'), null);
  assert.equal(toRelativeX([], '2020-01-06'), null);
});

// ── C. buildHikeMarkers: points × 인상목록 → 마커(창 밖·offset 0 제외) ──
test('C1 · 창 밖 인상 제외', () => {
  const m = buildHikeMarkers(P, [{ date: '2020-01-07', rateAfter: 1, bp: 25 }, { date: '2099-01-01', rateAfter: 2, bp: 25 }]);
  assert.equal(m.length, 1); assert.equal(m[0].date, '2020-01-07');
});
test('C2 · size=hikeBp 파생 · y=그 세션 라인값', () => {
  const [m] = buildHikeMarkers(P, [{ date: '2020-01-07', rateAfter: 1, bp: 50 }]);
  near(m.size, 14); assert.equal(m.offset, 1); assert.equal(m.y, 13); near(m.hikeBp, 50);
});
test('C3 · isFinal 전파 · 인상 없음 → []', () => {
  const [m] = buildHikeMarkers(P, [{ date: '2020-01-07', rateAfter: 1, bp: 25, isFinal: true }]);
  assert.equal(m.isFinal, true);
  assert.deepEqual(buildHikeMarkers(P, []), []);
});
test('C4 · offset 0(T=0 첫 인상) 마커 제외(승인 ③)', () => {
  const m = buildHikeMarkers(P, [{ date: '2020-01-06', rateAfter: 1, bp: 25 }, { date: '2020-01-07', rateAfter: 2, bp: 25 }]);
  assert.deepEqual(m.map((x) => x.offset), [1]); // offset 0(2020-01-06) 제외 → offset 1 만
});

// ── D. deriveKRHikes: 기준금리 상승점 도출 · isFinal='다음 변경이 인하' ──
const kb = (rows) => rows.map(([date, rate]) => ({ date, rate }));
test('D1 · 인상만 도출 · rateAfter·bp 정확', () => {
  const h = deriveKRHikes(kb([['a', 2.0], ['b', 2.25], ['c', 2.25], ['d', 2.5]]));
  assert.equal(h.length, 2);
  assert.deepEqual(h.map((x) => [x.date, x.rateAfter, x.bp]), [['b', 2.25, 25], ['d', 2.5, 25]]);
});
test('D2 · isFinal = 다음 변경이 인하(인상,인상,인하)', () => {
  const h = deriveKRHikes(kb([['a', 2.0], ['b', 2.25], ['c', 2.5], ['d', 2.25]]));
  assert.deepEqual(h.map((x) => x.isFinal), [false, true]); // c 다음이 인하 → c 가 final
});
test('D3 · 마지막 인상 뒤 변경 없음(진행 사이클) → isFinal false', () => {
  const h = deriveKRHikes(kb([['a', 2.0], ['b', 2.25]]));
  assert.equal(h.at(-1).isFinal, false);
});
test('D4 · 실데이터: 2011-06-10 이 KR 유일 in-window final(다음=2012 인하)', () => {
  const h = deriveKRHikes(R('data/curve/kr_base_rate.json').data);
  const f = h.find((x) => x.date === '2011-06-10');
  assert.ok(f && f.isFinal === true && f.rateAfter === 3.25);
  assert.ok(h.length >= 15); // 2004~ 다수 인상
});

// ── E. US_HIKE_RUNS 내부 정합 ──
const RUNS = Object.entries(US_HIKE_RUNS);
test('E1 · 각 런 rateAfter 순증가', () => {
  for (const [id, run] of RUNS) for (let i = 1; i < run.length; i++)
    assert.ok(run[i].rateAfter > run[i - 1].rateAfter, `${id} 비순증`);
});
test('E2 · 각 인상 bp ∈ {25,50,75}', () => {
  for (const [, run] of RUNS) for (const h of run) assert.ok([25, 50, 75].includes(h.bp), `bp=${h.bp}`);
});
test('E3 · bp = 인접 rateAfter 차(레벨↔폭 정합)', () => {
  for (const [id, run] of RUNS) for (let i = 1; i < run.length; i++)
    assert.equal(run[i].bp, Math.round((run[i].rateAfter - run[i - 1].rateAfter) * 100), `${id}[${i}]`);
});
test('E4 · isFinal 전체 정확히 1개 = 1994 마지막(6.00%)', () => {
  const fins = RUNS.flatMap(([id, run]) => run.filter((h) => h.isFinal).map((h) => ({ id, h })));
  assert.equal(fins.length, 1);
  assert.equal(fins[0].id, '1994'); near(fins[0].h.rateAfter, 6.00);
});
test('E5 · isFinal 인상은 그 런의 마지막 원소', () => {
  for (const [, run] of RUNS) { const i = run.findIndex((h) => h.isFinal); if (i >= 0) assert.equal(i, run.length - 1); }
});
test('E6 · cycles.json US id ↔ 런 키 상호 포함', () => {
  const ids = R('data/curve/cycles.json').us.map((c) => c.id).sort();
  assert.deepEqual(Object.keys(US_HIKE_RUNS).sort(), ids);
});
test('E7 · usHikesFlat = 전체 런 합집합 · 날짜 오름차순', () => {
  const flat = usHikesFlat();
  assert.equal(flat.length, RUNS.reduce((s, [, r]) => s + r.length, 0));
  for (let i = 1; i < flat.length; i++) assert.ok(flat[i - 1].date <= flat[i].date, '비오름차순');
});

// ── F. US 런 ↔ 사이클 매핑: t0 ∈ 런의 인상일 집합 ──
//   (사이클 T=0 은 해당 런에 실재하는 인상일이어야 한다 — 첫 인상=t0.)
test('F1 · 각 US 사이클 t0 ∈ 런 인상일 집합', () => {
  for (const c of R('data/curve/cycles.json').us) {
    const dates = new Set((US_HIKE_RUNS[c.id] || []).map((h) => h.date));
    assert.ok(dates.has(c.t0), `${c.id} t0 ${c.t0} 런에 없음`);
  }
});

// ── G. 실데이터 특성화(오버레이×마커 앵커). US 인상은 전체(usHikesFlat)를 각 창에 매핑. ──
const CYC = R('data/curve/cycles.json');
const markersFor = (rows, kL, kS, t0, hikes) => buildHikeMarkers(eventAligned(slopeSeries(rows, kL, kS), t0).points, hikes);
const KRY = R('data/curve/kr_yields.json').data, USY = R('data/curve/us_yields.json').data;
const KR_HIKES = deriveKRHikes(R('data/curve/kr_base_rate.json').data);
const US_FLAT = usHikesFlat();

test('G1 · KR ◇ 정확히 1개 · 2010 사이클 2011-06-10', () => {
  let dia = [];
  for (const c of CYC.kr) markersFor(KRY, 'y10', 'y3', c.t0, KR_HIKES).filter((m) => m.isFinal).forEach((m) => dia.push([c.id, m.date]));
  assert.deepEqual(dia, [['2010', '2011-06-10']]);
});
test('G2 · US ◇ 정확히 1개 · 1994 사이클 1995-02-01', () => {
  let dia = [];
  for (const c of CYC.us) markersFor(USY, 'dgs10', 'dgs2', c.t0, US_FLAT).filter((m) => m.isFinal).forEach((m) => dia.push([c.id, m.date]));
  assert.deepEqual(dia, [['1994', '1995-02-01']]);
});
test('G3 · US 2016 마지막 마커 2017-12-13 = offset 250(우측 끝단 잘림)', () => {
  const m = markersFor(USY, 'dgs10', 'dgs2', '2016-12-14', US_FLAT);
  const last = m.at(-1);
  assert.equal(last.date, '2017-12-13'); assert.equal(last.offset, 250);
});
test('G4 · 모든 마커 offset ∈ (0, 창끝] · y = 그 세션 기울기(라인 위)', () => {
  for (const c of CYC.us) {
    const P2 = eventAligned(slopeSeries(USY, 'dgs10', 'dgs2'), c.t0).points;
    const byOff = new Map(P2.map((p) => [p.offset, p.bp]));
    for (const m of buildHikeMarkers(P2, US_FLAT)) {
      assert.ok(m.offset !== 0, 'offset 0 미제외');             // 승인 ③
      assert.ok(m.offset > P2[0].offset && m.offset <= P2.at(-1).offset, `${c.id} offset 창 밖`);
      assert.equal(m.y, byOff.get(m.offset)); // 마커 y = 라인 값
    }
  }
});
test('G5 · KR 2026(현재) → 마커 0개(T=0 유일 인상 제외 회귀 앵커)', () => {
  const m = markersFor(KRY, 'y10', 'y3', '2026-07-16', KR_HIKES);
  assert.equal(m.length, 0);
});
test('G6 · US 2015(참고) → 1개 · T+249 2016-12-14(집계=전체 인상 창 매핑)', () => {
  const m = markersFor(USY, 'dgs10', 'dgs2', '2015-12-16', US_FLAT);
  assert.equal(m.length, 1);
  assert.equal(m[0].date, '2016-12-14'); assert.equal(m[0].offset, 249);
});
