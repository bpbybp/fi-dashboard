// CS-1 화면 통계·행구성 테스트 — node --test (인자 없이 자동탐색).
//
// 초점은 범위 바 산술이다. 이 화면의 유일한 시각 요소가 "현위치 마커가 막대 어디에 찍히나"이고,
// 그게 틀리면 화면 전체가 조용히 거짓말을 한다(숫자는 맞는데 눈으로 읽는 위치가 틀린다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Z_MIN_PERIODS, Z_WINDOW,
  cellStats, lastValidIndex, markerPct, rangeOf, ytdStartIndex, zAt,
} from '../js/cs1/cs1-stats.js';
import { buildRows } from '../js/cs1/cs1-ui.js';

// ── 범위 바 위치 산술 ─────────────────────────────────────────────────────────

test('범위 바 — 현위치는 min 0% · max 100% · 중앙 50%', () => {
  assert.equal(markerPct(10, 10, 30), 0, 'min 이면 왼쪽 끝');
  assert.equal(markerPct(30, 10, 30), 100, 'max 면 오른쪽 끝');
  assert.equal(markerPct(20, 10, 30), 50, '한가운데');
  assert.equal(markerPct(15, 10, 30), 25);
  assert.equal(markerPct(25, 10, 30), 75);
});

test('범위 바 — 음수 구간에서도 선형 위치', () => {
  assert.equal(markerPct(-20, -30, -10), 50);
  assert.equal(markerPct(0, -10, 10), 50);
  assert.equal(markerPct(-10, -10, 10), 0);
  assert.equal(markerPct(5, -10, 10), 75);
});

test('범위 바 — min===max 면 가운데, 값·범위 없으면 마커 없음', () => {
  assert.equal(markerPct(7, 7, 7), 50, '구간 내내 한 값이면 눈금이 없다');
  assert.equal(markerPct(null, 10, 30), null);
  assert.equal(markerPct(20, null, 30), null);
  assert.equal(markerPct(20, 10, null), null);
  assert.equal(markerPct(NaN, 10, 30), null);
});

test('범위 바 — 구간 밖 값은 0~100 으로 클램프된다', () => {
  assert.equal(markerPct(5, 10, 30), 0);
  assert.equal(markerPct(99, 10, 30), 100);
});

// ── 범위·결측 ────────────────────────────────────────────────────────────────

test('rangeOf — 결측을 건너뛰고 유효 관측만 센다', () => {
  assert.deepEqual(rangeOf([3, null, 1, 9, null], 0, 4), { min: 1, max: 9, n: 3 });
  assert.deepEqual(rangeOf([null, null], 0, 1), { min: null, max: null, n: 0 });
  assert.deepEqual(rangeOf([5, 2, 8], 1, 1), { min: 2, max: 2, n: 1 }, '한 점 구간');
});

test('rangeOf — 구간 경계가 배열 밖이어도 잘라서 처리한다', () => {
  assert.deepEqual(rangeOf([4, 6], -50, 999), { min: 4, max: 6, n: 2 });
});

test('lastValidIndex — 뒤에서부터 첫 비null', () => {
  assert.equal(lastValidIndex([1, 2, null, null]), 1);
  assert.equal(lastValidIndex([1, 2, 3], 1), 2 - 1);
  assert.equal(lastValidIndex([null, null]), -1);
  assert.equal(lastValidIndex([]), -1);
});

test('ytdStartIndex — 최종일과 같은 해의 첫 인덱스', () => {
  const d = ['2024-12-30', '2024-12-31', '2025-01-02', '2025-01-03', '2025-06-02'];
  assert.equal(ytdStartIndex(d), 2, '2025 첫 영업일');
  assert.equal(ytdStartIndex(d, 1), 0, '기준을 2024 로 잡으면 2024 첫 인덱스');
  assert.equal(ytdStartIndex(['2025-03-03']), 0);
  assert.equal(ytdStartIndex([]), 0);
});

test('ytdStartIndex — 해가 막 바뀌면 표본이 하루뿐이어도 작년을 끌어오지 않는다', () => {
  const d = ['2025-12-29', '2025-12-30', '2026-01-02'];
  assert.equal(ytdStartIndex(d), 2);
});

// ── z250 (msb-ktb rollingZ 규칙 복제본) ───────────────────────────────────────

test('z250 — 표본 부족이면 null', () => {
  const short = Array.from({ length: Z_MIN_PERIODS - 1 }, (_, i) => i);
  assert.equal(zAt(short, short.length - 1), null);
});

test('z250 — σ=0(전 구간 동일값)이면 null', () => {
  const flat = new Array(Z_WINDOW).fill(5);
  assert.equal(zAt(flat, flat.length - 1), null);
});

test('z250 — 표본표준편차(ddof=1) 기준', () => {
  // 창을 좁혀 손계산과 대조: [1,2,3,4,10] 평균 4, 표본분산 ((9+4+1+0+36)/4)=12.5, sd≈3.5355
  const v = [1, 2, 3, 4, 10];
  const z = zAt(v, 4, { window: 5, minPeriods: 3 });
  assert.ok(Math.abs(z - (10 - 4) / Math.sqrt(12.5)) < 1e-12);
});

