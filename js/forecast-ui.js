// forecast-ui.js — 물가전망 페이지 컨트롤러.
// calc.js(계산) + chart.js(렌더)를 엮어 화면 상태를 관리.

import { buildForecast, computeMM, annualYoYSummary } from './calc.js';
import { renderIndexChart, renderMmChart, renderYoyChart } from './chart.js';
import { getSeriesData, getConfig, seasonalExclusionsFor, exclusionFootnote } from './series-config.js';

// 이 페이지가 표시하는 시리즈 (헤드라인 / 근원). 신규 series id 추가 없이
// 기존 스캐폴딩(series-config.js)에 등록된 id만 노출한다.
const SERIES = [
  { id: 'kr-cpi-headline', label: '헤드라인' },
  { id: 'kr-cpi-core', label: '근원(식료품·에너지 제외)' },
  { id: 'kr-cpi-lifecost', label: '생활물가' },
];
// 전망 방법론 지위가 '참고용'인 시리즈 (게이트 미봉인). v1 엔진은 동일 적용하되 각주로 구분.
const REFERENCE_SERIES = new Set(['kr-cpi-lifecost']);
const SERIES_IDS = SERIES.map((s) => s.id);
const LS_KEY = 'kr-inflation-forecast';

// ── 상태 ──
const state = {
  seriesId: 'kr-cpi-headline',
  windowYears: 10,      // 5 | 10 | 15 (US 모듈과 통일: 기본 10)
  forecastMonths: 12,   // 전망 개월수
  yyMonths: 60,         // y-y 차트 표시 범위 (최근 N개월)
  // 시나리오 override는 시리즈별로 분리 보관 (탭 전환 시 서로 오염되지 않음).
  // { seriesId: { 'YYYY-MM': mm(number) } }
  overridesBySeries: {},
};

let META = null;
let DATA = null;

// 현재 시리즈의 override 맵 (없으면 생성).
function currentOverrides() {
  return (state.overridesBySeries[state.seriesId] ??= {});
}

// ── 저장/로드 (US 규약 준용: 단일 LS 객체, overridesBySeries에 시리즈별 키, 방어적 병합) ──
function persistable() {
  return {
    kind: LS_KEY,
    version: 1,
    activeSeries: state.seriesId,
    forecastMonths: state.forecastMonths,
    yyMonths: state.yyMonths,
    windowYears: state.windowYears,
    overridesBySeries: state.overridesBySeries,
  };
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(persistable())); } catch { /* noop */ }
}
function applyState(s) {
  if (!s || typeof s !== 'object') return;
  if (SERIES_IDS.includes(s.activeSeries)) state.seriesId = s.activeSeries;
  if ([6, 12, 24].includes(s.forecastMonths)) state.forecastMonths = s.forecastMonths;
  if ([36, 60, 120].includes(s.yyMonths)) state.yyMonths = s.yyMonths;
  if ([5, 10, 15].includes(s.windowYears)) state.windowYears = s.windowYears;
  if (s.overridesBySeries && typeof s.overridesBySeries === 'object') {
    // 시리즈별 { 'YYYY-MM': number }만 취함 (알 수 없는 시리즈·비정형 값 배제).
    const clean = {};
    for (const [sid, ov] of Object.entries(s.overridesBySeries)) {
      if (!SERIES_IDS.includes(sid) || !ov || typeof ov !== 'object') continue;
      clean[sid] = {};
      for (const [period, mm] of Object.entries(ov)) {
        const num = Number(mm);
        if (/^\d{4}-\d{2}$/.test(period) && Number.isFinite(num)) clean[sid][period] = num;
      }
    }
    state.overridesBySeries = clean;
  }
}
function load() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { s = null; }
  applyState(s);
}

function scenario() {
  return {
    series_id: META.series_id,
    scenario_id: 'base',
    label: 'Base',
    mm_overrides: Object.entries(currentOverrides()).map(([period, mm]) => ({ period, mm })),
    last_edited: new Date().toISOString(),
  };
}

function meta() {
  return {
    series_id: META.series_id,
    window_years: state.windowYears,
    notes: '',
    comparison_label: '',
    seasonal_exclusions: seasonalExclusionsFor(META.series_id),
  };
}

function compute() {
  return buildForecast(
    DATA, scenario(), meta(),
    state.forecastMonths, META.value_type, META.frequency,
  );
}

// ── 렌더 ──
function renderAll() {
  if (!META || !DATA || DATA.length === 0) {
    renderMissing();
    return;
  }
  const result = compute();
  renderIndexChart(document.getElementById('chart-index'), result);
  renderMmChart(document.getElementById('chart-mm'), result);
  renderYoyChart(document.getElementById('chart-yoy'), result, { yyMonths: state.yyMonths });
  renderAnnual(annualYoYSummary(DATA, scenario(), meta()));
  renderSummary(result);
  renderEditor(result);
  renderMethodology(result);
}

