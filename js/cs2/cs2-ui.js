// cs2-ui.js — CS-2 크레딧 스프레드 추이 화면.
//
// CS-1 이 "오늘 값이 올해 범위 어디쯤인가"를 표로 읽는 자라면, 이 화면은 같은 데이터를
// 시간축으로 편다. 섹터·만기를 하나 고르면 국고 대비 스프레드(bp) 추이를, 둘을 고르면
// 두 스프레드의 차(A − B) 추이를 그린다. 어느 쪽이든 이동평균(20/60/120/200)과
// 역사적 평균(2/3/5/10년·MAX)을 같은 방식으로 얹는다.
//
// [측정 전용] 선·평균·백분위는 위치만 보여준다. 판정 문구·임계값·밴드·신호색을 넣지 않는다.
//   선 색은 계열을 구분할 뿐 방향을 뜻하지 않는다.
//
// 화면은 세 모드다. '개별'은 한 줄을 큰 차트로, '전체 조망'은 섹터×만기 전부를 미니 차트
// 격자로, '평균 대비 표'는 현재값 ÷ 평균 배율을 섹터×만기 한 장과 연도별 평균 표로 깐다. 차트 기간·이동평균·역사적 평균 설정은 두 모드가 공유하고, 격자의 칸을
// 누르면 그 섹터·만기가 A 로 잡힌 채 개별 모드로 넘어간다.
//
// 데이터: data/cs1/spreads.json (CS-1 과 같은 파일 — 이 화면을 위한 새 산출물은 없다).
// 계산: js/cs2/cs2-calc.js. 의존성은 Plotly(vendor) 뿐.

import {
  HIST_WINDOWS, MA_WINDOWS, VIEW_WINDOWS, WINDOW_LABEL,
  changeOver, diffSeries, heatT, lastValidIndex, legValues, movingAverage, rangeWithPad, ratioOf, sectorList,
  sparkPath, spreadLabels, startIndexFor, windowStats, yearMask, yearlyMeans,
} from './cs2-calc.js';

const DATA_URL = 'data/cs1/spreads.json';
const LS_KEY = 'cs2-view';

const C = {
  main: '#58a6ff', legB: '#d2a8ff', mean: '#c9d1d9',
  grid: '#21262d', axis: '#484f58', muted: '#8b949e', text: '#e6edf3',
};
/** 이동평균 선 색 — 서로, 그리고 본선(청색)과 구분되기만 하면 된다. */
const MA_COLOR = { 20: '#e3b341', 60: '#f0883e', 120: '#3fb950', 200: '#a371f7' };
const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** 차트 여백·높이. 끝점 라벨 배치가 플롯 영역 픽셀 높이를 알아야 해서 상수로 둔다. */
const MAIN_H = 420, LEG_H = 240;
const MARGIN = { l: 50, r: 118, t: 12, b: 30 };
const LABEL_GAP = 15;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '—');
const fmtRatio = (r) => (isNum(r) ? r.toFixed(2) + '배' : '—');
const signed = (v, d = 1) => (isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(d) : '—');

const NONE = '';
export const MODES = ['detail', 'overview', 'table'];
export const HEAT_KINDS = ['ratio', 'gap', 'pct', 'off'];
/** 평균 표본에서 뺄 수 있는 해. 2022년은 스프레드가 이례적으로 벌어졌던 해라 평균을 끌어올린다. */
export const EXCLUDE_YEAR = '2022';

// ── 역사적 평균(세 모드 공통 정의) ───────────────────────────────────────────
//
// 평균·최저·최고·백분위·z·배율은 전부 같은 표본에서 나온다: 선택한 기간(2Y…MAX) 안의 관측 중
// '2022 제외'가 켜져 있으면 2022년을 뺀 것. 모드마다 정의가 다르면 같은 이름의 숫자가
// 화면마다 달라지므로 한 곳에서만 만든다.

const maskCache = new WeakMap();
function skipFor(dates, state) {
  if (!state.ex2022) return null;
  if (!maskCache.has(dates)) maskCache.set(dates, yearMask(dates, EXCLUDE_YEAR));
  return maskCache.get(dates);
}
export function histStats(values, dates, state, end = lastValidIndex(values)) {
  return windowStats(values, startIndexFor(dates, state.hist, Math.max(end, 0)), end, skipFor(dates, state));
}
/** 평균 이름. 제외가 실제로 표본에 걸릴 때만 꼬리표를 단다(2Y·3Y 창에는 2022년이 없다). */
export function histLabelOf(state, dates) {
  const base = WINDOW_LABEL[state.hist];
  if (!state.ex2022 || !dates.length) return base;
  const from = dates[startIndexFor(dates, state.hist)];
  return from <= `${EXCLUDE_YEAR}-12-31` ? `${base}(22제외)` : base;
}

