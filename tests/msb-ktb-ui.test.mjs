// MS-1 Step 2 화면 계층 순수 로직 테스트 — node --test (자동탐색).
// DOM 을 건드리는 initMsbKtb() 는 다루지 않는다(모듈 최상위에 DOM 접근이 없어 import 가능).
// 실데이터 앵커는 커밋된 data/msb-ktb-nodes.json 을 그대로 읽는다(파생 bp 뿐, 원본 금리 없음).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  relativeCurve, seriesValues, truncateToFirstObs, rollingZ, pctileRank, changesAt,
  resolveDateIndex, rangeStartIndex, CURVE_LINES, SERIES_DEFS, DEFAULT_SERIES, DEFAULT_NODE,
  Z_WINDOW, Z_MIN_PERIODS, GHOST_OFFSET, CHANGE_OFFSET,
  buildMatrix, syncFromCell, MATRIX_MODES, DEFAULT_MATRIX_MODE,
  MATRIX_MAIN_KEYS, MATRIX_AUX_KEYS, D_PAIRS, DEFAULT_PAIR, dTopKeys, D_BOTTOM_KEYS,
} from '../js/msb-ktb.js';
import { cellAlphaPct } from '../js/cv-matrix.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = JSON.parse(readFileSync(join(ROOT, 'data', 'msb-ktb-nodes.json'), 'utf8'));
const DATES = Object.keys(DOC.series).sort();

// 합성 레코드 — 노드 4개짜리 축소판
const rec = (spM2K3, spM3K3, liqKtb) => ({
  sp: { M2_K3: spM2K3, M2_K2: [0, 0, 0, 0], M3_K3: spM3K3, M3_K2: [0, 0, 0, 0] },
  liq: { msb: [0, 0, 0, 0], ktb: liqKtb, delta: [0, 0, 0, 0] },
  adj: { M2_K3: [0, 0, 0, 0], M2_K2: [0, 0, 0, 0], M3_K3: [0, 0, 0, 0], M3_K2: [0, 0, 0, 0] },
  cover: { M2: 1, M3: 1, K2: 1, K3: 1 }, flags: [],
});

// ── 상대곡선 구성 ───────────────────────────────────────────────────────────
test('MS-2A: K2 라인은 -liq.ktb 와 부호가 뒤집혀 있다', () => {
  const c = relativeCurve(rec([5, 6, 7, 8], [1, 2, 3, 4], [-3.4, 2.0, 0, -1.5]), 4);
  assert.deepEqual(c.K2, [3.4, -2.0, -0, 1.5]);
  // 부호 일치 확인: K2[i] === -liq.ktb[i]
  const liq = [-3.4, 2.0, 0, -1.5];
  c.K2.forEach((v, i) => assert.equal(v, -liq[i], `노드 ${i}`));
});

test('MS-2A: M2·M3 라인은 sp.M2_K3 · sp.M3_K3 를 그대로 쓰고 K3 는 0 기준선', () => {
  const c = relativeCurve(rec([5, 6, 7, 8], [1, 2, 3, 4], [-3, -3, -3, -3]), 4);
  assert.deepEqual(c.M2, [5, 6, 7, 8]);
  assert.deepEqual(c.M3, [1, 2, 3, 4]);
  assert.deepEqual(c.K3, [0, 0, 0, 0]);
  assert.deepEqual(CURVE_LINES.map(l => l.key), ['M2', 'M3', 'K2', 'K3']);
});

test('MS-2A: null 노드는 null 로 남는다 (선 끊김 — 채우거나 건너뛰지 않는다)', () => {
  const c = relativeCurve(rec([5, null, 7, null], [null, 2, 3, 4], [-3.4, null, null, -1]), 4);
  assert.deepEqual(c.M2, [5, null, 7, null]);
  assert.deepEqual(c.M3, [null, 2, 3, 4]);
  assert.deepEqual(c.K2, [3.4, null, null, 1]);
  // 배열 길이가 노드 수와 같아야 x 축 정렬이 유지된다(null 제거 시 노드가 밀린다)
  for (const k of ['M2', 'M3', 'K2', 'K3']) assert.equal(c[k].length, 4, k);
});

test('MS-2A: 원본 레코드를 변형하지 않는다', () => {
  const r = rec([5, 6, 7, 8], [1, 2, 3, 4], [-3, -3, -3, -3]);
  const before = JSON.parse(JSON.stringify(r));
  relativeCurve(r, 4);
  assert.deepEqual(r, before);
});