// 데이터 파일이 아직 없는 시리즈(예: 근원). 페이지를 깨지 않고 안내만 표시.
function renderMissing() {
  const cfg = getConfig(state.seriesId);
  const name = cfg?.display_name ?? state.seriesId;
  ['chart-yoy', 'chart-index', 'chart-mm'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) { if (window.Plotly) window.Plotly.purge(el); el.innerHTML = ''; }
  });
  const ann = document.getElementById('annual-summary');
  if (ann) ann.innerHTML = '';
  document.getElementById('summary').innerHTML =
    `<div class="notice">
       <strong>${name}</strong> — 데이터 파일 없음.<br>
       <span class="notice-sub">admin.html에서 KOSIS CSV를 파싱해 <span class="k">data/${state.seriesId}.js</span>를 생성·커밋하면 이 탭이 활성화됩니다.</span>
     </div>`;
  document.getElementById('editor-body').innerHTML =
    '<div class="empty">데이터 파일 생성 후 m-m 편집이 가능합니다.</div>';
  renderMethodology();
}

// 방법론 버전 각주. 헤드라인·근원은 봉인된 v1.1, 생활물가는 '참고용'으로 시각 구분.
// 둘째 줄: 이번 전망 창에서 드롭된 시즈널 제외 달, 셋째 줄: 버전 변경 이력.
const METHOD_CHANGELOG = 'v1.1 (2026-09-27): 시즈널 표본 이상치 제외 목록 추가 — 2025-08·09 통신요금 한시 할인';
function renderMethodology(result) {
  const el = document.getElementById('method-note');
  if (!el) return;
  const head = REFERENCE_SERIES.has(state.seriesId)
    ? '전망 방법론 v1.1 · 참고용 — 전망 적합성 백테스트 판정 전, 게이트 미봉인'
    : `전망 방법론 v1.1 · 계절평균(${state.windowYears}yr 고정창)`;
  el.className = REFERENCE_SERIES.has(state.seriesId) ? 'method-note method-note-ref' : 'method-note';
  el.textContent = [head, exclusionFootnote(result?.guide?.excluded), METHOD_CHANGELOG].filter(Boolean).join('\n');
}

// ── 연평균 y-y 요약 카드 ──
// 전망 m-m을 바꿀 때마다 renderAll 파이프라인에서 재계산됨(별도 상태 없음).
function renderAnnual(summary) {
  const el = document.getElementById('annual-summary');
  if (!el) return;
  if (!summary || summary.years.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = summary.years.map((y) => {
    const parts = [];
    if (y.actual > 0) parts.push(`실측 ${y.actual}M`);
    parts.push(`입력 ${y.input}M`);
    parts.push(`가이드 ${y.guide}M`);
    const gap = y.complete ? '' : `<span class="annual-gap">${y.months}개월 평균</span>`;
    return `
      <div class="annual-item">
        <div class="annual-year">${y.year}<span class="annual-unit">연평균</span>${gap}</div>
        <div class="annual-val">${fmtSigned(y.avg, 2)}<span class="stat-unit">%</span></div>
        <div class="annual-parts">${parts.join(' + ')}</div>
      </div>`;
  }).join('');
}

function fmt(v, d = 2) {
  return (typeof v !== 'number' || !Number.isFinite(v)) ? '—' : v.toFixed(d);
}
function fmtSigned(v, d = 2) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(d);
}

// ── 요약 카드 ──
function renderSummary(result) {
  const el = document.getElementById('summary');
  const lastHist = result.yoy_history[result.yoy_history.length - 1];
  const lastFcst = result.yoy_forecast[result.yoy_forecast.length - 1];
  const lastIdx = result.index_history[result.index_history.length - 1];

  // 전망 기간 연평균 y-y (forecast 구간)
  const fcstAvg = result.yoy_forecast.length > 0
    ? result.yoy_forecast.reduce((s, p) => s + p.value, 0) / result.yoy_forecast.length
    : null;

  const cards = [
    { label: '최신 실측', sub: lastIdx?.period ?? '—', main: fmt(lastIdx?.value, 2), unit: 'idx' },
    { label: '최신 y-y', sub: lastHist?.period ?? '—', main: fmtSigned(lastHist?.value, 2), unit: '%' },
    { label: `전망 종점 y-y`, sub: lastFcst?.period ?? '—', main: fmtSigned(lastFcst?.value, 2), unit: '%' },
    { label: '전망기간 평균 y-y', sub: `${state.forecastMonths}개월`, main: fmtSigned(fcstAvg, 2), unit: '%' },
    { label: '최근 6M m-m 평균', sub: '연율화 아님', main: fmtSigned(result.guide.recent_6m_avg, 3), unit: '%' },
  ];

  el.innerHTML = cards.map((c) => `
    <div class="stat">
      <div class="stat-label">${c.label}</div>
      <div class="stat-main">${c.main}<span class="stat-unit">${c.unit}</span></div>
      <div class="stat-sub">${c.sub}</div>
    </div>`).join('');
}

