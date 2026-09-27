// series-merge 단위 테스트 — node --test (인자 없이 자동탐색).
//
// 초점: **저장된 이력이 기준, 업로드는 증분**. admin CPI 갱신이 업로드 CSV만으로
// data/{id}.js 를 재생성해 장기 이력을 15개월로 대체하던 사고(Phase 0 보고)의 재발 방지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { mergeSeries, normalizeMonthKey, REVISION_WARN_PT } from '../js/series-merge.js';
import { parseKosisCsv, matchRow } from '../js/csv-parse.js';

// 실제 저장 이력(data/kr-cpi-headline.js, 1965-01~2026-06) — 자기등록 스크립트를 vm으로 로드.
function loadStored(id) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(new URL(`../data/${id}.js`, import.meta.url), 'utf8'), ctx);
  return ctx.window.FENRIR_SERIES[id].series;
}
const EXISTING = loadStored('kr-cpi-headline');
const valueAt = (series, period) => series.find((p) => p.period === period)?.value;

// 기존 값을 그대로 복사한 업로드 구간 [from, to] + 신규 달.
function uploadFrom(from, to, extra = []) {
  return [...EXISTING.filter((p) => p.period >= from && p.period <= to).map((p) => ({ ...p })), ...extra];
}
const NEW_MONTHS = [{ period: '2026-07', value: 120.31 }, { period: '2026-08', value: 120.52 }];

// ── 전제: 저장 이력 ─────────────────────────────────────────────────────

test('전제 — 저장 이력은 1965-01~2026-06 (738개월)', () => {
  assert.equal(EXISTING.length, 738);
  assert.equal(EXISTING[0].period, '1965-01');
  assert.equal(EXISTING.at(-1).period, '2026-06');
});

// ── 특성 테스트: 현재 동작(업로드 = 대체) 고정 ─────────────────────────
// admin-ui.js selectedSeries()(:78-81)는 matchRow 결과의 points 를 그대로 calc/export 에 넘긴다.
// 즉 admin 이 쓰는 시계열 = CSV 에 들어 있는 달뿐. 이 테스트는 그 입력 경로를 고정한다.

function kosisCsv(points) {
  const head = ['통계표', '계정항목', '단위', '가중치', '변환', ...points.map((p) => p.period.replace('-', '/'))];
  const row = ['4.2.1. 소비자물가지수', '총지수', '2020=100', '1000', '원자료', ...points.map((p) => String(p.value))];
  return [head, row].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
}

test('특성 — 2025-06~2026-08 CSV 의 매칭 행은 15개월뿐(기존 이력 없음)', () => {
  const upload = uploadFrom('2025-06', '2026-06', NEW_MONTHS);
  const row = matchRow(parseKosisCsv(kosisCsv(upload)), { account: '총지수', transform: '원자료' });
  assert.equal(row.points.length, 15);
  assert.equal(row.points[0].period, '2025-06');
  assert.equal(row.points.at(-1).period, '2026-08');
});

// ── a) 기본 병합 ────────────────────────────────────────────────────────

test('a) 기존 1965-01~2026-06 + 업로드 2025-06~2026-08 → 1965-01~2026-08, 겹치는 달은 업로드 값', () => {
  const upload = uploadFrom('2025-06', '2026-06', NEW_MONTHS);
  const revisedValue = valueAt(EXISTING, '2026-05') + 0.05;
  upload.find((p) => p.period === '2026-05').value = revisedValue;

  const { series, stats } = mergeSeries(EXISTING, upload);

  assert.equal(series.length, 740);
  assert.equal(series[0].period, '1965-01');
  assert.equal(series.at(-1).period, '2026-08');
  assert.equal(valueAt(series, '2026-05'), revisedValue);
  assert.equal(valueAt(series, '2026-07'), 120.31);
  assert.equal(valueAt(series, '2026-08'), 120.52);
  assert.deepEqual(
    { kept: stats.kept, added: stats.added, revised: stats.revised },
    { kept: 737, added: 2, revised: 1 },
  );
});

