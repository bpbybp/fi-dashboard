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
import { getConfig } from '../js/series-config.js';

// 실제 저장 이력(data/kr-cpi-headline.js, 1965-01~2026-06) — 자기등록 스크립트를 vm으로 로드.
const AS_OF = '2026-06';
function loadStored(id) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(new URL(`../data/${id}.js`, import.meta.url), 'utf8'), ctx);
  // 2026-06 시점으로 고정 — 이후 data 갱신(07·08월 추가 등)과 무관하게 같은 입력.
  return ctx.window.FENRIR_SERIES[id].series.filter((p) => p.period <= AS_OF);
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

// rows: 점 배열(총지수 한 행) 또는 [{ account, points }] — 모든 행이 첫 행의 기간 컬럼을 쓴다.
function kosisCsv(rows) {
  if (!Array.isArray(rows[0]?.points)) rows = [{ account: '총지수', points: rows }];
  const head = ['통계표', '계정항목', '단위', '가중치', '변환', ...rows[0].points.map((p) => p.period.replace('-', '/'))];
  const body = rows.map(({ account, points }) =>
    ['4.2.1. 소비자물가지수', account, '2020=100', '1000', '원자료', ...points.map((p) => String(p.value))]);
  return [head, ...body].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n');
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
  assert.deepEqual(warnings.filter((w) => w.kind === 'revision').map((w) => w.period), ['2026-06']);
  const ov = warnings.filter((w) => w.kind === 'overlap');
  assert.equal(ov.length, 1);
  assert.equal(ov[0].overlap, 1);
  assert.match(ov[0].message, /겹침 1개월.*기준년 변경 판정 불가/);
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

test('e) ×0.85 후 소수 둘째 자리 반올림(KOSIS 표기) → 기준년 개편으로 감지', () => {
  const rebased = uploadFrom('2025-06', '2026-06', NEW_MONTHS).map((p) => ({ ...p, value: Math.round(p.value * 0.85 * 100) / 100 }));
  assert.throws(() => mergeSeries(EXISTING, rebased), /기준년 변경 의심/);
});

test('e) 둘째 자리 반올림 노이즈가 섞인 미세 비율(×0.998, 차이 < 0.3pt)도 일정 비율로 감지', () => {
  const scaled = uploadFrom('2025-06', '2026-06').map((p) => ({ ...p, value: Math.round(p.value * 0.998 * 100) / 100 }));
  assert.ok(scaled.every((p) => Math.abs(p.value - valueAt(EXISTING, p.period)) < 0.3));
  assert.throws(() => mergeSeries(EXISTING, scaled), /기준년 변경 의심/);
});

// ── 공백·겹침 ───────────────────────────────────────────────────────────

test('공백 — 업로드 시작월 > 기존 마지막 달 + 1 → "YYYY-MM~YYYY-MM 누락"', () => {
  assert.throws(() => mergeSeries(EXISTING, [{ period: '2026-09', value: 121 }]), /2026-07~2026-08 누락/);
  assert.throws(() => mergeSeries(EXISTING, [{ period: '2026-08', value: 121 }]), /2026-07~2026-07 누락/);
});

test('공백 — 업로드 내부에 빠진 달이 있어도 누락으로 중단', () => {
  const upload = [{ period: '2026-07', value: 120.3 }, { period: '2026-09', value: 120.6 }];
  assert.throws(() => mergeSeries(EXISTING, upload), /2026-08~2026-08 누락/);
});

test('겹침 0개월(기존 마지막 달 +1 부터) — 병합 허용 + "겹침 없음, 기준년 변경 판정 불가" 경고', () => {
  const { series, warnings } = mergeSeries(EXISTING, NEW_MONTHS);
  assert.equal(series.length, 740);
  const ov = warnings.filter((w) => w.kind === 'overlap');
  assert.equal(ov.length, 1);
  assert.equal(ov[0].overlap, 0);
  assert.match(ov[0].message, /겹침 없음, 기준년 변경 판정 불가/);
});

test('겹침 2개월 이상이면 겹침 부족 경고는 없다', () => {
  const { warnings } = mergeSeries(EXISTING, uploadFrom('2026-05', '2026-06', NEW_MONTHS));
  assert.equal(warnings.filter((w) => w.kind === 'overlap').length, 0);
});

// ── 시리즈별 독립 ───────────────────────────────────────────────────────

test('시리즈별 독립 — 한 CSV 의 총지수/근원/생활물가 행이 각자 자기 data 파일과만 병합', () => {
  const cases = [['kr-cpi-headline', '총지수', 0.11], ['kr-cpi-core', '식료품 및 에너지제외 지수', 0.22], ['kr-cpi-lifecost', '생활물가지수', 0.33]];
  const stored = Object.fromEntries(cases.map(([id]) => [id, loadStored(id)]));
  const rows = cases.map(([id, account, bump]) => ({
    account,
    points: [...stored[id].filter((p) => p.period >= '2025-06'), { period: '2026-07', value: stored[id].at(-1).value + bump }],
  }));
  const parsed = parseKosisCsv(kosisCsv(rows));

  for (const [id, , bump] of cases) {
    const row = matchRow(parsed, getConfig(id).kosis_hint);
    const { series, stats } = mergeSeries(stored[id], row.points);
    assert.equal(series[0].period, stored[id][0].period, id);
    assert.equal(series.length, stored[id].length + 1, id);
    assert.equal(stats.revised, 0, id); // 남의 행이 섞였다면 개정·개편으로 드러난다
    assert.ok(Math.abs(valueAt(series, '2026-07') - (stored[id].at(-1).value + bump)) < 1e-9, id);
  }
  // 반대 증명: 총지수 행을 근원 이력에 붙이면 막힌다.
  const headRow = matchRow(parsed, getConfig('kr-cpi-headline').kosis_hint);
  assert.throws(() => mergeSeries(stored['kr-cpi-core'], headRow.points), /기준년 변경 의심/);
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
  assert.deepEqual(warnings.map((w) => [w.kind, w.period]), [['revision', '2026-03']]);
  assert.ok(Math.abs(stats.maxRevision - 0.4) < 1e-9);
});

test('f) 개정이 없으면 revisions·warnings 는 빈 배열, maxRevision = 0', () => {
  // 겹침 2개월(동일 값) — 겹침 부족 경고도 없는 정상 케이스.
  const { revisions, warnings, stats } = mergeSeries(EXISTING, uploadFrom('2026-05', '2026-06', NEW_MONTHS));
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
  // `data/${id}.js` 리터럴 또는 DATA_DIR = 'data' 상수 경유 `${DATA_DIR}/${id}.js`.
  const direct = /data\/\$\{[^}]+\}\.js/.test(ADMIN_SRC);
  const viaConst = /const DATA_DIR = 'data';/.test(ADMIN_SRC) && /\$\{DATA_DIR\}\/\$\{[^}]+\}\.js/.test(ADMIN_SRC);
  assert.ok(direct || viaConst);
  assert.match(ADMIN_SRC, /getSeriesData\(/);
});
