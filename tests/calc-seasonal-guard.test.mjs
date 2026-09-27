// calc 시즈널 가드 테스트 — node --test (인자 없이 자동탐색).
//
// 초점: 달력월 표본이 부족한 시즈널 전월비를 **조용히** 전망에 쓰지 않는다.
// 이전 동작: 표본 0개 달은 0% 로 대체, 표본 1~2개 달도 아무 표시 없이 평균 → admin 에
// 15개월만 들어간 사고에서 전망이 "작년 같은 달 복사"가 됐다(Phase 0 보고 §4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// namespace import — 신규 export(MIN_SEASONAL_SAMPLES)가 없어도 파일 전체가 아닌 해당 테스트만 실패.
import * as calc from '../js/calc.js';
const { seasonalAvgMM, buildForecast, computeMM, nextPeriod, MIN_SEASONAL_SAMPLES } = calc;
import * as usCalc from '../js/us-inflation-calc.js';
import * as nowcast from '../js/us-energy-nowcast.js';

function loadStored(id) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(new URL(`../data/${id}.js`, import.meta.url), 'utf8'), ctx);
  return ctx.window.FENRIR_SERIES[id].series;
}
const HEADLINE = loadStored('kr-cpi-headline');

// from 부터 n개월, 월별 m-m 값은 fn(period).
function mmRun(from, n, fn = () => 0.2) {
  const out = [];
  let p = from;
  for (let i = 0; i < n; i++) { out.push({ period: p, value: fn(p) }); p = nextPeriod(p); }
  return out;
}
const SCENARIO = { series_id: 'kr-cpi-headline', scenario_id: 'base', label: 'Base', mm_overrides: [] };
const META = { series_id: 'kr-cpi-headline', window_years: 10, notes: '', comparison_label: '' };

test('MIN_SEASONAL_SAMPLES = 3', () => {
  assert.equal(MIN_SEASONAL_SAMPLES, 3);
});

// ── g) 표본 0개 ─────────────────────────────────────────────────────────

test('g) 표본 0개인 달은 0% 로 대체하지 않는다 — value null + insufficient', () => {
  // m-m 이 2026-01~06 뿐 → 전망 07~12월은 표본 0개.
  const guide = seasonalAvgMM(mmRun('2026-01', 6), 10, '2026-06', 12);
  const jul = guide.find((g) => g.period === '2026-07');
  assert.equal(jul.samples, 0);
  assert.equal(jul.value, null);
  assert.equal(jul.insufficient, true);
});

test('g) buildForecast — 전망월 중 표본 0개가 있으면 던진다(0% 전망 금지)', () => {
  const idx = [];
  let v = 100;
  for (const p of mmRun('2026-01', 7)) { idx.push({ period: p.period, value: v }); v *= 1.002; }
  assert.throws(() => buildForecast(idx, SCENARIO, META, 12), /표본 0/);
});

// ── h) 표본 < 3 ─────────────────────────────────────────────────────────

test('h) 달력월 표본 수를 반환하고 3개 미만이면 insufficient', () => {
  // 2024-01~2026-06: 1~6월 3개, 7~12월 2개.
  const guide = seasonalAvgMM(mmRun('2024-01', 30), 10, '2026-06', 12);
  const byMonth = Object.fromEntries(guide.map((g) => [g.period.slice(5), g]));
  assert.equal(byMonth['07'].samples, 2);
  assert.equal(byMonth['07'].insufficient, true);
  assert.ok(Math.abs(byMonth['07'].value - 0.2) < 1e-12); // 값은 계산하되 플래그로 표시
  assert.equal(byMonth['01'].samples, 3);
  assert.equal(byMonth['01'].insufficient, false);
});

test('h) buildForecast — 15개월 이력은 guide.insufficient_months 로 부족 달을 노출', () => {
  const short = HEADLINE.filter((p) => p.period >= '2025-04');
  assert.equal(short.length, 15);
  const r = buildForecast(short, SCENARIO, META, 12);
  const months = r.guide.insufficient_months;
  assert.ok(Array.isArray(months) && months.length === 12, JSON.stringify(months));
  assert.deepEqual(Object.keys(months[0]).sort(), ['month', 'samples']);
  assert.ok(months.every((m) => m.samples < MIN_SEASONAL_SAMPLES));
});