// ── m-m override 편집기 ──
// 각 forecast 월에 대해 [가이드값 표시] + [override 입력]. 입력 비우면 가이드값 사용.
function renderEditor(result) {
  const el = document.getElementById('editor-body');
  const guide = result.guide.seasonal_avg_window; // 고정 endPeriod 계절창 (seasonalAvgMM, v1)
  if (guide.length === 0) {
    el.innerHTML = '<div class="empty">이 시리즈는 m-m 편집을 지원하지 않습니다 (rate/quarterly).</div>';
    return;
  }

  const overrides = currentOverrides();
  el.innerHTML = guide.map((g) => {
    const ov = overrides[g.period];
    const hasOv = ov !== undefined;
    const effective = hasOv ? ov : g.value;
    return `
      <div class="editor-row ${hasOv ? 'has-override' : ''}">
        <div class="er-period">${g.period}</div>
        <div class="er-guide">가이드 ${fmtSigned(g.value, 3)}</div>
        <input class="er-input" type="number" step="0.01" data-period="${g.period}"
               value="${hasOv ? ov : ''}" placeholder="${fmt(g.value, 3)}" />
        <div class="er-eff">→ ${fmtSigned(effective, 3)}%</div>
      </div>`;
  }).join('');

  el.querySelectorAll('.er-input').forEach((input) => {
    input.addEventListener('change', (e) => {
      const period = e.target.dataset.period;
      const raw = e.target.value.trim();
      const ovs = currentOverrides();
      if (raw === '') delete ovs[period];
      else {
        const num = parseFloat(raw);
        if (Number.isFinite(num)) ovs[period] = num;
      }
      save();
      renderAll();
    });
  });
}

// ── 시리즈 탭 ──
function renderSeriesTabs() {
  const el = document.getElementById('series-tabs');
  el.innerHTML = SERIES.map((s) =>
    `<button data-series="${s.id}" class="${s.id === state.seriesId ? 'active' : ''}">${s.label}</button>`
  ).join('');
  el.querySelectorAll('[data-series]').forEach((btn) => {
    btn.addEventListener('click', () => { selectSeries(btn.dataset.series); save(); });
  });
}

// 로드된 state에 맞춰 세그먼트 버튼 active 동기화 (HTML 기본 active와 다를 수 있음).
function syncControlActive() {
  document.querySelectorAll('[data-window]').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.window) === state.windowYears));
  document.querySelectorAll('[data-fcst]').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.fcst) === state.forecastMonths));
  document.querySelectorAll('[data-yy]').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.yy) === state.yyMonths));
}

function loadSeries(id) {
  const entry = getSeriesData(id);
  META = entry?.meta ?? null;
  DATA = entry?.series ?? null;
}

function renderHeaderBar() {
  const cfg = getConfig(state.seriesId);
  document.getElementById('series-name').textContent =
    META?.display_name ?? cfg?.display_name ?? state.seriesId;
  document.getElementById('series-source').textContent =
    (META?.source ?? cfg?.source ?? '—').toUpperCase();
  if (META && DATA && DATA.length) {
    document.getElementById('series-updated').textContent = META.last_updated;
    document.getElementById('series-count').textContent = `${DATA.length}개월`;
    document.getElementById('series-range').textContent =
      `${DATA[0].period} ~ ${DATA[DATA.length - 1].period}`;
  } else {
    document.getElementById('series-updated').textContent = '데이터 없음';
    document.getElementById('series-count').textContent = '—';
    document.getElementById('series-range').textContent = '—';
  }
}

function selectSeries(id) {
  state.seriesId = id;
  loadSeries(id);
  document.querySelectorAll('#series-tabs [data-series]').forEach((b) =>
    b.classList.toggle('active', b.dataset.series === id));
  renderHeaderBar();
  renderAll();
}

// ── 컨트롤 바인딩 ──
function bindControls() {
  // window 토글 (시리즈 공통 컨트롤 — 활성 시리즈 데이터에 각각 적용)
  document.querySelectorAll('[data-window]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.windowYears = Number(btn.dataset.window);
      document.querySelectorAll('[data-window]').forEach((b) => b.classList.toggle('active', b === btn));
      save();
      renderAll();
    });
  });

  // 전망 개월수
  document.querySelectorAll('[data-fcst]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.forecastMonths = Number(btn.dataset.fcst);
      document.querySelectorAll('[data-fcst]').forEach((b) => b.classList.toggle('active', b === btn));
      save();
      renderAll();
    });
  });

  // y-y 표시범위
  document.querySelectorAll('[data-yy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.yyMonths = Number(btn.dataset.yy);
      document.querySelectorAll('[data-yy]').forEach((b) => b.classList.toggle('active', b === btn));
      save();
      renderAll();
    });
  });

  // override 초기화 (현재 시리즈만)
  document.getElementById('reset-overrides').addEventListener('click', () => {
    state.overridesBySeries[state.seriesId] = {};
    save();
    renderAll();
  });

  // 시나리오 export (현재 시리즈 override를 JSON으로)
  document.getElementById('export-scenario').addEventListener('click', () => {
    if (!META) return;
    const blob = new Blob([JSON.stringify(scenario(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${META.series_id}-scenario.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ── 초기화 ──
export function initForecast() {
  load();
  renderSeriesTabs();
  bindControls();
  syncControlActive();
  selectSeries(state.seriesId);
}
