// CRV-1 계산 레이어 앵커 테스트 — node --test (인자 없이 자동탐색).
//
// 고정하려는 불변식은 넷이다.
//   1) 듀레이션이 CE(curve-efficiency.html) 원본과 **비트 단위로 같다** — 복제본이 조용히
//      갈라지면 두 화면이 같은 커브에서 다른 듀레이션을 쓰게 된다.
//   2) 퇴화 입력(직선 커브·분모 3bp·결측)에서 숫자를 억지로 내지 않는다.
//   3) 결측이 행 전체를 오염시키지 않는다 — 50Y 미관측 구간에서도 나머지 조합은 산다.
//   4) 표본이 250에 못 미치면 그 사실을 감추지 않고 window 에 적는다.
//
// 실데이터(data/ktb-curve.js)는 구조 스모크에만 쓴다. 값 앵커를 실데이터에 걸면 커브가
// 갱신될 때마다 테스트가 깨져서, 회귀가 아닌 것에 사람이 불려나오게 된다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { modDur } from '../js/crv1/crv1-dur.js';
import {
  NODES, TRIPLES, PAIRS, TIGHT_BP, WINDOW,
  nodeColumns, pickNodes, nodeDurations, weightsAt, slopesAt, rangePos, snapshot,
} from '../js/crv1/crv1-calc.js';

const near = (a, b, tol = 1e-12) => assert.ok(a != null && Math.abs(a - b) <= tol, `${a} ≉ ${b}`);
const byKey = (arr, k) => arr.find((it) => it.key === k);

// 8노드 정수 격자. CRV-1 은 관측 노드만 쓰므로 grid 를 NODES 그대로 둔다.
const GRID = [...NODES];
const row = (d, vals) => [d, ...vals];
/** 노드 8개 값 배열 → {grid, rows} 단일 행 커브 */
const oneRow = (vals, d = '2026-08-11') => ({ grid: GRID, rows: [row(d, vals)] });

// 최신일(2026-08-11) 실제 커브의 8노드 값 — 값 앵커가 아니라 "현실적인 모양"의 표본으로만 쓴다.
const REAL = [3.408, 3.627, 3.797, 4.035, 4.295, 4.630, 4.657, 4.596];

// ── 1. modDur 이 CE 원본과 동일 출력 ──────────────────────────────────────────
// 하드코딩 앵커. curve-efficiency.html:253-258 의 modDur 을 그대로 돌려 뽑은 값이다.
test('modDur — CE 원본과 동일 출력 (하드코딩 앵커 4건, 비트 일치)', () => {
  assert.equal(modDur(1, 3.408), 0.9750086017932554);
  assert.equal(modDur(3, 3.797), 2.8103342688424364);
  assert.equal(modDur(10, 4.295), 8.060526960094133);
  assert.equal(modDur(30, 4.657), 16.076736449788132);
});

test('modDur — 경계: 만기 0 이하는 0', () => {
  assert.equal(modDur(0, 3.5), 0);
  assert.equal(modDur(-1, 3.5), 0);
});

// 패리티 스윕. CE 원문에서 함수를 추출해 8노드 × 여러 금리로 대조한다.
// CE 의 modDur 이 바뀌면 여기서 깨진다 — 그게 "복제본도 같이 고치라"는 신호다.
test('modDur — CE 원문 추출본과 패리티 (8노드 × 5금리)', (t) => {
  const htmlPath = fileURLToPath(new URL('../curve-efficiency.html', import.meta.url));
  if (!existsSync(htmlPath)) return t.skip('curve-efficiency.html 없음');
  const src = readFileSync(htmlPath, 'utf8');
  const m = src.match(/function modDur\(m,yt\)\{[\s\S]*?\n\}/);
  if (!m) return t.skip('CE 원문에서 modDur 추출 실패 — 원본 형태가 바뀌었는지 확인 필요');
  const ceModDur = new Function(`return (${m[0]})`)();

  for (const n of NODES) {
    for (const y of [0.5, 2.0, 3.408, 4.657, 9.75]) {
      assert.equal(modDur(n, y), ceModDur(n, y), `${n}Y @${y}%`);
    }
  }
});

// ── 2. 직선 커브 → slope 전부 0 ───────────────────────────────────────────────
test('직선 커브(전 구간 3.0%) → slope 7조합 전부 0', () => {
  const snap = snapshot(oneRow([3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0]));
  assert.equal(snap.slopes.length, 7);
  for (const it of snap.slopes) {
    assert.equal(it.flag, null, `${it.key} flag`);
    assert.equal(it.slope, 0, `${it.key} slope`);
  }
});