// ── 상태 ─────────────────────────────────────────────────────────────────────

export function defaultState(meta) {
  const sectors = sectorList(meta);
  const pick = (name) => (sectors.includes(name) ? name : sectors[0]);
  const tenor = meta.tenors.includes('3년') ? '3년' : meta.tenors[0];
  return {
    a: { sector: pick('카드채AA+'), tenor },
    b: { sector: NONE, tenor },          // sector '' = 단일 모드(B 없음)
    mode: 'detail',                      // 'detail' 개별 | 'overview' 전체 조망 | 'table' 평균 대비 표
    ex2022: true,                        // 평균 표본에서 2022년 제외(세 모드 공통)
    heat: 'ratio',                       // 표 색 기준: 'ratio' | 'gap' | 'pct' | 'off'
    tbSector: NONE,                      // 연도별 표의 섹터('' 이면 A 섹터)
    ovAll: false,                        // 전체 조망에서 11만기 전부 펼치기
    view: '1y', hist: '5y',
    ma: { 20: true, 60: true, 120: false, 200: false },
    showMean: true,
  };
}

/** 저장값을 현재 메타에 맞춰 검증해 덮는다 — 섹터·만기가 소스에서 빠졌으면 기본값으로 돌아간다. */
export function mergeState(base, saved, meta) {
  if (!saved || typeof saved !== 'object') return base;
  const sectors = sectorList(meta);
  const st = base;
  const leg = (dst, src, allowNone) => {
    if (!src || typeof src !== 'object') return;
    if (sectors.includes(src.sector) || (allowNone && src.sector === NONE)) dst.sector = src.sector;
    if (meta.tenors.includes(src.tenor)) dst.tenor = src.tenor;
  };
  leg(st.a, saved.a, false);
  leg(st.b, saved.b, true);
  if (VIEW_WINDOWS.includes(saved.view)) st.view = saved.view;
  if (HIST_WINDOWS.includes(saved.hist)) st.hist = saved.hist;
  if (saved.ma && typeof saved.ma === 'object') {
    for (const n of MA_WINDOWS) if (typeof saved.ma[n] === 'boolean') st.ma[n] = saved.ma[n];
  }
  if (typeof saved.showMean === 'boolean') st.showMean = saved.showMean;
  if (MODES.includes(saved.mode)) st.mode = saved.mode;
  if (typeof saved.ex2022 === 'boolean') st.ex2022 = saved.ex2022;
  if (HEAT_KINDS.includes(saved.heat)) st.heat = saved.heat;
  if (sectors.includes(saved.tbSector)) st.tbSector = saved.tbSector;
  if (typeof saved.ovAll === 'boolean') st.ovAll = saved.ovAll;
  return st;
}

// ── 계열 구성 ────────────────────────────────────────────────────────────────

const legName = (leg) => `${leg.sector} ${leg.tenor}`;
export const isPair = (state) => state.b.sector !== NONE;

/**
 * 상태 → 그릴 한 줄과 그 이름. 순수 함수(테스트 대상).
 * @returns {{ values, title, short, legA, legB, missing }}
 *   단일: values = A 의 국고 대비 스프레드 · 쌍: values = A − B
 */
export function buildLine(doc, state) {
  const bench = doc.meta.benchmark;
  const legA = legValues(doc, state.a.sector, state.a.tenor);
  if (!legA) return { values: null, missing: legName(state.a) };
  if (!isPair(state)) {
    return {
      values: legA, legA, legB: null,
      title: `${legName(state.a)} − ${bench} ${state.a.tenor}`,
      short: legName(state.a),
    };
  }
  const legB = legValues(doc, state.b.sector, state.b.tenor);
  if (!legB) return { values: null, missing: legName(state.b) };
  return {
    values: diffSeries(legA, legB), legA, legB,
    title: `${legName(state.a)} − ${legName(state.b)}`,
    short: 'A − B',
  };
}

// ── 차트 ─────────────────────────────────────────────────────────────────────

function baseLayout(height, yRange) {
  return {
    height, paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: C.muted, family: FONT, size: 11 },
    margin: MARGIN, showlegend: false, hovermode: 'x unified',
    hoverlabel: { bgcolor: '#161b22', bordercolor: '#30363d', font: { family: FONT, size: 11, color: C.text } },
    xaxis: { type: 'date', gridcolor: C.grid, linecolor: C.axis, zeroline: false, tickfont: { size: 10 } },
    yaxis: { range: yRange, gridcolor: C.grid, linecolor: C.axis, zeroline: true, zerolinecolor: C.axis,
      tickfont: { size: 10 }, title: { text: 'bp', font: { size: 11 } } },
  };
}