// ── 계열 추출 · 시작일 절단 ─────────────────────────────────────────────────
test('MS-2B: seriesValues 는 날짜순 노드값을 뽑고 결측은 null 로 둔다', () => {
  const doc = { nodes: [1, 2], series: {
    '2026-01-02': rec([1, 2, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]),
    '2026-01-05': rec([3, null, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]),
  } };
  assert.deepEqual(seriesValues(doc, 'sp.M2_K3', 0), [1, 3]);
  assert.deepEqual(seriesValues(doc, 'sp.M2_K3', 1), [2, null]);
  assert.deepEqual(seriesValues(doc, 'liq.ktb', 0), [0, 0]);
});

test('MS-2B: 계열 시작일 이전은 잘라낸다 (0 으로 채우지 않음)', () => {
  const dates = ['2021-01-01', '2021-01-02', '2021-01-03', '2021-01-04'];
  const t = truncateToFirstObs(dates, [null, null, 4.2, 4.5]);
  assert.deepEqual(t.dates, ['2021-01-03', '2021-01-04']);
  assert.deepEqual(t.values, [4.2, 4.5]);
  assert.equal(t.startIdx, 2);
  // 시작 이후의 중간 결측은 남긴다(선 끊김)
  assert.deepEqual(truncateToFirstObs(dates, [null, 1, null, 3]).values, [1, null, 3]);
  // 전부 null 이면 빈 배열
  assert.deepEqual(truncateToFirstObs(dates, [null, null, null, null]), { dates: [], values: [], startIdx: -1 });
});

test('MS-2B: 실데이터에서 계열별 시작일이 실제로 다르다', () => {
  const nodeIdx = DOC.nodes.indexOf(1.75);
  const start = key => {
    const t = truncateToFirstObs(DATES, seriesValues(DOC, key, nodeIdx, DATES));
    return t.dates[0];
  };
  const m2k3 = start('sp.M2_K3');
  const m3k3 = start('sp.M3_K3');
  assert.ok(m2k3 && m3k3, '두 계열 모두 관측이 있어야 한다');
  assert.ok(m3k3 > m2k3, `M3 계열이 더 늦게 시작해야 한다 (M2_K3 ${m2k3} / M3_K3 ${m3k3})`);
  assert.ok(m2k3 > DATES[0], '계열 시작일이 데이터 첫날보다 늦다');
});

// ── z250 ────────────────────────────────────────────────────────────────────
test('MS-2B: rollingZ 는 창 내 평균·표본표준편차로 표준화한다', () => {
  // 창을 5, min_periods 3 으로 줄여 손계산과 맞춘다.
  const v = [1, 2, 3, 4, 10];
  const z = rollingZ(v, { window: 5, minPeriods: 3 });
  assert.equal(z[0], null, 'n=1 < 3');
  assert.equal(z[1], null, 'n=2 < 3');
  // i=2: [1,2,3] mean 2, sd(ddof=1) 1 → (3-2)/1 = 1
  assert.ok(Math.abs(z[2] - 1) < 1e-12, `${z[2]}`);
  // i=3: [1,2,3,4] mean 2.5, sd = sqrt(5/3) → (4-2.5)/sd
  assert.ok(Math.abs(z[3] - 1.5 / Math.sqrt(5 / 3)) < 1e-12, `${z[3]}`);
  // i=4: [1,2,3,4,10] mean 4, sd = sqrt(50/4) → (10-4)/sd
  assert.ok(Math.abs(z[4] - 6 / Math.sqrt(12.5)) < 1e-12, `${z[4]}`);
});

test('MS-2B: 창이 밀리면 옛 관측은 빠진다 (rolling 이지 expanding 이 아니다)', () => {
  const v = [0, 0, 0, 0, 5, 5, 5];
  const z = rollingZ(v, { window: 3, minPeriods: 3 });
  // i=6 창 = [5,5,5] → σ=0 → null (expanding 이면 σ>0 이라 값이 나온다)
  assert.equal(z[6], null);
  // i=4 창 = [0,0,5] → mean 5/3, sd = sqrt(25/3)
  assert.ok(Math.abs(z[4] - (5 - 5 / 3) / Math.sqrt(25 / 3)) < 1e-12, `${z[4]}`);
});

