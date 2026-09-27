// cpi-gap-bias.mjs — gap 분석 2차: 편향 가설 백테스트 + 통신 할인 오염 보정 + 추세 보정 후보 (분석 전용, 앱 코드 읽기만).
//
// 1) 장기 백테스트: 목표월 2011-01~2026-08, 1개월 앞 전망(t-1까지 buildForecast, window 10y, override 없음).
//    x = (t-1 최근 12개월 y-y − 전망에 쓴 10년 창의 평균 연율) / 12,  gap = a + b·x  (가설 b≈1, a≈0)
//    10년 창 평균 연율 = 창(t-120~t-1) m-m 120개 합 / 10 — 전망 12개월 m-m 합과 같은 기준.
//    t값: OLS 와 Newey-West(lag 12) 둘 다. 제외 버전은 목표월 2025-08·09 제외.
// 2) 통신 할인 오염 보정: 시즈널 표본의 2025-09(→2026-09 전망), 2025-08(→2027-08 전망) m-m 을
//    "나머지 9년 같은 달 평균"으로 바꿨을 때 전망 변화. 참고로 seasonalTrimmedAvgMM 값.
// 3) 추세 보정 후보(2026-08 기준): 각 추세 지표의 "10년 창 평균 대비 월 차이".
//
// 사용: node scripts/analysis/cpi-gap-bias.mjs  → analysis/cpi-gap-*.csv + 표 출력

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';

import {
  buildForecast, computeMM, computeYY, seasonalAvgMM, seasonalTrimmedAvgMM, nextPeriod, prevPeriod, periodMonth,
} from '../../js/calc.js';

const SERIES = ['kr-cpi-headline', 'kr-cpi-core', 'kr-cpi-lifecost'];
const FROM = '2011-01';
const TO = '2026-08';
const WINDOW_YEARS = 10;
const NW_LAG = 12;
const EXCLUDE = new Set(['2025-08', '2025-09']);
const AS_OF = '2026-08';

const ROOT = new URL('../../', import.meta.url);
const short = (id) => id.replace('kr-cpi-', '');

function loadSeries(id) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(new URL(`data/${id}.js`, ROOT), 'utf8'), ctx);
  return ctx.window.FENRIR_SERIES[id].series;
}
function writeCsv(name, header, rows) {
  writeFileSync(new URL(`analysis/${name}`, ROOT), '﻿' + [header, ...rows.map((r) => r.join(','))].join('\r\n') + '\r\n');
}
const n4 = (v) => (v === null || v === undefined ? '' : Number(v).toFixed(4));
const sg = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

// 창(endPeriod 포함 이전 windowYears*12개월) m-m 합 / windowYears = 평균 연율(%)
function windowAnnual(mmMap, endPeriod) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < WINDOW_YEARS * 12; i++) {
    const v = mmMap.get(prevPeriod(endPeriod, i));
    if (v !== undefined) { sum += v; n++; }
  }
  if (n !== WINDOW_YEARS * 12) return null;
  return sum / WINDOW_YEARS;
}

function oneAhead(id, points, target) {
  const history = points.filter((p) => p.period <= prevPeriod(target, 1));
  const r = buildForecast(history,
    { series_id: id, scenario_id: 'base', label: 'Base', mm_overrides: [] },
    { series_id: id, window_years: WINDOW_YEARS, notes: '', comparison_label: '' }, 12, 'index', 'monthly');
  return r.mm_forecast.find((p) => p.period === target).value;
}

// OLS y = a + b x, OLS·Newey-West 표준오차
function regress(xs, ys, lag) {
  const n = xs.length;
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  const b = sxy / sxx;
  const a = my - b * mx;
  const e = ys.map((y, i) => y - a - b * xs[i]);
  const sse = e.reduce((s, v) => s + v * v, 0);
  const sst = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  // (X'X)^-1
  const s0 = n;
  const s1 = xs.reduce((s, v) => s + v, 0);
  const s2 = xs.reduce((s, v) => s + v * v, 0);
  const det = s0 * s2 - s1 * s1;
  const inv = [[s2 / det, -s1 / det], [-s1 / det, s0 / det]];
  const s2hat = sse / (n - 2);
  const olsSe = [Math.sqrt(s2hat * inv[0][0]), Math.sqrt(s2hat * inv[1][1])];
  // Newey-West: S = Σ e² x x' + Σ_l w_l Σ e_t e_{t-l} (x_t x_{t-l}' + x_{t-l} x_t')
  const X = xs.map((x) => [1, x]);
  const S = [[0, 0], [0, 0]];
  const add = (u, v, w) => { for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) S[i][j] += w * u[i] * v[j]; };
  for (let t = 0; t < n; t++) add(X[t], X[t], e[t] * e[t]);
  for (let l = 1; l <= lag; l++) {
    const w = 1 - l / (lag + 1);
    for (let t = l; t < n; t++) {
      const c = w * e[t] * e[t - l];
      add(X[t], X[t - l], c);
      add(X[t - l], X[t], c);
    }
  }
  const mul = (A, B) => A.map((r, i) => B[0].map((_, j) => r[0] * B[0][j] + r[1] * B[1][j]));
  const V = mul(mul(inv, S), inv);
  const nwSe = [Math.sqrt(V[0][0]), Math.sqrt(V[1][1])];
  return {
    n, a, b, r2: 1 - sse / sst,
    tA: a / olsSe[0], tB: b / olsSe[1], tBminus1: (b - 1) / olsSe[1],
    nwTA: a / nwSe[0], nwTB: b / nwSe[1], nwTBminus1: (b - 1) / nwSe[1],
  };
}