/** 보이는 값들의 y 범위(여백 8%). 값이 하나뿐이거나 평평하면 ±1bp 를 준다. */
function yRangeOf(arrays, extra = []) {
  let lo = Infinity, hi = -Infinity;
  for (const arr of arrays) for (const v of arr) if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  for (const v of extra) if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) return [0, 1];
  const pad = hi > lo ? (hi - lo) * 0.08 : 1;
  return [lo - pad, hi + pad];
}

/**
 * 오른쪽 여백의 끝점 라벨들(DESIGN.md — 끝점 값 라벨 필수). 값의 y 위치에 두되
 * 서로 겹치면 세로로 띄운다. 라벨 색 = 그 선의 색.
 */
function endLabels(labels, yRange, height) {
  const plotH = height - MARGIN.t - MARGIN.b;
  const toPx = (v) => ((yRange[1] - v) / (yRange[1] - yRange[0])) * plotH;
  const ys = spreadLabels(labels.map((l) => ({ y: toPx(l.value) })), LABEL_GAP, plotH);
  return labels.map((l, i) => ({
    xref: 'paper', yref: 'paper', x: 1, xanchor: 'left', xshift: 6,
    y: 1 - ys[i] / plotH, yanchor: 'middle', showarrow: false,
    text: `${l.name} <b>${fmt(l.value)}</b>`, font: { color: l.color, size: 11, family: FONT },
  }));
}

function trace(x, y, name, color, extra = {}) {
  return {
    x, y, name, mode: 'lines', connectgaps: false,
    line: { color, width: 1.8, ...(extra.line || {}) },
    hovertemplate: `${name} %{y:.1f}<extra></extra>`,
  };
}

function renderMain(doc, state, line, hist) {
  const from = startIndexFor(doc.dates, state.view);
  const x = doc.dates.slice(from);
  const y = line.values.slice(from);
  const traces = [trace(x, y, line.short, C.main, { line: { width: 2 } })];
  const lastIdx = lastValidIndex(line.values);
  const labels = [];
  if (lastIdx >= 0) labels.push({ name: line.short, value: line.values[lastIdx], color: C.main });

  // 이동평균은 전 이력으로 계산한 뒤 보이는 구간만 자른다 — 창 앞머리가 비지 않는다.
  const shown = [y];
  for (const n of MA_WINDOWS) {
    if (!state.ma[n]) continue;
    const ma = movingAverage(line.values, n);
    const seg = ma.slice(from);
    shown.push(seg);
    traces.push(trace(x, seg, `MA${n}`, MA_COLOR[n], { line: { width: 1.3 } }));
    const li = lastValidIndex(ma);
    if (li >= 0) labels.push({ name: `MA${n}`, value: ma[li], color: MA_COLOR[n] });
  }

  const meanOn = state.showMean && isNum(hist.mean);
  const yRange = yRangeOf(shown, meanOn ? [hist.mean] : []);
  const layout = baseLayout(MAIN_H, yRange);
  if (meanOn) {
    // 평균은 선택한 기간(예: 5년) 표본의 평균 한 값이다. 보이는 기간이 그보다 짧아도
    // 같은 값을 화면 전체에 가로로 긋는다 — 지금 보는 구간을 긴 평균에 대보는 것이 목적이다.
    layout.shapes = [{
      type: 'line', xref: 'paper', yref: 'y', x0: 0, x1: 1, y0: hist.mean, y1: hist.mean,
      line: { color: C.mean, width: 1.2, dash: 'dash' },
    }];
    labels.push({ name: `${histLabelOf(state, doc.dates)} 평균`, value: hist.mean, color: C.mean });
  }
  layout.annotations = endLabels(labels, yRange, MAIN_H);
  window.Plotly.react('cs2-chart', traces, layout, { displayModeBar: false, responsive: true });
}

function renderLegs(doc, state, line) {
  const from = startIndexFor(doc.dates, state.view);
  const x = doc.dates.slice(from);
  const ya = line.legA.slice(from), yb = line.legB.slice(from);
  const yRange = yRangeOf([ya, yb]);
  const layout = baseLayout(LEG_H, yRange);
  const labels = [];
  const ia = lastValidIndex(line.legA), ib = lastValidIndex(line.legB);
  if (ia >= 0) labels.push({ name: 'A', value: line.legA[ia], color: C.main });
  if (ib >= 0) labels.push({ name: 'B', value: line.legB[ib], color: C.legB });
  layout.annotations = endLabels(labels, yRange, LEG_H);
  window.Plotly.react('cs2-legs', [
    trace(x, ya, `A ${legName(state.a)}`, C.main),
    trace(x, yb, `B ${legName(state.b)}`, C.legB),
  ], layout, { displayModeBar: false, responsive: true });
}