test('직선 커브 → ratio 는 분모 0 이라 tight (숫자를 억지로 내지 않는다)', () => {
  const snap = snapshot(oneRow([3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0, 3.0]));
  for (const it of snap.weights) {
    assert.equal(it.flag, 'tight', `${it.key} flag`);
    assert.equal(it.ratio, null);
    assert.equal(it.gap, null);
    assert.notEqual(it.neutral, null, '중립은 금리를 안 쓰므로 tight 여도 나온다');
  }
});

// ── 3. 듀레이션 중립 3/5/10 이 30~33% ────────────────────────────────────────
test('neutral(duration) 3/5/10 이 30~33% 범위 (산식 sanity)', () => {
  const y = Object.fromEntries(NODES.map((n, i) => [n, REAL[i]]));
  const w = byKey(weightsAt(y, nodeDurations(y)), '3-5-10');
  assert.ok(w.neutral > 30 && w.neutral < 33, `neutral=${w.neutral} 이 30~33 밖`);
  // 시간 중립은 같은 구간에서 28.57% — 두 기준이 다른 값이라는 것도 함께 고정한다.
  const wt = byKey(weightsAt(y, nodeDurations(y), { neutral: 'time' }), '3-5-10');
  near(wt.neutral, 28.57, 1e-9);
  assert.ok(w.neutral > wt.neutral, '볼록 구간에서 듀레이션 중립 > 시간 중립');
});

test('neutral(time) — 금리·듀레이션과 무관하게 만기만으로 결정', () => {
  const a = Object.fromEntries(NODES.map((n, i) => [n, REAL[i]]));
  const b = Object.fromEntries(NODES.map((n) => [n, 3.0 + n * 0.01]));
  const ka = byKey(weightsAt(a, nodeDurations(a), { neutral: 'time' }), '5-10-20').neutral;
  const kb = byKey(weightsAt(b, nodeDurations(b), { neutral: 'time' }), '5-10-20').neutral;
  assert.equal(ka, kb);
  near(ka, round2((10 - 5) / (20 - 5) * 100), 1e-9); // 33.33
});
const round2 = (x) => Math.round(x * 100) / 100;

test('neutral 인자 검증 — 알 수 없는 기준은 조용히 넘어가지 않는다', () => {
  const y = Object.fromEntries(NODES.map((n, i) => [n, REAL[i]]));
  assert.throws(() => weightsAt(y, nodeDurations(y), { neutral: 'maturity' }), /neutral/);
});

// ── 4. 분모 3bp → ratio null + flag 'tight' ─────────────────────────────────
test('분모 3bp 커브 → 해당 조합만 ratio·gap null + flag tight', () => {
  //                1     2      3     5     10    20    30    50
  const vals = [3.00, 3.005, 3.01, 3.02, 3.04, 3.10, 3.20, 3.30];
  const snap = snapshot({ grid: GRID, rows: [row('2026-08-11', vals)] });

  const tight = byKey(snap.weights, '3-5-10'); // 3.04 − 3.01 = 3bp < 5bp
  assert.equal(tight.flag, 'tight');
  assert.equal(tight.ratio, null);
  assert.equal(tight.gap, null);
  assert.notEqual(tight.neutral, null);

  const wide = byKey(snap.weights, '10-20-30'); // 3.20 − 3.04 = 16bp
  assert.equal(wide.flag, null);
  assert.notEqual(wide.ratio, null);
  assert.notEqual(wide.gap, null);
});

test('tight 경계 — 정확히 5bp 는 tight 가 아니고, 4.9bp 는 tight', () => {
  const mk = (span) => {
    const y = Object.fromEntries(NODES.map((n) => [n, 3.0]));
    y[3] = 3.0; y[5] = 3.0 + span / 2 / 100; y[10] = 3.0 + span / 100;
    return byKey(weightsAt(y, nodeDurations(y)), '3-5-10');
  };
  assert.equal(mk(TIGHT_BP).flag, null, '5bp 는 산출');
  assert.equal(mk(4.9).flag, 'tight');
});

// ── 5. 50Y null 행 → 50Y 조합만 null ────────────────────────────────────────
test('50Y null 행 → 20/30/50 조합만 null, 나머지 5조합 정상 산출', () => {
  const vals = [...REAL.slice(0, 7), null]; // 50Y 미관측 (2016-10-11 이전 구간 재현)
  const snap = snapshot({ grid: GRID, rows: [row('2016-05-02', vals)] });

  const dead = byKey(snap.weights, '20-30-50');
  assert.equal(dead.flag, 'missing');
  assert.equal(dead.ratio, null);
  assert.equal(dead.gap, null);
  assert.equal(dead.neutral, null);

  const alive = snap.weights.filter((it) => it.key !== '20-30-50');
  assert.equal(alive.length, 5);
  for (const it of alive) {
    assert.equal(it.flag, null, `${it.key} flag`);
    assert.ok(Number.isFinite(it.ratio), `${it.key} ratio`);
    assert.ok(Number.isFinite(it.gap), `${it.key} gap`);
  }
});