test('h) buildForecast — 전체 이력(738개월)은 insufficient_months 가 비어 있다', () => {
  const r = buildForecast(HEADLINE, SCENARIO, META, 12);
  assert.deepEqual(r.guide.insufficient_months, []);
  assert.ok(r.guide.seasonal_avg_window.every((g) => g.insufficient === false && g.samples >= 3));
});

// ── 회귀: 충분한 표본의 값은 그대로 ──────────────────────────────────────

test('회귀 — 전체 이력의 시즈널 값은 10년 달력월 단순평균 그대로', () => {
  const mm = computeMM(HEADLINE);
  const guide = seasonalAvgMM(mm, 10, '2026-06', 12);
  const jul = guide.find((g) => g.period === '2026-07');
  const samples = mm.filter((p) => p.period.endsWith('-07') && p.period >= '2016-07' && p.period <= '2026-06');
  assert.equal(jul.samples, samples.length);
  const mean = samples.reduce((s, p) => s + p.value, 0) / samples.length;
  assert.ok(Math.abs(jul.value - mean) < 1e-12);
});

// ── 회귀: 가드 도입 전 출력 골든(tests/fixtures/calc-golden.json) 과 완전 일치 ──
// 입력까지 픽스처에 담아 data 갱신과 무관. 공용 호출자(KR buildForecast/annualYoYSummary,
// US buildForecastUS/annualYoYSummaryUS, 나우캐스트 seasonalMonthMap/seasonalForPeriod) 전부.

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/calc-golden.json', import.meta.url), 'utf8'));
const pv = (arr) => arr.map(({ period, value }) => ({ period, value }));
const pickForecast = (r) => ({
  index_forecast: r.index_forecast, mm_forecast: r.mm_forecast, yoy_forecast: r.yoy_forecast,
  seasonal_avg_window: pv(r.guide.seasonal_avg_window),
  seasonal_trimmed_window: pv(r.guide.seasonal_trimmed_window),
  recent_6m_avg: r.guide.recent_6m_avg, recent_12m_avg: r.guide.recent_12m_avg,
  mm_guide_full: pv(r.mm_guide_full),
});
const scen = (id, ov) => ({ series_id: id, scenario_id: 'base', label: 'Base', mm_overrides: ov });
const metaW = (id, w) => ({ series_id: id, window_years: w, notes: '', comparison_label: '' });

for (const c of GOLDEN.cases) {
  const input = GOLDEN.inputs[c.id];
  if (c.kind === 'kr') {
    test(`골든 — KR ${c.id} window ${c.window_years}y${c.overrides.length ? ' +override' : ''}`, () => {
      assert.deepEqual(pickForecast(buildForecast(input, scen(c.id, c.overrides), metaW(c.id, c.window_years), 12)), c.forecast);
      assert.deepEqual(calc.annualYoYSummary(input, scen(c.id, c.overrides), metaW(c.id, c.window_years)), c.annual);
    });
  } else if (c.kind === 'us') {
    test(`골든 — US ${c.id} window 10y`, () => {
      assert.deepEqual(pickForecast(usCalc.buildForecastUS(input, scen(c.id, []), metaW(c.id, 10), 12)), c.forecast);
      assert.deepEqual(usCalc.annualYoYSummaryUS(input, scen(c.id, []), metaW(c.id, 10)), c.annual);
    });
  } else {
    test(`골든 — 나우캐스트 시즈널 ${c.id}`, () => {
      const mm = usCalc.computeMMGapAware(input);
      const end = input.at(-1).period;
      assert.deepEqual([...nowcast.seasonalMonthMap(mm, 10, end)], c.monthMap);
      assert.equal(nowcast.seasonalForPeriod(mm, end, nextPeriod(end)), c.forPeriod);
    });
  }
}