test('a) 결과는 월 오름차순·월 키 유일, 입력은 변형하지 않는다', () => {
  const before = JSON.stringify(EXISTING);
  const upload = uploadFrom('2025-06', '2026-06', NEW_MONTHS);
  const { series } = mergeSeries(EXISTING, upload);
  const periods = series.map((p) => p.period);
  assert.deepEqual(periods, [...new Set(periods)].sort());
  assert.equal(JSON.stringify(EXISTING), before);
});

test('a) stats 불변식 — kept + revised = 기존 개월 수, + added = 결과 개월 수', () => {
  const { series, stats } = mergeSeries(EXISTING, uploadFrom('2025-06', '2026-06', NEW_MONTHS));
  assert.equal(stats.kept + stats.revised, EXISTING.length);
  assert.equal(stats.kept + stats.revised + stats.added, series.length);
});

// ── b) 짧은 업로드 ──────────────────────────────────────────────────────

test('b) 업로드가 신규 1개월뿐이어도 과거 이력 전부 보존', () => {
  const { series, stats } = mergeSeries(EXISTING, [NEW_MONTHS[0]]);
  assert.equal(series.length, 739);
  assert.equal(valueAt(series, '1965-01'), valueAt(EXISTING, '1965-01'));
  assert.equal(valueAt(series, '2026-06'), valueAt(EXISTING, '2026-06'));
  assert.deepEqual({ kept: stats.kept, added: stats.added, revised: stats.revised }, { kept: 738, added: 1, revised: 0 });
});

// ── c) 축소 가드 ────────────────────────────────────────────────────────

test('c) 병합 결과 개월 수 < 기존 개월 수 → 에러로 중단', () => {
  // 기존 파일에 같은 달이 표기만 달리 두 번씩 들어 있으면 정규화 후 개월 수가 줄어든다.
  const corrupt = [...EXISTING, { period: '2026/06', value: 119.99 }, { period: '2026.05', value: 119.5 }];
  assert.throws(() => mergeSeries(corrupt, [NEW_MONTHS[0]]), /개월 수/);
});

test('c) 기존 이력이 없거나 비면(로드 실패) 병합하지 않는다 — CSV 단독 진행 금지', () => {
  for (const bad of [null, undefined, []]) {
    assert.throws(() => mergeSeries(bad, NEW_MONTHS), /기존 이력/);
  }
});

// ── d) 월 키 정규화 ─────────────────────────────────────────────────────

test('d) 월 키 정규화 — YYYY-MM', () => {
  for (const raw of ['2026-07', '2026-7', '2026/07', '2026/7', '2026.07', ' 2026.7 ']) {
    assert.equal(normalizeMonthKey(raw), '2026-07', raw);
  }
});

test('d) 해석 불가 월 키는 조용히 버리지 않고 던진다', () => {
  for (const raw of ['2026-13', '2026-00', 'abc', '', '26-07']) {
    assert.throws(() => normalizeMonthKey(raw), /월/, raw);
  }
  assert.throws(() => mergeSeries(EXISTING, [{ period: '2026-13', value: 1 }]), /2026-13/);
});

test('d) 표기가 다른 업로드 키도 같은 달로 병합, 업로드 내 중복 월은 마지막 값', () => {
  const upload = [
    { period: '2026/7', value: 120.1 },
    { period: '2026.07', value: 120.3 },
    { period: '2026-8', value: 120.5 },
  ];
  const { series, stats } = mergeSeries(EXISTING, upload);
  assert.equal(series.length, 740);
  assert.equal(valueAt(series, '2026-07'), 120.3);
  assert.equal(valueAt(series, '2026-08'), 120.5);
  assert.equal(stats.added, 2);
});

// ── e) 기준년 개편 감지 ─────────────────────────────────────────────────

test('e) 겹치는 달 전체가 일정 비율(기준년 개편) → "기준년 변경 의심" 중단', () => {
  const rebased = uploadFrom('2025-06', '2026-06', NEW_MONTHS).map((p) => ({ ...p, value: +(p.value * 0.95).toFixed(3) }));
  assert.throws(() => mergeSeries(EXISTING, rebased), /기준년 변경 의심/);
});