test('50Y null 행 → slope 는 30-50 만 null, 나머지 6조합 정상', () => {
  const vals = [...REAL.slice(0, 7), null];
  const snap = snapshot({ grid: GRID, rows: [row('2016-05-02', vals)] });
  assert.equal(byKey(snap.slopes, '30-50').flag, 'missing');
  assert.equal(byKey(snap.slopes, '30-50').slope, null);
  const alive = snap.slopes.filter((it) => it.key !== '30-50');
  assert.equal(alive.length, 6);
  for (const it of alive) assert.ok(Number.isFinite(it.slope), `${it.key} slope`);
  assert.equal(snap.nodes[50], null);
  assert.equal(snap.durations[50], null);
});

// ── 6. 250일 미만 → window 에 실제 행수 ─────────────────────────────────────
test('250행 미만 → window 가 실제 행수, rowsAvailable 과 일치', () => {
  const rows = Array.from({ length: 37 }, (_, i) =>
    row(`2026-01-${String(i + 1).padStart(2, '0')}`, REAL.map((v) => v + i * 0.001)));
  const snap = snapshot({ grid: GRID, rows });
  assert.equal(snap.window, 37);
  assert.equal(snap.rowsAvailable, 37);
  assert.ok(snap.window < WINDOW);
});

test('250행 초과 → window 는 250 으로 고정, rowsAvailable 은 전체', () => {
  const rows = Array.from({ length: 300 }, (_, i) =>
    row(`d${i}`, REAL.map((v) => v + i * 0.001)));
  const snap = snapshot({ grid: GRID, rows });
  assert.equal(snap.window, WINDOW);
  assert.equal(snap.rowsAvailable, 300);
  assert.equal(snap.date, 'd299', '최신일은 마지막 행');
});

test('창 안 50Y 결측일은 표본에서 빠지고 range.n 에 드러난다', () => {
  // 50Y 를 20Y 보다 충분히 위(≈32bp)에 둔다. REAL 그대로 쓰면 20↔50 이 −3.4bp 라
  // 전 구간 tight 로 걸려서 결측 여부를 못 보게 된다(실데이터의 성질 — 아래 스모크 참조).
  const rows = Array.from({ length: 10 }, (_, i) =>
    row(`d${i}`, [...REAL.slice(0, 7), i < 4 ? null : 4.95 + i * 0.01]));
  const snap = snapshot({ grid: GRID, rows });
  assert.equal(snap.window, 10);
  assert.equal(byKey(snap.weights, '20-30-50').range.n, 6, '앞 4일은 50Y 결측');
  assert.equal(byKey(snap.weights, '10-20-30').range.n, 10);
});

// ── 창 위치(pos) ────────────────────────────────────────────────────────────
test('rangePos — min/max/pos 손계산, null 은 표본에서 제외', () => {
  assert.deepEqual(rangePos([10, null, 20, 15], 15), { min: 10, max: 20, pos: 0.5, n: 3 });
  assert.deepEqual(rangePos([10, 20], 20), { min: 10, max: 20, pos: 1, n: 2 });
  assert.deepEqual(rangePos([10, 20], 10), { min: 10, max: 20, pos: 0, n: 2 });
});

test('rangePos — 폭 0·표본 부족·현재값 null 이면 pos 는 null', () => {
  assert.equal(rangePos([5, 5, 5], 5).pos, null, '폭 0');
  assert.equal(rangePos([7], 7).pos, null, '표본 1');
  assert.equal(rangePos([10, 20], null).pos, null, '현재값 null');
  assert.deepEqual(rangePos([null, null], null), { min: null, max: null, pos: null, n: 0 });
});

test('pos — 최신값이 창 최대/최소면 1/0 (단조 증가·감소 창)', () => {
  const up = Array.from({ length: 20 }, (_, i) => row(`d${i}`, [
    3.0, 3.1, 3.2, 3.4, 3.7 + i * 0.01, 4.2, 4.3, 4.4]));
  const s = snapshot({ grid: GRID, rows: up });
  const g = byKey(s.weights, '3-5-10'); // 10Y 만 계속 오름 → ratio·gap 단조
  assert.ok(g.range.pos === 1 || g.range.pos === 0, `pos=${g.range.pos} 가 끝점이 아님`);
});