test('z250 — 창 안 결측은 표본에서 빠지고, 현재값이 결측이면 null', () => {
  const v = [1, null, 2, 3, 4, 10];
  const a = zAt(v, 5, { window: 6, minPeriods: 3 });
  const b = zAt([1, 2, 3, 4, 10], 4, { window: 5, minPeriods: 3 });
  assert.ok(Math.abs(a - b) < 1e-12, '결측을 뺀 표본은 동일해야 한다');
  assert.equal(zAt([1, 2, 3, null], 3, { window: 4, minPeriods: 2 }), null);
});

// ── 셀 전체 ──────────────────────────────────────────────────────────────────

test('cellStats — 현재값·전일 Δ·YTD·250일 범위를 한 번에', () => {
  const dates = ['2025-12-30', '2025-12-31', '2026-01-02', '2026-01-05', '2026-01-06'];
  const values = [50, 60, 10, 30, 20];
  const s = cellStats(values, dates, { window: 3 });
  assert.equal(s.value, 20);
  assert.equal(s.delta, -10, '30 → 20');
  assert.deepEqual(s.ytd, { min: 10, max: 30, n: 3 }, '2026 구간만');
  assert.equal(s.ytdPct, 50, '20 은 10–30 의 한가운데');
  assert.deepEqual(s.win, { min: 10, max: 30, n: 3 }, '창 3일');
  assert.equal(s.asofIdx, 4);
});

test('cellStats — 최종일이 결측이면 그 이전 최근 관측을 쓴다', () => {
  const dates = ['2026-01-02', '2026-01-05', '2026-01-06'];
  const s = cellStats([10, 25, null], dates);
  assert.equal(s.value, 25);
  assert.equal(s.asofIdx, 1, '기준 인덱스도 그 날로 물러난다');
  assert.equal(s.delta, 15);
});

test('cellStats — 전일 Δ 는 직전 유효 관측 기준(결측일을 건너뛴다)', () => {
  const dates = ['2026-01-02', '2026-01-05', '2026-01-06'];
  const s = cellStats([10, null, 12], dates);
  assert.equal(s.delta, 2, '결측일을 건너뛴 직전 관측 10 과 비교');
});

test('cellStats — 관측이 하나도 없으면 전부 빈 값', () => {
  const s = cellStats([null, null], ['2026-01-02', '2026-01-05']);
  assert.equal(s.value, null);
  assert.equal(s.delta, null);
  assert.equal(s.ytdPct, null);
  assert.equal(s.z, null);
  assert.equal(s.asofIdx, -1);
  assert.deepEqual(s.ytd, { min: null, max: null, n: 0 });
});

test('cellStats — 빈 배열·비배열도 죽지 않는다', () => {
  assert.equal(cellStats([], []).value, null);
  assert.equal(cellStats(undefined, []).value, null);
});

test('cellStats — 전일 Δ 는 0.1bp 격자로 정리된다', () => {
  const s = cellStats([10.1, 10.3], ['2026-01-02', '2026-01-05']);
  assert.equal(s.delta, 0.2, '부동소수 잔여(0.19999…)가 남지 않아야 한다');
});

// ── 행 구성 ──────────────────────────────────────────────────────────────────

const META = {
  benchmark: '국고채권',
  tenors: ['1년', '3년'],
  seriesOrder: [
    '산금채AAA_vs_국고채권', '중금채AAA_vs_국고채권', '공사채AAA_vs_국고채권',
    '은행채AAA_vs_국고채권', '회사채AA-_vs_국고채권',
    '산금채AAA_vs_은행채AAA', '은행채AAA_vs_공사채AAA',
  ],
};

test('행 구성 — 상단 고정 4행이 지정 순서로 온다', () => {
  const rows = buildRows(META);
  assert.deepEqual(rows.pinned.map((r) => r.label), ['산금채AAA', '중금채AAA', '은행채AAA', '공사채AAA']);
  assert.ok(rows.pinned.every((r) => r.sub === 'vs 국고채권'));
});

test('행 구성 — 섹터 간 행은 X − Y 로 표기된다', () => {
  const rows = buildRows(META);
  assert.deepEqual(rows.cross.map((r) => r.label), ['산금채AAA − 은행채AAA', '은행채AAA − 공사채AAA']);
});

test('행 구성 — 나머지는 고정행을 뺀 vs-국고 전부이고 중복이 없다', () => {
  const rows = buildRows(META);
  assert.deepEqual(rows.rest.map((r) => r.label), ['회사채AA-']);
  const all = [...rows.pinned, ...rows.cross, ...rows.rest].map((r) => r.id);
  assert.equal(new Set(all).size, all.length, '행이 두 묶음에 겹쳐 들어가지 않는다');
  assert.equal(all.length, META.seriesOrder.length, '모든 페어가 정확히 한 번씩 나온다');
});

test('행 구성 — 고정 대상이 소스에 없으면 조용히 건너뛴다', () => {
  const rows = buildRows({ ...META, seriesOrder: ['은행채AAA_vs_국고채권'] });
  assert.deepEqual(rows.pinned.map((r) => r.label), ['은행채AAA']);
  assert.deepEqual(rows.rest, []);
  assert.deepEqual(rows.cross, []);
});

test('행 구성 — 하이픈이 든 섹터명(회사채AA-)이 잘리지 않는다', () => {
  const rows = buildRows({ ...META, seriesOrder: ['회사채AA-_vs_국고채권', '회사채AA-_vs_은행채AAA'] });
  assert.equal(rows.rest[0].label, '회사채AA-');
  assert.equal(rows.cross[0].label, '회사채AA- − 은행채AAA');
});