// ── 요약 카드 ────────────────────────────────────────────────────────────────

export function statsHTML(line, hist, histLabel, dates) {
  const i = lastValidIndex(line.values);
  const prev = i > 0 ? lastValidIndex(line.values, i - 1) : -1;
  const cur = i >= 0 ? line.values[i] : null;
  const delta = prev >= 0 ? Math.round((cur - line.values[prev]) * 10) / 10 : null;
  const at = (idx) => (idx >= 0 ? dates[idx] : '—');
  const card = (label, main, sub, unit = 'bp') => `<div class="stat">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-main">${main}<span class="stat-unit">${unit}</span></div>
      <div class="stat-sub">${sub}</div>
    </div>`;
  return card('현재', fmt(cur), `전일 Δ ${signed(delta)} · ${at(i)}`)
    + card(`${histLabel} 평균`, fmt(hist.mean), `표본 ${hist.n}일 · σ ${fmt(hist.sd)}`)
    + card('현재 − 평균', signed(hist.gap), `z ${isNum(hist.z) ? signed(hist.z, 2) : '—'} · 배율 ${fmtRatio(ratioOf(hist.last, hist.mean))}`)
    + card(`${histLabel} 최저`, fmt(hist.min), at(hist.minIdx))
    + card(`${histLabel} 최고`, fmt(hist.max), at(hist.maxIdx))
    + card(`${histLabel} 백분위`, isNum(hist.pct) ? hist.pct.toFixed(0) : '—', '0 = 기간 최저 · 100 = 최고', '%');
}

// ── 전체 조망(미니 차트 격자) ────────────────────────────────────────────────

/** 전체 조망 기본 만기. CS-1 표와 같은 네 개 — 11개를 다 펴면 칸이 좁아진다. */
export const OV_DEFAULT_TENORS = ['1년', '2년', '3년', '5년'];
const SPARK_W = 100, SPARK_H = 40;

/**
 * 격자 한 칸. 순수 함수(테스트 대상).
 * 숫자: 현재값 / 평균 대비(현재 − 평균) / 평균 기간 내 백분위. 그림: 차트 기간의 스프레드 선,
 * 켜 둔 이동평균, 평균 점선. y 축은 칸마다 따로 잡는다 — 칸끼리 높낮이를 비교하는 그림이
 * 아니라 각 칸이 자기 범위 안에서 어디 있는지를 보는 그림이다(레벨 비교는 숫자로 한다).
 */
export function overviewCellHTML(values, dates, state, sector, tenor) {
  const end = values ? lastValidIndex(values) : -1;
  if (end < 0) return '<td class="nil" title="관측 없음">—</td>';
  const to = dates.length - 1;
  const from = startIndexFor(dates, state.view, to);
  const hist = histStats(values, dates, state, end);
  const histLabel = histLabelOf(state, dates);
  const mas = MA_WINDOWS.filter((n) => state.ma[n]).map((n) => ({ n, arr: movingAverage(values, n) }));
  const meanOn = state.showMean && isNum(hist.mean);
  const yr = rangeWithPad([values, ...mas.map((m) => m.arr)], from, to, meanOn ? [hist.mean] : []);

  let svg = '';
  if (yr) {
    const box = { w: SPARK_W, h: SPARK_H, lo: yr[0], hi: yr[1] };
    if (meanOn) {
      const y = (((yr[1] - hist.mean) / (yr[1] - yr[0])) * SPARK_H).toFixed(1);
      svg += `<line class="mean" x1="0" x2="${SPARK_W}" y1="${y}" y2="${y}"/>`;
    }
    for (const m of mas) svg += `<path d="${sparkPath(m.arr, from, to, box)}" stroke="${MA_COLOR[m.n]}" class="ma"/>`;
    svg += `<path d="${sparkPath(values, from, to, box)}" stroke="${C.main}" class="main"/>`;
  }
  const tip = `${sector} ${tenor} · 현재 ${fmt(values[end])}bp (${dates[end]}) · ${histLabel} 평균 ${fmt(hist.mean)}`
    + ` · 현재 − 평균 ${signed(hist.gap)} · ${histLabel} 범위 ${fmt(hist.min)}~${fmt(hist.max)}`
    + ` · 백분위 ${isNum(hist.pct) ? hist.pct.toFixed(0) : '—'}% · 눌러서 크게 보기`;
  return `<td data-sector="${esc(sector)}" data-tenor="${esc(tenor)}" title="${esc(tip)}">`
    + `<div class="ov-top"><span class="v">${fmt(values[end])}</span><span class="g">${signed(hist.gap)}</span></div>`
    + `<svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">${svg}</svg>`
    + `<div class="ov-bot">${histLabel} ${isNum(hist.pct) ? hist.pct.toFixed(0) : '—'}%</div>`
    + '</td>';
}