test('e) 차이가 전부 0.3pt 미만이어도 비율이 거의 일정(≠1)하면 중단 — 비율 규칙 단독', () => {
  // ×0.998 → 120 부근에서 차이 ≈0.24pt < 0.3 이라 50% 규칙에는 안 걸린다.
  const scaled = uploadFrom('2025-06', '2026-06').map((p) => ({ ...p, value: +(p.value * 0.998).toFixed(3) }));
  assert.ok(scaled.every((p) => Math.abs(p.value - valueAt(EXISTING, p.period)) < 0.3));
  assert.throws(() => mergeSeries(EXISTING, scaled), /기준년 변경 의심/);
});

test('e) 겹침이 1개월뿐이면 개편 판정 없이 개별 개정으로 처리', () => {
  const upload = [{ period: '2026-06', value: valueAt(EXISTING, '2026-06') + 0.4 }, NEW_MONTHS[0]];
  const { stats, warnings } = mergeSeries(EXISTING, upload);
  assert.equal(stats.revised, 1);
  assert.deepEqual(warnings.map((w) => w.period), ['2026-06']);
});

test('e) 겹치는 달의 50% 이상이 |차이| > 0.3pt → "기준년 변경 의심" 중단', () => {
  // 2026-03~06 4개월 중 2개월(정확히 50%)만 비비례적으로 크게 다름.
  const upload = uploadFrom('2026-03', '2026-06');
  upload[0].value += 0.5;
  upload[2].value -= 0.4;
  assert.throws(() => mergeSeries(EXISTING, upload), /기준년 변경 의심/);
});

test('e) 겹치는 달 값이 모두 동일(비율 = 1 일정)은 개편이 아니다', () => {
  const { stats } = mergeSeries(EXISTING, uploadFrom('2025-06', '2026-06', NEW_MONTHS));
  assert.equal(stats.revised, 0);
});

// ── f) 개별 개정 ────────────────────────────────────────────────────────

test('f) 일부 달만 개정 → 반영 + revised 목록, |0.3pt| 초과는 경고', () => {
  const upload = uploadFrom('2025-06', '2026-06', NEW_MONTHS);
  const old03 = valueAt(EXISTING, '2026-03');
  const old04 = valueAt(EXISTING, '2026-04');
  upload.find((p) => p.period === '2026-03').value = old03 + 0.4;
  upload.find((p) => p.period === '2026-04').value = old04 + 0.1;

  const { series, stats, revisions, warnings } = mergeSeries(EXISTING, upload);

  assert.equal(valueAt(series, '2026-03'), old03 + 0.4); // 경고여도 값은 반영
  assert.equal(valueAt(series, '2026-04'), old04 + 0.1);
  assert.equal(stats.revised, 2);
  assert.deepEqual(revisions.map((r) => r.period), ['2026-03', '2026-04']);
  const r03 = revisions[0];
  assert.equal(r03.old, old03);
  assert.equal(r03.new, old03 + 0.4);
  assert.ok(Math.abs(r03.diff - 0.4) < 1e-9);
  assert.equal(REVISION_WARN_PT, 0.3);
  assert.deepEqual(warnings.map((w) => w.period), ['2026-03']);
  assert.ok(Math.abs(stats.maxRevision - 0.4) < 1e-9);
});

test('f) 개정이 없으면 revisions·warnings 는 빈 배열, maxRevision = 0', () => {
  const { revisions, warnings, stats } = mergeSeries(EXISTING, [NEW_MONTHS[0]]);
  assert.deepEqual(revisions, []);
  assert.deepEqual(warnings, []);
  assert.equal(stats.maxRevision, 0);
});

// ── admin 배선 (Phase 2 에서 Green) ─────────────────────────────────────
// admin-ui.js 는 DOM/Plotly 의존이라 직접 import 하지 않고 소스 배선만 고정한다.

const ADMIN_SRC = readFileSync(new URL('../js/admin-ui.js', import.meta.url), 'utf8');

test('admin — series-merge 를 import 하고 mergeSeries 를 호출한다', () => {
  assert.match(ADMIN_SRC, /from '\.\/series-merge\.js'/);
  assert.match(ADMIN_SRC, /mergeSeries\(/);
});

test('admin — 기존 이력을 data/{id}.js 에서 로드해 getSeriesData 로 읽는다', () => {
  assert.match(ADMIN_SRC, /data\/\$\{[^}]+\}\.js/);
  assert.match(ADMIN_SRC, /getSeriesData\(/);
});