// ── 구조·방어 ───────────────────────────────────────────────────────────────
test('조합 수 — 구간 비중 6개, 기울기 7개, 노드 8개', () => {
  assert.equal(NODES.length, 8);
  assert.equal(TRIPLES.length, 6);
  assert.equal(PAIRS.length, 7);
  assert.deepEqual(NODES, [1, 2, 3, 5, 10, 20, 30, 50]);
});

test('nodeColumns — grid 에 노드가 없으면 던진다 (조용한 null 금지)', () => {
  assert.throws(() => nodeColumns([1, 2, 3, 5, 10, 20, 30]), /50Y/);
  const cols = nodeColumns([0.25, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 15, 20, 30, 50]);
  assert.equal(cols.get(1), 4);   // grid idx 3 + 1
  assert.equal(cols.get(50), 16); // grid idx 15 + 1
});

test('pickNodes — 비수치(NaN·undefined)는 null 로 통일', () => {
  const cols = nodeColumns(GRID);
  const y = pickNodes(row('d', [3.0, NaN, undefined, 3.5, null, 4.0, 4.1, 4.2]), cols);
  assert.equal(y[2], null); assert.equal(y[3], null); assert.equal(y[10], null);
  assert.equal(y[1], 3.0); assert.equal(y[5], 3.5);
});

test('slopesAt — 듀레이션 비단조면 Infinity 대신 degenerate', () => {
  const y = Object.fromEntries(NODES.map((n, i) => [n, REAL[i]]));
  const D = nodeDurations(y);
  D[10] = D[5]; // 인위적 퇴화
  const it = byKey(slopesAt(y, D), '5-10');
  assert.equal(it.flag, 'degenerate');
  assert.equal(it.slope, null);
});

test('snapshot — 빈 rows·잘못된 형태는 던진다', () => {
  assert.throws(() => snapshot({ grid: GRID, rows: [] }), /rows/);
  assert.throws(() => snapshot(null), /grid/);
});

test('snapshot — gap = ratio − neutral 이 결과 안에서 자기정합', () => {
  const snap = snapshot(oneRow(REAL));
  for (const it of snap.weights) {
    if (it.gap == null) continue;
    near(it.gap, Math.round((it.ratio - it.neutral) * 100) / 100, 1e-9);
  }
});

// ── 실데이터 구조 스모크 (값 앵커 아님) ──────────────────────────────────────
test('실데이터 data/ktb-curve.js — 8노드가 grid 에 있고 스냅샷이 구성된다', (t) => {
  const p = fileURLToPath(new URL('../data/ktb-curve.js', import.meta.url));
  if (!existsSync(p)) return t.skip('data/ktb-curve.js 없음');
  const g = { window: {} };
  new Function('window', readFileSync(p, 'utf8'))(g.window);
  const curve = g.window.KTB_CURVE;
  assert.ok(curve && curve.rows.length > 0, 'KTB_CURVE 비어 있음');

  const snap = snapshot(curve);
  assert.equal(snap.date, curve.rows[curve.rows.length - 1][0]);
  assert.equal(snap.weights.length, 6);
  assert.equal(snap.slopes.length, 7);
  assert.equal(snap.window, Math.min(WINDOW, curve.rows.length));
  for (const n of NODES) assert.ok(Number.isFinite(snap.nodes[n]), `${n}Y 최신값 결측`);
  for (const it of snap.slopes) assert.ok(Number.isFinite(it.slope), `${it.key} slope 결측`);

  // gap 은 실데이터에서 tight 로 빠질 수 있다. 2026-08-11 커브가 실제로 그렇다 —
  // 20Y 4.630 / 50Y 4.596 으로 역전되어 20↔50 스프레드가 −3.4bp(<5bp)라 20-30-50 이
  // tight 다. 커브의 성질이지 결함이 아니므로, 여기서는 flag 어휘와 flag 없는 조합의
  // 산출만 고정하고 값·조합 개수는 커브에 맡긴다(실데이터 값 앵커 금지).
  for (const it of snap.weights) {
    assert.ok([null, 'tight', 'missing'].includes(it.flag), `${it.key} 예상 밖 flag ${it.flag}`);
    if (it.flag === null) assert.ok(Number.isFinite(it.gap), `${it.key} gap 결측`);
    if (it.flag !== 'missing') assert.ok(Number.isFinite(it.neutral), `${it.key} neutral 결측`);
  }
});