test('MS-2B: 유효 관측이 min_periods 미만이면 null (기본 250/120)', () => {
  assert.equal(Z_WINDOW, 250);
  assert.equal(Z_MIN_PERIODS, 120);
  const v = Array.from({ length: 300 }, (_, i) => i);
  const z = rollingZ(v);
  for (let i = 0; i < Z_MIN_PERIODS - 1; i++) assert.equal(z[i], null, `i=${i}`);
  assert.notEqual(z[Z_MIN_PERIODS - 1], null, '119번째(0-index)에서 창 표본 120 → 값이 나온다');
  // 결측이 섞이면 그만큼 뒤로 밀린다
  const withGaps = v.map((x, i) => (i % 2 ? null : x));
  const zg = rollingZ(withGaps);
  assert.equal(zg[Z_MIN_PERIODS - 1], null, '유효 관측이 절반이라 아직 120 미만');
});

test('MS-2B: 값이 null 인 지점의 z 는 null', () => {
  const v = Array.from({ length: 200 }, (_, i) => (i === 199 ? null : i));
  assert.equal(rollingZ(v, { window: 250, minPeriods: 120 })[199], null);
});

test('MS-2B: σ=0 이면 z 는 null (0 으로 나누지 않는다)', () => {
  assert.equal(rollingZ(new Array(200).fill(3), { window: 250, minPeriods: 120 })[199], null);
});

// ── 백분위 · 변화 · 인덱스 ──────────────────────────────────────────────────
test('MS-2B: pctileRank 는 창 내 현재값 이하 비율(%)', () => {
  const v = Array.from({ length: 200 }, (_, i) => i); // 0..199 증가
  assert.equal(pctileRank(v, 199, { window: 250, minPeriods: 120 }), 100);
  const flat = new Array(200).fill(5);
  assert.equal(pctileRank(flat, 199, { window: 250, minPeriods: 120 }), 100, '동값은 이하로 센다');
  assert.equal(pctileRank(v, 50, { window: 250, minPeriods: 120 }), null, '표본 51 < 120');
});

test('MS-2B: changesAt 은 1·5·21영업일 전 대비 (없으면 null)', () => {
  assert.deepEqual(CHANGE_OFFSET, { '1D': 1, '1W': 5, '1M': 21 });
  const v = Array.from({ length: 30 }, (_, i) => i * 2); // 0,2,4,...
  assert.deepEqual(changesAt(v, 29), { '1D': 2, '1W': 10, '1M': 42 });
  assert.deepEqual(changesAt(v, 3), { '1D': 2, '1W': null, '1M': null });
  const withNull = v.slice(); withNull[28] = null;
  assert.equal(changesAt(withNull, 29)['1D'], null);
});

test('MS-2B: resolveDateIndex — 없는 날짜는 직전 영업일로 붙는다', () => {
  const ds = ['2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12'];
  assert.equal(resolveDateIndex(ds, '2026-08-11'), 2);
  assert.equal(resolveDateIndex(ds, '2026-08-09'), 0, '일요일 → 직전 영업일 08-07');
  assert.equal(resolveDateIndex(ds, '2026-08-13'), 3, '데이터 끝 이후 → 마지막');
  assert.equal(resolveDateIndex(ds, '2026-01-01'), 0, '데이터 시작 이전 → 첫날');
  assert.equal(resolveDateIndex(ds, null), 3, '미지정 → 최종일');
});

test('MS-2B: 기간 프리셋 → 시작 인덱스', () => {
  assert.equal(rangeStartIndex(2556, 'all'), 0);
  assert.equal(rangeStartIndex(2556, '1y'), 2306);
  assert.equal(rangeStartIndex(2556, '5y'), 1306);
  assert.equal(rangeStartIndex(100, '1y'), 0, '표본이 짧으면 전체');
});

// ── 기본 상태 · 계열 정의 ───────────────────────────────────────────────────
test('MS-2B: 계열 목록·기본값이 스펙대로다', () => {
  assert.deepEqual(SERIES_DEFS.filter(d => d.group === 'main').map(d => d.key),
    ['sp.M2_K3', 'sp.M2_K2', 'sp.M3_K3', 'sp.M3_K2', 'liq.msb', 'liq.ktb', 'liq.delta']);
  assert.deepEqual(SERIES_DEFS.filter(d => d.group === 'aux').map(d => d.key),
    ['adj.M2_K3', 'adj.M2_K2', 'adj.M3_K3', 'adj.M3_K2']);
  assert.deepEqual(DEFAULT_SERIES, ['sp.M2_K3'], '기본은 sp.M2_K3 단독 ON');
  assert.equal(DEFAULT_NODE, 1.75);
  assert.deepEqual(GHOST_OFFSET, { '1w': 5, '1m': 21 });
  // 모든 계열 키가 실데이터에 존재해야 한다
  const rec0 = DOC.series[DATES[DATES.length - 1]];
  for (const d of SERIES_DEFS) {
    const [g, s] = d.key.split('.');
    assert.ok(Array.isArray(rec0[g][s]), `${d.key} 없음`);
  }
});

