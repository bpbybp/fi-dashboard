// rv-curves.test.mjs — CV-1 섹터 커브 순수 계산 테스트. 실행: node --test (인자 없이 자동탐색)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCurveAtIndex, resolveGhostIndex } from '../js/rv-curves.js';

// ── 픽스처 ──
// 노드 3개(1/3/10년). idx 방향으로 값 변화. 국고=레벨(%), 섹터=스프레드(%p).
function fixture() {
  return {
    meta: { sectors: ['국고채권', '회사채AA-'], maturities: ['1년', '3년', '10년'], nodes: [1, 3, 10] },
    dates: Array.from({ length: 70 }, (_, i) => `d${i}`),
    series: {
      '국고채권_1년': fill(70, (i) => 3.0 + i * 0.001),
      '국고채권_3년': fill(70, (i) => 3.5 + i * 0.001),
      '국고채권_10년': fill(70, (i) => 3.8 + i * 0.001),
      '회사채AA-_1년': fill(70, () => 0.500),
      '회사채AA-_3년': fill(70, () => 0.702),
      '회사채AA-_10년': fill(70, () => 0.900),
    },
  };
}
function fill(n, f) { return Array.from({ length: n }, (_, i) => f(i)); }
const LAST = 69;

test('1) yield 합성 항등식: 섹터 y = 국고 y + 스프레드×1', () => {
  const d = fixture();
  const ktb = buildCurveAtIndex(d, '국고채권', LAST, 'yield');
  const sec = buildCurveAtIndex(d, '회사채AA-', LAST, 'yield');
  const spRaw = [0.500, 0.702, 0.900];
  assert.equal(sec.y.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.ok(Math.abs(sec.y[i] - (ktb.y[i] + spRaw[i])) < 1e-9, `node ${i}`);
  }
});

test('2) null 노드 처리: 국고 또는 스프레드가 null인 노드는 x/y 모두 제외', () => {
  const d = fixture();
  d.series['국고채권_3년'][LAST] = null;   // 국고 결측 → 3년 노드 제외
  d.series['회사채AA-_10년'][LAST] = null; // 스프레드 결측 → 10년 노드 제외
  const sec = buildCurveAtIndex(d, '회사채AA-', LAST, 'yield');
  assert.deepEqual(sec.x, [1]); // 1년만 생존
  assert.equal(sec.y.length, 1);
});

test('3) spread 모드 단위: 0.702(%p) → 70.2(bp)', () => {
  const d = fixture();
  const sec = buildCurveAtIndex(d, '회사채AA-', LAST, 'spread');
  assert.deepEqual(sec.x, [1, 3, 10]);
  assert.ok(Math.abs(sec.y[1] - 70.2) < 1e-9);
  assert.ok(Math.abs(sec.y[0] - 50.0) < 1e-9);
});

test('4) 국고 sector + spread 모드 → 빈 배열', () => {
  const d = fixture();
  const ktb = buildCurveAtIndex(d, '국고채권', LAST, 'spread');
  assert.deepEqual(ktb.x, []);
  assert.deepEqual(ktb.y, []);
});

test('5) resolveGhostIndex: 정상 오프셋 / 범위 초과 시 null', () => {
  const dates = Array.from({ length: 70 }, (_, i) => `d${i}`);
  assert.equal(resolveGhostIndex(dates, 21), 48); // 69 - 21
  assert.equal(resolveGhostIndex(dates, 63), 6);  // 69 - 63
  assert.equal(resolveGhostIndex(dates, 0), 69);  // 최신
  assert.equal(resolveGhostIndex(dates, 70), null); // 범위 초과(-1)
  assert.equal(resolveGhostIndex(dates, 100), null);
});