mkdirSync(new URL('analysis/', ROOT), { recursive: true });
const regRows = [];
const adjRows = [];
const trendRows = [];

for (const id of SERIES) {
  const points = loadSeries(id);
  const mm = computeMM(points);
  const mmMap = new Map(mm.map((p) => [p.period, p.value]));
  const yyMap = new Map(computeYY(points).map((p) => [p.period, p.value]));
  const idx = new Map(points.map((p) => [p.period, p.value]));

  // ── 1) 백테스트 ──
  const bt = [];
  for (let t = FROM; t <= TO; t = nextPeriod(t)) {
    const end = prevPeriod(t, 1);
    const winAnn = windowAnnual(mmMap, end);
    const yyPrev = yyMap.get(end);
    if (winAnn === null || yyPrev === undefined) continue; // 창 미확보
    const fc = oneAhead(id, points, t);
    const act = mmMap.get(t);
    bt.push({ t, fc, act, gap: act - fc, yyPrev, winAnn, x: (yyPrev - winAnn) / 12, excl: EXCLUDE.has(t) });
  }
  writeCsv(`cpi-gap-backtest-${short(id)}.csv`,
    'target,forecast_mm,actual_mm,gap_pp,yy_prev,window_annual,x,excluded_2025_08_09',
    bt.map((r) => [r.t, n4(r.fc), n4(r.act), n4(r.gap), n4(r.yyPrev), n4(r.winAnn), n4(r.x), r.excl ? 1 : 0]));
  for (const [ver, rows] of [['전체', bt], ['2025-08·09 제외', bt.filter((r) => !r.excl)]]) {
    const g = regress(rows.map((r) => r.x), rows.map((r) => r.gap), NW_LAG);
    regRows.push({ id, ver, from: rows[0].t, to: rows.at(-1).t, ...g });
  }

  // ── 2) 할인 오염 보정 ──
  const guideAt = (fn, mmHist, target) => fn(mmHist, WINDOW_YEARS, AS_OF, 12).find((g) => g.period === target).value;
  for (const [target, contaminated] of [['2026-09', '2025-09'], ['2027-08', '2025-08']]) {
    const m = periodMonth(target);
    const win = mm.filter((p) => p.period > prevPeriod(AS_OF, WINDOW_YEARS * 12) && p.period <= AS_OF && periodMonth(p.period) === m);
    const others = win.filter((p) => p.period !== contaminated).map((p) => p.value);
    const repl = mean(others);
    const mmFixed = mm.map((p) => (p.period === contaminated ? { ...p, value: repl } : p));
    const simple = guideAt(seasonalAvgMM, mm, target);
    const simpleFixed = guideAt(seasonalAvgMM, mmFixed, target);
    const trimmed = guideAt(seasonalTrimmedAvgMM, mm, target);
    const trimmedFixed = guideAt(seasonalTrimmedAvgMM, mmFixed, target);
    adjRows.push({
      id, target, contaminated, samples: win.map((p) => p.period.slice(0, 4)).join(' '),
      cont: mmMap.get(contaminated), repl, simple, simpleFixed, trimmed, trimmedFixed,
    });
  }

  // ── 3) 추세 보정 후보 (AS_OF 기준) ──
  const winAnn = windowAnnual(mmMap, AS_OF);
  const guideFor = (hist) => new Map(seasonalAvgMM(hist, WINDOW_YEARS, prevPeriod(AS_OF, 6), 6).map((g) => [g.period, g.value]));
  const last6 = [];
  for (let i = 5; i >= 0; i--) last6.push(prevPeriod(AS_OF, i));
  // 6개월 m-m 연율(NSA 원계열, 계절성 포함)
  const raw6 = (Math.pow(idx.get(AS_OF) / idx.get(prevPeriod(AS_OF, 6)), 2) - 1) * 100;
  // 통신 기저 제외 공통: 2025-08 m-m 을 2016~2024 8월 평균으로 정상화
  const augNormal = mean(mm.filter((p) => p.period >= '2016-08' && p.period <= '2024-08' && p.period.endsWith('-08')).map((p) => p.value));
  // 6개월 시즈널 대비 초과(계절조정 근사): Σ(실제 − 그 달 시즈널 가이드) × 2.
  // 가이드는 2026-02 앵커 10년 창 — 8월 표본의 2025-08 할인 급락을 정상화한 m-m 으로 계산(초과분 부풀림 방지).
  const g6 = guideFor(mm.map((p) => (p.period === '2025-08' ? { ...p, value: augNormal } : p)));
  const sa6 = last6.reduce((s, p) => s + (mmMap.get(p) - g6.get(p)), 0) * 2;
  // 통신 기저 제외 y-y: 정상화한 2025-08 m-m 으로 2025-08 지수를 재구성 → 2026-08 y-y
  const idx2508fix = idx.get('2025-07') * (1 + augNormal / 100);
  const yyTelecomFix = (idx.get(AS_OF) / idx2508fix - 1) * 100;
  const cands = [
    ['최근 12개월 y-y (2026-08)', yyMap.get(AS_OF), (yyMap.get(AS_OF) - winAnn) / 12],
    ['최근 12개월 y-y (2026-07, 통신 기저 이전)', yyMap.get('2026-07'), (yyMap.get('2026-07') - winAnn) / 12],
    ['통신 기저 제외 y-y (2026-08, 2025-08 정상화)', yyTelecomFix, (yyTelecomFix - winAnn) / 12],
    ['6개월 m-m 연율 (NSA 원계열)', raw6, (raw6 - winAnn) / 12],
    // 수준 = 창 평균 + 시즈널 대비 초과 연율(함축 추세 연율) → 월 차이 = 초과 / 12
    ['6개월 계절조정 근사 연율 (창 평균 + 시즈널 대비 초과)', winAnn + sa6, sa6 / 12],
  ];
  for (const [label, level, monthly] of cands) trendRows.push({ id, label, level, winAnn, monthly });
}

