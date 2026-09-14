// js/freshness.js 순수 함수 테스트 — 월말·연초 경계 포함.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness, expectedPeriod, todayKst } from '../js/freshness.js';

const D15 = { releaseDay: 15 };
const EOM = { releaseDay: 'eom' };

test('발표일 전날/당일 경계 (D=15)', () => {
  assert.equal(expectedPeriod(D15, '2026-09-14'), '2026-07');
  assert.equal(expectedPeriod(D15, '2026-09-15'), '2026-08');
});

test('말일 캐던스: 30일/31일/2월 윤년·평년', () => {
  assert.equal(expectedPeriod(EOM, '2026-09-29'), '2026-07');
  assert.equal(expectedPeriod(EOM, '2026-09-30'), '2026-08');
  assert.equal(expectedPeriod(EOM, '2026-10-30'), '2026-08');
  assert.equal(expectedPeriod(EOM, '2026-10-31'), '2026-09');
  assert.equal(expectedPeriod(EOM, '2028-02-28'), '2027-12');
  assert.equal(expectedPeriod(EOM, '2028-02-29'), '2028-01');
  assert.equal(expectedPeriod(EOM, '2027-02-28'), '2027-01');
});

test('연초 경계: 1월에 전년 11·12월로 넘어감', () => {
  const KR = { releaseDay: 5 };
  assert.equal(expectedPeriod(KR, '2027-01-04'), '2026-11');
  assert.equal(expectedPeriod(KR, '2027-01-05'), '2026-12');
  assert.equal(expectedPeriod(KR, '2027-02-01'), '2026-12');
  assert.equal(freshness('2026-11', null, KR, '2027-01-05').lagMonths, 1);
  assert.equal(freshness('2026-10', null, KR, '2027-01-04').lagMonths, 1);
  assert.equal(freshness('2026-12', null, KR, '2027-01-05').lagMonths, 0);
});

test('freshness: 기준월·갱신일 포맷, 지연 개월', () => {
  // run #5 상황: 2026-09-15, KR 7월분에서 멈춤 → 지연 1개월
  assert.deepEqual(freshness('2026-07', '2026-08-12', { releaseDay: 5 }, '2026-09-15'),
    { period: '2026-07', updated: '08-12', lagMonths: 1 });
  // US-PCE 7월분, 8월분은 9월 말 → 지연 0
  assert.deepEqual(freshness('2026-07', '2026-09-12', EOM, '2026-09-15'),
    { period: '2026-07', updated: '09-12', lagMonths: 0 });
});

test('실제 기준월이 기대보다 앞서면 음수 대신 0', () => {
  assert.equal(freshness('2026-08', null, { releaseDay: 19 }, '2026-09-15').lagMonths, 0);
});

test('입력 부재·비정상: null 반환, 기준월 형식(YYYY-MM) 갱신일은 무시', () => {
  assert.deepEqual(freshness(null, null, D15, '2026-09-15'), { period: null, updated: null, lagMonths: null });
  assert.equal(freshness('2026-08', '2026-08', D15, '2026-09-15').updated, null);
  assert.equal(freshness('2026-08', null, null, '2026-09-15').lagMonths, null);
});

test('todayKst: UTC 21:00은 KST 익일', () => {
  assert.equal(todayKst(new Date(Date.UTC(2026, 11, 31, 21, 0))), '2027-01-01');
  assert.equal(todayKst(new Date(Date.UTC(2026, 8, 14, 14, 59))), '2026-09-14');
});
