// cv-matrix.test.mjs — CV-3 스프레드 변화 매트릭스 순수 계산 테스트. 실행: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChangeMatrix, cellAlphaPct, CV3_HORIZONS } from '../js/cv-matrix.js';

// ── 픽스처 ── 날짜 30개. 국고=레벨, 크레딧 2개 섹터 × 만기 2개 = 스프레드(%p).
function fill(n, f) { return Array.from({ length: n }, (_, i) => f(i)); }
function fixture() {
  return {
    meta: {
      sectors: ['국고채권', '회사채AA-', '여전채A+'],
      maturities: ['1년', '3년'],
      nodes: [1, 3],
    },
    dates: Array.from({ length: 30 }, (_, i) => `d${i}`),
    series: {
      '국고채권_1년': fill(30, () => 3.0),
      '국고채권_3년': fill(30, () => 3.5),
      // 회사채AA-: 1년 +0.001%p/일(= +0.1bp/일) 선형 확대, 3년 고정
      '회사채AA-_1년': fill(30, (i) => 0.500 + i * 0.001),
      '회사채AA-_3년': fill(30, () => 0.700),
      // 여전채A+: 1년 −0.002%p/일 축소, 3년은 최신값 결측
      '여전채A+_1년': fill(30, (i) => 0.900 - i * 0.002),
      '여전채A+_3년': fill(30, (i) => (i === 29 ? null : 0.950)),
    },
  };
}

test('1) Δ 계산: %p → bp, 현재 − h영업일 전', () => {
  const M = buildChangeMatrix(fixture(), 5);
  // 회사채AA- 1년: 5일 × 0.1bp = +0.5bp
  assert.equal(M.cells[0][0], 0.5);
  // 회사채AA- 3년: 변화 없음 = 0
  assert.equal(M.cells[0][1], 0);
  // 여전채A+ 1년: 5일 × −0.2bp = −1.0bp
  assert.equal(M.cells[1][0], -1);
});

test('2) 국고채권 행 제외 (레벨 시리즈는 스프레드가 아니다)', () => {
  const M = buildChangeMatrix(fixture(), 5);
  assert.deepEqual(M.sectors, ['회사채AA-', '여전채A+']);
});

test('3) 결측 처리: 현재 또는 과거가 null 이면 셀 null', () => {
  const M = buildChangeMatrix(fixture(), 5);
  assert.equal(M.cells[1][1], null); // 여전채A+ 3년 최신 결측
});

test('4) maxAbs = 매트릭스 전체 |Δ| 최대 · 기준일 표기', () => {
  const M = buildChangeMatrix(fixture(), 5);
  assert.equal(M.maxAbs, 1); // |−1.0| 이 최대
  assert.equal(M.asof, 'd29');
  assert.equal(M.baseDate, 'd24');
});

test('5) 이력 부족(과거 인덱스 음수)이면 null 반환', () => {
  assert.equal(buildChangeMatrix(fixture(), 30), null);
  assert.notEqual(buildChangeMatrix(fixture(), 29), null); // 정확히 첫 행까지는 허용
});

test('6) cellAlphaPct: 0 중심 · 최소 6 · 상한 78 · max 비례', () => {
  assert.equal(cellAlphaPct(0, 10), 0);
  assert.equal(cellAlphaPct(null, 10), 0);
  assert.equal(cellAlphaPct(5, 0), 0);          // max=0 방어
  assert.equal(cellAlphaPct(10, 10), 78);       // 최대 셀
  assert.equal(cellAlphaPct(-10, 10), 78);      // 부호 무관 크기
  assert.equal(cellAlphaPct(0.1, 100), 6);      // 바닥값
  assert.equal(cellAlphaPct(5, 10), 39);        // 비례
});

test('7) 호라이즌 상수: 1주/1개월/3개월 = 5/20/60 영업일', () => {
  assert.deepEqual(CV3_HORIZONS.map((h) => h.biz), [5, 20, 60]);
});