// ── 실데이터 앵커 (2026-08-12, 노드 1.75) ───────────────────────────────────
test('MS-2A: 실데이터 앵커 — 2026-08-12 노드 1.75', () => {
  const D = '2026-08-12';
  assert.ok(DOC.series[D], `${D} 레코드 없음 (최종일 ${DATES[DATES.length - 1]})`);
  const i = DOC.nodes.indexOf(1.75);
  const c = relativeCurve(DOC.series[D], DOC.nodes.length);
  const near = (a, e, tol, label) => {
    assert.notEqual(a, null, `${label} 이 null`);
    assert.ok(Math.abs(a - e) <= tol, `${label}: ${a} (기대 ${e} ±${tol})`);
  };
  near(c.M2[i], 5.8, 0.3, 'A섹션 M2 라인 @1.75');
  near(c.K2[i], 3.4, 0.3, 'A섹션 K2 라인 @1.75');
  // K2 라인은 liq.ktb 의 부호 반전이라는 정의가 실데이터에서도 유지되는지
  assert.equal(c.K2[i], -DOC.series[D].liq.ktb[i]);
  assert.equal(c.K3[i], 0);
});

// ── 섹션 C: 계열 × 노드 매트릭스 ────────────────────────────────────────────
// 실데이터 접근자 — 섹션 B 와 같은 경로(seriesValues/rollingZ)를 쓴다.
const NODE_IDX = n => DOC.nodes.indexOf(n);
const VCACHE = new Map(), ZCACHE = new Map();
const valuesOf = (k, n) => {
  const ck = `${k}|${n}`;
  if (!VCACHE.has(ck)) VCACHE.set(ck, seriesValues(DOC, k, NODE_IDX(n), DATES));
  return VCACHE.get(ck);
};
const zOf = (k, n) => {
  const ck = `${k}|${n}`;
  if (!ZCACHE.has(ck)) ZCACHE.set(ck, rollingZ(valuesOf(k, n)));
  return ZCACHE.get(ck);
};
const modeOf = k => MATRIX_MODES.find(m => m.key === k);
const LAST = DATES.length - 1;
const matrix = (modeKey, keys = MATRIX_MAIN_KEYS) =>
  buildMatrix({ keys, nodes: DOC.nodes, mode: modeOf(modeKey), valuesOf, zOf, idx: LAST });

test('MS-2C: 행·열 구성 — 주 7계열 + 보조 4계열 토글, 열 7노드', () => {
  assert.deepEqual(MATRIX_MAIN_KEYS,
    ['sp.M2_K3', 'sp.M2_K2', 'sp.M3_K3', 'sp.M3_K2', 'liq.msb', 'liq.ktb', 'liq.delta']);
  assert.deepEqual(MATRIX_AUX_KEYS, ['adj.M2_K3', 'adj.M2_K2', 'adj.M3_K3', 'adj.M3_K2']);
  assert.equal(DOC.nodes.length, 7);
  const M = matrix('1m');
  assert.equal(M.cells.length, 7);
  M.cells.forEach(r => assert.equal(r.length, 7));
  assert.equal(matrix('1m', [...MATRIX_MAIN_KEYS, ...MATRIX_AUX_KEYS]).cells.length, 11);
});

test('MS-2C: 매트릭스 셀 값이 B섹션 요약표와 같다 (계열·노드 교차 3건)', () => {
  const M = matrix('1m');
  const cross = [['sp.M2_K3', 1.75], ['liq.ktb', 1.0], ['sp.M3_K2', 2.25]];
  for (const [key, node] of cross) {
    const bTable = changesAt(valuesOf(key, node), LAST)['1M']; // B 섹션 요약표가 쓰는 경로
    const cell = M.cells[MATRIX_MAIN_KEYS.indexOf(key)][DOC.nodes.indexOf(node)];
    assert.equal(cell, bTable, `${key} @${node}`);
  }
  // 레벨·z 모드도 같은 근원을 쓴다
  assert.equal(matrix('level').cells[0][DOC.nodes.indexOf(1.75)], valuesOf('sp.M2_K3', 1.75)[LAST]);
  assert.equal(matrix('z250').cells[0][DOC.nodes.indexOf(1.75)], zOf('sp.M2_K3', 1.75)[LAST]);
});