writeCsv('cpi-gap-regression.csv', 'series,version,from,to,n,a,t_a_ols,t_a_nw12,b,t_b_ols,t_b_nw12,t_b_minus_1_ols,t_b_minus_1_nw12,r2',
  regRows.map((r) => [r.id, r.ver, r.from, r.to, r.n, n4(r.a), n4(r.tA), n4(r.nwTA), n4(r.b), n4(r.tB), n4(r.nwTB), n4(r.tBminus1), n4(r.nwTBminus1), n4(r.r2)]));
writeCsv('cpi-gap-telecom-adjust.csv',
  'series,target,contaminated_month,sample_years,contaminated_mm,replacement_mm,simple,simple_fixed,simple_delta,trimmed,trimmed_fixed,trimmed_minus_simple',
  adjRows.map((r) => [r.id, r.target, r.contaminated, r.samples, n4(r.cont), n4(r.repl), n4(r.simple), n4(r.simpleFixed),
    n4(r.simpleFixed - r.simple), n4(r.trimmed), n4(r.trimmedFixed), n4(r.trimmed - r.simple)]));
writeCsv('cpi-gap-trend-candidates.csv', 'series,candidate,level_annual,window_annual,monthly_diff',
  trendRows.map((r) => [r.id, `"${r.label}"`, n4(r.level), n4(r.winAnn), n4(r.monthly)]));

console.log('\n## 1) 회귀 gap = a + b·x');
console.log('| 시리즈 | 버전 | 기간 | n | a | t(a) OLS/NW | b | t(b) OLS/NW | t(b−1) OLS/NW | R² |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of regRows) {
  console.log(`| ${short(r.id)} | ${r.ver} | ${r.from}~${r.to} | ${r.n} | ${sg(r.a, 3)} | ${r.tA.toFixed(2)} / ${r.nwTA.toFixed(2)} | ${r.b.toFixed(3)} | ${r.tB.toFixed(2)} / ${r.nwTB.toFixed(2)} | ${r.tBminus1.toFixed(2)} / ${r.nwTBminus1.toFixed(2)} | ${r.r2.toFixed(3)} |`);
}
console.log('\n## 2) 통신 할인 오염 보정 (시즈널 가이드, %)');
console.log('| 시리즈 | 전망월 | 오염 표본 | 오염 m-m | 대체값 | 단순평균 | 대체 후 | Δ | trimmed | trimmed−단순 | trimmed(대체 후) |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of adjRows) {
  console.log(`| ${short(r.id)} | ${r.target} | ${r.contaminated} | ${sg(r.cont)} | ${sg(r.repl)} | ${sg(r.simple, 3)} | ${sg(r.simpleFixed, 3)} | ${sg(r.simpleFixed - r.simple, 3)} | ${sg(r.trimmed, 3)} | ${sg(r.trimmed - r.simple, 3)} | ${sg(r.trimmedFixed, 3)} |`);
}
console.log('\n## 3) 추세 보정 후보 (2026-08 기준)');
console.log('| 시리즈 | 후보 | 수준(연율 %) | 10년 창 평균 | 월 차이 (%p) |');
console.log('|---|---|---|---|---|');
for (const r of trendRows) console.log(`| ${short(r.id)} | ${r.label} | ${r.level.toFixed(2)} | ${r.winAnn.toFixed(2)} | ${sg(r.monthly, 3)} |`);
