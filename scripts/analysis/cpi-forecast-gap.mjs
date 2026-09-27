// cpi-forecast-gap.mjs — KR CPI 1개월 앞 전망 vs 실제 gap (분석 전용, 앱 코드 읽기만).
//
// 전망치 = t월 실적 발표 전 시점의 우리 방식 m-m 추정:
//   t-1월까지 데이터로 buildForecast(admin 과 같은 설정: window_years 10, override 없음)를 돌려 나온 t월 m-m.
// 실제 m-m·y-y 는 현재 data 파일 기준. gap = 실제 − 전망 (%p).
//
// 사용: node scripts/analysis/cpi-forecast-gap.mjs   → analysis/cpi-forecast-gap-<series>.csv + 표 출력

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';

import { buildForecast, computeMM, computeYY, nextPeriod, prevPeriod } from '../../js/calc.js';
import { getConfig } from '../../js/series-config.js';

const SERIES = ['kr-cpi-headline', 'kr-cpi-core', 'kr-cpi-lifecost'];
const FROM = '2025-09';
const TO = '2026-08';
const WINDOW_YEARS = 10; // admin-ui renderPreview 와 동일

// 2025-08 통신요금 한시 할인 영향 달.
//   2025-09: 할인 종료 반등이 실제 m-m 에 들어감.
//   2026-08: 8월 시즈널 평균(10개 표본)에 2025-08 급락 m-m 이 포함돼 전망이 영향받음.
const TELECOM = {
  '2025-09': '통신요금 할인 종료 반등(실제)',
  '2026-08': '8월 시즈널 표본에 2025-08 할인 포함(전망)',
};

const ROOT = new URL('../../', import.meta.url);

function loadSeries(id) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(new URL(`data/${id}.js`, ROOT), 'utf8'), ctx);
  return ctx.window.FENRIR_SERIES[id].series;
}

function targets() {
  const out = [];
  for (let p = FROM; p <= TO; p = nextPeriod(p)) out.push(p);
  return out;
}

function forecastMM(series, target) {
  const cfg = getConfig(series.id) || {};
  const history = series.points.filter((p) => p.period <= prevPeriod(target, 1));
  const scenario = { series_id: series.id, scenario_id: 'base', label: 'Base', mm_overrides: [] };
  const meta = { series_id: series.id, window_years: WINDOW_YEARS, notes: '', comparison_label: '' };
  const r = buildForecast(history, scenario, meta, 12, cfg.value_type || 'index', cfg.frequency || 'monthly');
  const hit = r.mm_forecast.find((p) => p.period === target);
  if (!hit) throw new Error(`${series.id} ${target}: 전망 m-m 없음`);
  return hit.value;
}

function summarize(rows) {
  const n = rows.length;
  const bias = rows.reduce((s, r) => s + r.gap, 0) / n;
  const mae = rows.reduce((s, r) => s + Math.abs(r.gap), 0) / n;
  const top3 = [...rows].sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap)).slice(0, 3);
  return { n, bias, mae, top3 };
}

const f = (v, d = 2) => (v >= 0 ? '+' : '') + v.toFixed(d);
const csvNum = (v) => v.toFixed(4);

mkdirSync(new URL('analysis/', ROOT), { recursive: true });

for (const id of SERIES) {
  const points = loadSeries(id);
  const actualMM = new Map(computeMM(points).map((p) => [p.period, p.value]));
  const actualYY = new Map(computeYY(points).map((p) => [p.period, p.value]));
  const rows = targets().map((t) => {
    const fc = forecastMM({ id, points }, t);
    const act = actualMM.get(t);
    if (act === undefined) throw new Error(`${id} ${t}: 실제 m-m 없음`);
    return { target: t, fc, act, gap: act - fc, yy: actualYY.get(t), flag: TELECOM[t] ?? '' };
  });

  const csv = ['target,forecast_mm,actual_mm,gap_pp,actual_yy,telecom_flag',
    ...rows.map((r) => [r.target, csvNum(r.fc), csvNum(r.act), csvNum(r.gap), csvNum(r.yy), r.flag].join(','))];
  writeFileSync(new URL(`analysis/cpi-forecast-gap-${id.replace('kr-cpi-', '')}.csv`, ROOT), '﻿' + csv.join('\r\n') + '\r\n');

  console.log(`\n### ${id}\n`);
  console.log('| 목표월 | 전망 m-m | 실제 m-m | gap | 실제 y-y | 통신 |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.target} | ${f(r.fc)} | ${f(r.act)} | ${f(r.gap)} | ${f(r.yy)} | ${r.flag ? '⚑' : ''} |`);
  for (const [label, rs] of [['포함', rows], ['제외', rows.filter((r) => !r.flag)]]) {
    const s = summarize(rs);
    console.log(`- ${label}(n=${s.n}): 평균 gap ${f(s.bias, 3)} · MAE ${s.mae.toFixed(3)} · 최대 |gap| ${s.top3.map((r) => `${r.target} ${f(r.gap)}`).join(', ')}`);
  }
}