export function overviewTenors(meta, state) {
  return state.ovAll ? meta.tenors : meta.tenors.filter((t) => OV_DEFAULT_TENORS.includes(t));
}

export function overviewHTML(doc, state) {
  const tenors = overviewTenors(doc.meta, state);
  const head = '<tr><th class="corner">섹터</th>' + tenors.map((t) => `<th>${esc(t)}</th>`).join('') + '</tr>';
  const body = sectorList(doc.meta).map((sec) =>
    `<tr><th>${esc(sec)}</th>`
    + tenors.map((t) => overviewCellHTML(legValues(doc, sec, t), doc.dates, state, sec, t)).join('')
    + '</tr>').join('');
  return { head, body };
}

// ── 평균 대비 표 ─────────────────────────────────────────────────────────────
//
// 현재값이 평균의 몇 배인가를 섹터×만기 한 장으로 본다. 배율은 위치를 나타내는 측정값이지
// 판정이 아니다 — 스프레드가 얇은 섹터는 몇 bp 차이로도 배율이 크게 나오므로 칸마다
// bp 차와 백분위를 같이 적고, 색 기준도 배율·bp 차·백분위 중에서 바꿔 볼 수 있게 한다.

/** 칸 배경 최대 농도. 칸 안 글자(무채색)가 읽히는 선에서 한눈에 들어오는 정도. */
export const TB_MAX_ALPHA = 0.42;
const TINT_NARROW = '56, 178, 172';   // 평균보다 좁은 쪽(청록)
const TINT_WIDE = '217, 144, 42';     // 평균보다 넓은 쪽(호박)

export function heatBg(kind, cell, scale) {
  if (kind === 'off') return null;
  const t = heatT(kind, cell, scale);
  if (t === null) return null;
  const a = Math.round(Math.abs(t) * TB_MAX_ALPHA * 1000) / 1000;
  return `rgba(${t >= 0 ? TINT_WIDE : TINT_NARROW}, ${a})`;
}

/**
 * 표 두 장이 함께 쓰는 수치. 순수 함수(테스트 대상).
 * @returns {{ cells: {섹터: {만기: {cur, wow, mean, gap, pct, ratio, n, asof}|null}}, gapScale }}
 *   gapScale = 전체 칸 중 가장 큰 |bp 차| — 'bp 차' 색 기준의 눈금.
 */
export function tableData(doc, state) {
  const cells = {};
  let gapScale = 0;
  for (const sec of sectorList(doc.meta)) {
    cells[sec] = {};
    for (const t of doc.meta.tenors) {
      const v = legValues(doc, sec, t);
      const end = v ? lastValidIndex(v) : -1;
      if (end < 0) { cells[sec][t] = null; continue; }
      const h = histStats(v, doc.dates, state, end);
      cells[sec][t] = {
        cur: v[end], wow: changeOver(v, end, 5), mean: h.mean, gap: h.gap, pct: h.pct,
        ratio: ratioOf(h.last, h.mean), n: h.n, asof: doc.dates[end],
      };
      if (isNum(h.gap) && Math.abs(h.gap) > gapScale) gapScale = Math.abs(h.gap);
    }
  }
  return { cells, gapScale };
}

const bgAttr = (bg) => (bg ? ` style="background:${bg}"` : '');