test('MS-2C: 3M 변화는 영업일 63일 전 대비 (달력 90일 아님)', () => {
  assert.equal(modeOf('3m').biz, 63);
  assert.equal(modeOf('1m').biz, 21);
  assert.equal(modeOf('1w').biz, 5);
  const M = matrix('3m');
  assert.equal(M.baseIdx, LAST - 63);
  const vals = valuesOf('sp.M2_K3', 1.75);
  assert.equal(M.cells[0][DOC.nodes.indexOf(1.75)],
    Math.round((vals[LAST] - vals[LAST - 63]) * 10) / 10);
  // 63영업일 전은 달력으로 63일보다 멀다 — 인덱스 기준임을 날짜로 확인
  const days = (Date.parse(DATES[LAST]) - Date.parse(DATES[LAST - 63])) / 86400000;
  assert.ok(days > 63, `영업일 63일 = 달력 ${days}일 (달력 기준이면 안 된다)`);
});

test('MS-2C: null 셀은 null 로 남는다 (0 으로 칠하지 않음)', () => {
  const vals = { 'a|1': [1, 2, 3], 'b|1': [null, null, null] };
  const M = buildMatrix({
    keys: ['a', 'b'], nodes: [1], mode: modeOf('level'),
    valuesOf: (k, n) => vals[`${k}|${n}`], zOf: () => [], idx: 2,
  });
  assert.equal(M.cells[0][0], 3);
  assert.equal(M.cells[1][0], null);
  assert.notEqual(M.cells[1][0], 0, 'null 을 0 으로 바꾸면 안 된다');
  assert.equal(cellAlphaPct(null, M.maxAbs), 0, 'null 은 색 농도 0');
  // 실데이터에도 null 셀이 실제로 존재한다(노드가 관측 범위 밖인 계열)
  assert.ok(matrix('level').cells.flat().some(v => v === null),
    '실데이터에 null 셀이 없어 이 경로가 검증되지 않는다');
});

test('MS-2C: 과거 이력이 부족하면 변화 셀이 전부 null', () => {
  const M = buildMatrix({
    keys: ['a'], nodes: [1], mode: modeOf('3m'),
    valuesOf: () => [1, 2, 3], zOf: () => [], idx: 2,
  });
  assert.equal(M.baseIdx, 2 - 63);
  assert.equal(M.cells[0][0], null);
  assert.equal(M.maxAbs, 0);
});

test('MS-2C: 컬러스케일 기준은 모드별로 분리된다 (bp 변화와 z 를 같은 스케일에 태우지 않음)', () => {
  const chg = matrix('1m'), z = matrix('z250'), lvl = matrix('level');
  const maxOf = M => Math.max(...M.cells.flat().filter(v => v != null).map(Math.abs));
  for (const M of [chg, z, lvl]) assert.ok(Math.abs(M.maxAbs - maxOf(M)) < 1e-9, '기준이 자기 모드 셀에서 나온다');
  // z 는 무차원, bp 변화·레벨은 자릿수가 다르다 → 기준이 섞이면 색이 무의미해진다
  assert.ok(z.maxAbs < chg.maxAbs, `z ${z.maxAbs} vs 변화 ${chg.maxAbs}`);
  assert.notEqual(chg.maxAbs, lvl.maxAbs);
  // 같은 |값| 이라도 모드가 다르면 농도가 다르다
  assert.notEqual(cellAlphaPct(2, chg.maxAbs), cellAlphaPct(2, z.maxAbs));
});

test('MS-2C: 셀 클릭 → B섹션 계열·노드 동기 (누적이 아니라 교체)', () => {
  const state = { series: new Set(['sp.M2_K3', 'liq.msb']), node: 1.75, range: '1y' };
  syncFromCell(state, 'liq.ktb', 2.25);
  assert.deepEqual([...state.series], ['liq.ktb']);
  assert.equal(state.node, 2.25);
  assert.equal(state.range, '1y', '기간 등 다른 상태는 건드리지 않는다');
});