/** 섹터×만기 한 장. 칸 = 배율(큰 숫자) / 현재 − 평균 bp · 백분위. */
export function matrixHTML(doc, state, data = tableData(doc, state)) {
  const tenors = doc.meta.tenors;
  const label = histLabelOf(state, doc.dates);
  const picked = state.tbSector || state.a.sector;
  const head = '<tr><th class="corner">섹터</th>' + tenors.map((t) => `<th>${esc(t)}</th>`).join('') + '</tr>';
  const body = sectorList(doc.meta).map((sec) => {
    const tds = tenors.map((t) => {
      const c = data.cells[sec][t];
      if (!c) return '<td class="nil" title="관측 없음">—</td>';
      const tip = `${sec} ${t} · 현재 ${fmt(c.cur)}bp (${c.asof}) · ${label} 평균 ${fmt(c.mean)}bp (표본 ${c.n}일)`
        + ` · 배율 ${fmtRatio(c.ratio)} · 현재 − 평균 ${signed(c.gap)}bp · 백분위 ${isNum(c.pct) ? c.pct.toFixed(0) : '—'}%`
        + ` · 전주비 ${signed(c.wow)}bp · 눌러서 추이 보기`;
      return `<td data-sector="${esc(sec)}" data-tenor="${esc(t)}" title="${esc(tip)}"${bgAttr(heatBg(state.heat, c, data.gapScale))}>`
        + `<div class="r">${isNum(c.ratio) ? c.ratio.toFixed(2) : '—'}</div>`
        + `<div class="s">${signed(c.gap)} · ${isNum(c.pct) ? c.pct.toFixed(0) : '—'}%</div></td>`;
    }).join('');
    return `<tr${sec === picked ? ' class="picked"' : ''}><th data-pick="${esc(sec)}" title="아래 연도별 표를 이 섹터로">${esc(sec)}</th>${tds}</tr>`;
  }).join('');
  return { head, body };
}

/**
 * 한 섹터의 연도별 평균 표. 행 = 만기, 열 = 연도별 평균 … 현재 / 전주비 / 평균 / 배율 / bp 차 / 백분위.
 * 평균 표본에서 빠진 해(2022 제외가 걸릴 때)는 열 머리에 표시하고 흐리게 둔다 — 숫자는 그대로 보여준다.
 */
export function yearTableHTML(doc, state, sector, data = tableData(doc, state)) {
  const tenors = doc.meta.tenors;
  const years = [...new Set(doc.dates.map((d) => d.slice(0, 4)))];
  const label = histLabelOf(state, doc.dates);
  const exOn = label.includes('제외');
  const dim = (y) => (exOn && y === EXCLUDE_YEAR ? ' class="ex"' : '');
  const head = '<tr><th class="corner">만기</th>'
    + years.map((y) => `<th${dim(y)}>${y}${exOn && y === EXCLUDE_YEAR ? '*' : ''}</th>`).join('')
    + `<th class="sep">현재</th><th>전주비</th><th>${esc(label)} 평균</th><th>배율</th><th>현재−평균</th><th>백분위</th></tr>`;
  const body = tenors.map((t) => {
    const v = legValues(doc, sector, t);
    const c = data.cells[sector] && data.cells[sector][t];
    if (!v || !c) return `<tr><th>${esc(t)}</th><td class="nil" colspan="${years.length + 6}">—</td></tr>`;
    const ym = new Map(yearlyMeans(v, doc.dates).map((o) => [o.year, o.mean]));
    return `<tr data-sector="${esc(sector)}" data-tenor="${esc(t)}"><th>${esc(t)}</th>`
      + years.map((y) => `<td${dim(y)}>${fmt(ym.get(y))}</td>`).join('')
      + `<td class="sep cur">${fmt(c.cur)}</td><td>${signed(c.wow)}</td><td>${fmt(c.mean)}</td>`
      + `<td class="ratio"${bgAttr(heatBg(state.heat, c, data.gapScale))}>${isNum(c.ratio) ? c.ratio.toFixed(2) : '—'}</td>`
      + `<td>${signed(c.gap)}</td><td>${isNum(c.pct) ? c.pct.toFixed(0) + '%' : '—'}</td></tr>`;
  }).join('');
  return { head, body };
}

// ── init ─────────────────────────────────────────────────────────────────────

function fillSelect(el, values, { none } = {}) {
  el.innerHTML = (none ? `<option value="">${esc(none)}</option>` : '')
    + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
}

export async function initCs2() {
  const statusEl = document.getElementById('cs2-status');
  const appEl = document.getElementById('cs2-app');
  if (!statusEl || !appEl) return;

  let doc;
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = await res.json();
  } catch (err) {
    statusEl.className = 'empty';
    statusEl.textContent = `데이터를 불러오지 못했습니다 (${DATA_URL}): ${err.message}. `
      + '로컬 서버로 열어야 합니다(file:// 미지원).';
    return;
  }

  const meta = doc.meta;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { saved = null; }
  const state = mergeState(defaultState(meta), saved, meta);
  const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* noop */ } };

  const $ = (id) => document.getElementById(id);
  const sectors = sectorList(meta);
  fillSelect($('cs2-a-sector'), sectors);
  fillSelect($('cs2-a-tenor'), meta.tenors);
  fillSelect($('cs2-b-sector'), sectors, { none: '선택 안 함 (국고 대비 단일)' });
  fillSelect($('cs2-b-tenor'), meta.tenors);
  fillSelect($('cs2-yt-sector'), sectors);

  const seg = (id, keys, attr) => {
    $(id).innerHTML = keys.map((k) => `<button data-${attr}="${k}">${WINDOW_LABEL[k]}</button>`).join('');
  };
  seg('cs2-view', VIEW_WINDOWS, 'view');
  seg('cs2-hist', HIST_WINDOWS, 'hist');
  $('cs2-ma').innerHTML = MA_WINDOWS.map((n) =>
    `<button data-ma="${n}"><i style="background:${MA_COLOR[n]}"></i>${n}</button>`).join('');

  $('cs2-asof').textContent = meta.sourceLastDate;
  $('cs2-range').textContent = `${meta.firstDate} ~ ${meta.sourceLastDate}`;
  $('cs2-bench').textContent = meta.benchmark;

  function render() {
    $('cs2-a-sector').value = state.a.sector; $('cs2-a-tenor').value = state.a.tenor;
    $('cs2-b-sector').value = state.b.sector; $('cs2-b-tenor').value = state.b.tenor;
    const pair = isPair(state);
    $('cs2-b-tenor').disabled = !pair;
    $('cs2-swap').disabled = !pair;
    $('cs2-clear').disabled = !pair;
    const overview = state.mode === 'overview';
    const table = state.mode === 'table';
    document.querySelectorAll('#cs2-tab button').forEach((b) => b.classList.toggle('active', b.dataset.mode === state.mode));
    document.querySelectorAll('#cs2-ov-tenor button').forEach((b) => b.classList.toggle('active', (b.dataset.tenor === 'all') === state.ovAll));
    $('cs2-detail').style.display = state.mode === 'detail' ? '' : 'none';
    $('cs2-overview').style.display = overview ? '' : 'none';
    $('cs2-table').style.display = table ? '' : 'none';
    $('cs2-ov-tenor-group').style.display = overview ? '' : 'none';
    // 표에는 시간축이 없다 — 차트 기간·이동평균·평균선 토글은 감추고 색 기준을 꺼낸다.
    for (const id of ['cs2-view-group', 'cs2-ma-group']) $(id).style.display = table ? 'none' : '';
    $('cs2-mean').style.display = table ? 'none' : '';
    $('cs2-heat-group').style.display = table ? '' : 'none';
    $('cs2-ex').classList.toggle('active', state.ex2022);
    document.querySelectorAll('#cs2-heat button').forEach((b) => b.classList.toggle('active', b.dataset.heat === state.heat));
    document.querySelectorAll('#cs2-view button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
    document.querySelectorAll('#cs2-hist button').forEach((b) => b.classList.toggle('active', b.dataset.hist === state.hist));
    document.querySelectorAll('#cs2-ma button').forEach((b) => b.classList.toggle('active', !!state.ma[b.dataset.ma]));
    $('cs2-mean').classList.toggle('active', state.showMean);

    if (table) {
      const data = tableData(doc, state);
      const sec = sectors.includes(state.tbSector) ? state.tbSector : state.a.sector;
      const label = histLabelOf(state, doc.dates);
      const mx = matrixHTML(doc, state, data);
      $('cs2-mx-head').innerHTML = mx.head; $('cs2-mx-body').innerHTML = mx.body;
      $('cs2-mx-cap').textContent = `큰 숫자 = 현재 ÷ ${label} 평균 · 아래 = 현재 − 평균(bp) · 백분위`;
      const yt = yearTableHTML(doc, state, sec, data);
      $('cs2-yt-head').innerHTML = yt.head; $('cs2-yt-body').innerHTML = yt.body;
      $('cs2-yt-sector').value = sec;
      $('cs2-legend').style.display = state.heat === 'off' ? 'none' : '';
      $('cs2-legend-text').textContent = {
        ratio: '색 = 배율 · 0.5배 ◀ 1배(무색) ▶ 2배 이상',
        gap: `색 = 현재 − 평균 · −${fmt(data.gapScale)}bp ◀ 0(무색) ▶ +${fmt(data.gapScale)}bp`,
        pct: '색 = 백분위 · 0% ◀ 50%(무색) ▶ 100%',
      }[state.heat] || '';
      return;
    }

    if (overview) {
      const { head, body } = overviewHTML(doc, state);
      $('cs2-ov-head').innerHTML = head;
      $('cs2-ov-body').innerHTML = body;
      $('cs2-ov-cap').textContent = `차트 기간 ${WINDOW_LABEL[state.view]} · 점선 = ${histLabelOf(state, doc.dates)} 평균 · `
        + `${sectorList(meta).length}섹터 × ${overviewTenors(meta, state).length}만기`;
      return;
    }

    const line = buildLine(doc, state);
    const legsCard = $('cs2-legs-card');
    if (!line.values) {
      $('cs2-title').textContent = `${line.missing} — 해당 만기 데이터 없음`;
      $('cs2-stats').innerHTML = '';
      window.Plotly.purge('cs2-chart');
      legsCard.style.display = 'none';
      return;
    }
    const end = lastValidIndex(line.values);
    const hist = histStats(line.values, doc.dates, state, end);
    $('cs2-title').textContent = `${line.title} (bp)`;
    $('cs2-mode').textContent = pair ? '두 스프레드의 차 A − B' : '국고 동일만기 대비 스프레드';
    $('cs2-stats').innerHTML = statsHTML(line, hist, histLabelOf(state, doc.dates), doc.dates);
    $('cs2-hist-note').textContent = isNum(hist.mean)
      ? `평균 표본 ${doc.dates[startIndexFor(doc.dates, state.hist, end)]} ~ ${doc.dates[end]}`
        + `${histLabelOf(state, doc.dates).includes('제외') ? ` · ${EXCLUDE_YEAR}년 제외` : ''} (${hist.n}영업일)`
      : '';
    renderMain(doc, state, line, hist);
    legsCard.style.display = pair ? '' : 'none';
    if (pair) {
      $('cs2-legs-title').textContent = `두 다리 — A ${legName(state.a)} · B ${legName(state.b)} (각각 국고 대비 bp)`;
      renderLegs(doc, state, line);
    }
  }
  const commit = () => { save(); render(); };

  $('cs2-a-sector').addEventListener('change', (e) => { state.a.sector = e.target.value; commit(); });
  $('cs2-a-tenor').addEventListener('change', (e) => { state.a.tenor = e.target.value; commit(); });
  $('cs2-b-sector').addEventListener('change', (e) => {
    // B 를 처음 켤 때는 A 와 같은 만기에서 시작한다(같은 만기 비교가 가장 흔한 쓰임).
    if (!isPair(state) && e.target.value !== NONE) state.b.tenor = state.a.tenor;
    state.b.sector = e.target.value; commit();
  });
  $('cs2-b-tenor').addEventListener('change', (e) => { state.b.tenor = e.target.value; commit(); });
  $('cs2-swap').addEventListener('click', () => {
    if (!isPair(state)) return;
    const a = { ...state.a }; state.a = { ...state.b }; state.b = a; commit();
  });
  $('cs2-clear').addEventListener('click', () => { state.b.sector = NONE; commit(); });
  $('cs2-view').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; state.view = b.dataset.view; commit();
  });
  $('cs2-hist').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; state.hist = b.dataset.hist; commit();
  });
  $('cs2-ma').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const n = Number(b.dataset.ma); state.ma[n] = !state.ma[n]; commit();
  });
  $('cs2-mean').addEventListener('click', () => { state.showMean = !state.showMean; commit(); });
  $('cs2-ex').addEventListener('click', () => { state.ex2022 = !state.ex2022; commit(); });
  $('cs2-heat').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; state.heat = b.dataset.heat; commit();
  });
  $('cs2-yt-sector').addEventListener('change', (e) => { state.tbSector = e.target.value; commit(); });
  // 표의 섹터 이름 → 연도별 표를 그 섹터로. 칸(또는 연도별 표의 행) → 그 섹터·만기 추이(개별 모드).
  const toDetail = (el) => {
    state.a = { sector: el.dataset.sector, tenor: el.dataset.tenor };
    state.b.sector = NONE; state.mode = 'detail'; commit(); window.scrollTo({ top: 0 });
  };
  $('cs2-mx-body').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-pick]');
    if (th) { state.tbSector = th.dataset.pick; commit(); return; }
    const td = e.target.closest('td[data-sector]'); if (td) toDetail(td);
  });
  $('cs2-yt-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-sector]'); if (tr) toDetail(tr);
  });
  $('cs2-tab').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; state.mode = b.dataset.mode; commit();
  });
  $('cs2-ov-tenor').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; state.ovAll = b.dataset.tenor === 'all'; commit();
  });
  // 격자 칸 → 그 섹터·만기를 A 로 잡고 개별 모드로. B 는 비운다(칸은 국고 대비 단일 스프레드다).
  $('cs2-ov-body').addEventListener('click', (e) => {
    const td = e.target.closest('td[data-sector]'); if (!td) return;
    state.a = { sector: td.dataset.sector, tenor: td.dataset.tenor };
    state.b.sector = NONE;
    state.mode = 'detail';
    commit();
    window.scrollTo({ top: 0 });
  });

  statusEl.style.display = 'none';
  appEl.style.display = '';
  render();
}