test('MS-2C: 기본 모드는 1M 변화', () => {
  assert.equal(DEFAULT_MATRIX_MODE, '1m');
  assert.deepEqual(MATRIX_MODES.map(m => m.key), ['1w', '1m', '3m', 'z250', 'level']);
});

// ── 섹션 D: 유동성 분해 ─────────────────────────────────────────────────────
test('MS-2D: 페어·계열 구성', () => {
  assert.deepEqual(D_PAIRS, ['M2_K3', 'M2_K2', 'M3_K3', 'M3_K2']);
  assert.equal(DEFAULT_PAIR, 'M2_K3');
  assert.deepEqual(dTopKeys('M2_K3'), ['sp.M2_K3', 'adj.M2_K3', 'liq.delta']);
  assert.deepEqual(dTopKeys('M3_K2'), ['sp.M3_K2', 'adj.M3_K2', 'liq.delta']);
  assert.deepEqual(D_BOTTOM_KEYS, ['liq.msb', 'liq.ktb']);
});

test('MS-2D: 항등식 sp = adj + liq.delta — 전 페어·전 노드·전 일자', () => {
  let checked = 0, worst = 0;
  for (const d of DATES) {
    const rec = DOC.series[d];
    for (const pair of D_PAIRS) {
      for (let i = 0; i < DOC.nodes.length; i++) {
        const sp = rec.sp[pair][i], adj = rec.adj[pair][i], dl = rec.liq.delta[i];
        if (sp == null || adj == null || dl == null) continue;
        const err = Math.abs(sp - adj - dl);
        if (err > worst) worst = err;
        assert.ok(err <= 0.05, `${d} ${pair} @${DOC.nodes[i]}: ${sp} - ${adj} - ${dl} = ${err}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 10000, `표본이 너무 적다 (${checked})`);
  assert.ok(worst <= 0.05, `최대 오차 ${worst}`);
});

test('MS-2D: adj·liq 계열은 sp 보다 늦게 시작하고, 앞을 잘라내지 않는다', () => {
  const start = k => truncateToFirstObs(DATES, valuesOf(k, 1.75)).dates[0];
  const sp = start('sp.M2_K3'), adj = start('adj.M2_K3'), dl = start('liq.delta');
  assert.ok(adj > sp, `adj(${adj}) 가 sp(${sp}) 보다 늦어야 한다`);
  assert.equal(adj, dl, 'adj 와 liq.delta 는 같은 날 시작한다(둘 다 M3 계보가 필요)');
  // 각 계열은 자기 시작일부터 자기 길이만큼 그린다 — 짧은 쪽에 맞춰 자르지 않는다
  const spLen = truncateToFirstObs(DATES, valuesOf('sp.M2_K3', 1.75)).values.length;
  const adjLen = truncateToFirstObs(DATES, valuesOf('adj.M2_K3', 1.75)).values.length;
  assert.ok(spLen > adjLen, `sp ${spLen} 이 adj ${adjLen} 보다 길어야 한다`);
});

// ── 실데이터 앵커 (2026-08-12) ──────────────────────────────────────────────
test('MS-2C: 실데이터 앵커 — 매트릭스 sp.M2_K3 @1.75 의 1M 변화', () => {
  assert.equal(DATES[LAST], '2026-08-12');
  const v = matrix('1m').cells[MATRIX_MAIN_KEYS.indexOf('sp.M2_K3')][DOC.nodes.indexOf(1.75)];
  assert.ok(v != null && Math.abs(v - (-3.6)) <= 0.3, `1M 변화: ${v} (기대 -3.6 ±0.3)`);
});

test('MS-2D: 실데이터 앵커 — M2_K3 @1.00 의 sp / adj / liq.delta', () => {
  const i = DOC.nodes.indexOf(1.0);
  const rec = DOC.series['2026-08-12'];
  const near = (a, e, label) => {
    assert.notEqual(a, null, `${label} 이 null`);
    assert.ok(Math.abs(a - e) <= 0.3, `${label}: ${a} (기대 ${e} ±0.3)`);
  };
  near(rec.sp.M2_K3[i], -8.2, 'sp.M2_K3 @1.00');
  near(rec.adj.M2_K3[i], 5.1, 'adj.M2_K3 @1.00');
  near(rec.liq.delta[i], -13.3, 'liq.delta @1.00');
  assert.ok(Math.abs(rec.sp.M2_K3[i] - rec.adj.M2_K3[i] - rec.liq.delta[i]) <= 0.05, '앵커끼리도 항등식 성립');
});
