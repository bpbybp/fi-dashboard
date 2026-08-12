// msb-ktb.js — MS-1 국고·통안 상대가치 페이지 컨트롤러 (msb-ktb.html 전용).
//   측정만 한다. 판단·시그널·배지 없음 — 수치와 축만 낸다.
//   데이터: data/msb-ktb-nodes.json 단일 로드 (fetch, 로컬 서버 서빙 전제 — file:// 미지원).
//   계보 규약(빌더와 동일): M2·M3 = 통안 접미 02·03, K2·K3 = 국고 원발행만기 2.5년 기준.
//   전 수치 bp. 원본 민평 금리는 데이터에 없다.
//   no-build: 의존성은 Plotly(vendor) 뿐. DOM 접근은 initMsbKtb() 안에만 둔다(테스트 import 가능).

// 매트릭스 셀 농도는 CV-3(curve-rv)의 대칭 컬러스케일을 그대로 재사용한다. 새로 만들지 않는다.
import { cellAlphaPct } from './cv-matrix.js';

const DATA_URL = 'data/msb-ktb-nodes.json';

// 팔레트·폰트는 사이트 기존 토큰 그대로(rv-curves.js 와 동일). 새 스타일 만들지 않는다.
const C = {
  bg: '#0d1117', accent: '#58a6ff', grid: '#21262d', axis: '#484f58',
  text: '#c9d1d9', muted: '#8b949e',
};
const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const CONFIG = {
  displayModeBar: true, displaylogo: false,
  modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toImage'],
  scrollZoom: true, responsive: true, doubleClick: 'reset',
};

// 고스트 오프셋(영업일 인덱스). rv-curves.js 의 GHOST_OFFSET 관례를 따른다.
export const GHOST_OFFSET = { '1w': 5, '1m': 21 };
// 변화 계산 호라이즌(영업일)
export const CHANGE_OFFSET = { '1D': 1, '1W': 5, '1M': 21 };

export const Z_WINDOW = 250;
export const Z_MIN_PERIODS = 120;
export const PCTILE_WINDOW = 250;

// ── 섹션 A: K3 기준 상대곡선 ────────────────────────────────────────────────
// K3 를 0 으로 놓았을 때 각 계보가 몇 bp 위/아래에 있는가.
//   M2 = sp.M2_K3            (M2 − K3)
//   M3 = sp.M3_K3            (M3 − K3)
//   K2 = -liq.ktb            (liq.ktb = K3 − K2 이므로 K2 − K3 = -liq.ktb)
//   K3 = 0 기준선
export const CURVE_LINES = [
  { key: 'M2', label: 'M2', color: '#58a6ff' },
  { key: 'M3', label: 'M3', color: '#a371f7' },
  { key: 'K2', label: 'K2', color: '#3fb950' },
  { key: 'K3', label: 'K3 (기준)', color: '#8b949e' },
];

const negate = arr => arr.map(v => (v == null ? null : -v));

// rec(series[date]) → { M2, M3, K2, K3 } 각 노드별 bp 배열.
// null 은 절대 채우지 않고 그대로 둔다 — 외삽 금지 원칙의 시각적 대응(선이 끊긴다).
export function relativeCurve(rec, nodeCount) {
  if (!rec) return null;
  const n = nodeCount ?? rec.sp.M2_K3.length;
  return {
    M2: rec.sp.M2_K3.slice(),
    M3: rec.sp.M3_K3.slice(),
    K2: negate(rec.liq.ktb),
    K3: new Array(n).fill(0),
  };
}

// ── 섹션 B: 계열 정의 ───────────────────────────────────────────────────────
// adj 는 '보조' 그룹으로 분리 표기. 색은 대응하는 sp 와 같게 두고 점선으로 구분한다.
export const SERIES_DEFS = [
  { key: 'sp.M2_K3', group: 'main', color: '#58a6ff', dash: 'solid' },
  { key: 'sp.M2_K2', group: 'main', color: '#3fb950', dash: 'solid' },
  { key: 'sp.M3_K3', group: 'main', color: '#a371f7', dash: 'solid' },
  { key: 'sp.M3_K2', group: 'main', color: '#f0883e', dash: 'solid' },
  { key: 'liq.msb', group: 'main', color: '#f85149', dash: 'solid' },
  { key: 'liq.ktb', group: 'main', color: '#56d364', dash: 'solid' },
  { key: 'liq.delta', group: 'main', color: '#e85fa8', dash: 'solid' },
  { key: 'adj.M2_K3', group: 'aux', color: '#58a6ff', dash: 'dot' },
  { key: 'adj.M2_K2', group: 'aux', color: '#3fb950', dash: 'dot' },
  { key: 'adj.M3_K3', group: 'aux', color: '#a371f7', dash: 'dot' },
  { key: 'adj.M3_K2', group: 'aux', color: '#f0883e', dash: 'dot' },
];
export const DEFAULT_SERIES = ['sp.M2_K3'];
export const DEFAULT_NODE = 1.75;

// doc + 계열키 + 노드 index → 날짜순 값 배열(없는 값은 null).
export function seriesValues(doc, key, nodeIdx, dates) {
  const [grp, sub] = key.split('.');
  const ds = dates || Object.keys(doc.series).sort();
  return ds.map(d => {
    const rec = doc.series[d];
    const g = rec && rec[grp];
    const arr = g && g[sub];
    const v = arr ? arr[nodeIdx] : null;
    return v == null ? null : v;
  });
}

// 계열마다 시작일이 다르다(M2_K3 는 2017-02, M3 계열은 2021-09). 첫 관측일 이전은
// 그리지 않는다 — 0 으로 채우면 없던 스프레드가 있었던 것처럼 보인다.
export function truncateToFirstObs(dates, values) {
  const i = values.findIndex(v => v != null);
  if (i < 0) return { dates: [], values: [], startIdx: -1 };
  return { dates: dates.slice(i), values: values.slice(i), startIdx: i };
}

// ── 롤링 z (rolling 250, min_periods 120) ───────────────────────────────────
// 표본표준편차(ddof=1). 창 안 유효 관측이 min_periods 미만이거나 σ=0 이면 null.
export function rollingZ(values, { window = Z_WINDOW, minPeriods = Z_MIN_PERIODS } = {}) {
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    const from = Math.max(0, i - window + 1);
    const win = [];
    for (let j = from; j <= i; j++) if (values[j] != null) win.push(values[j]);
    if (win.length < minPeriods) continue;
    const mean = win.reduce((s, x) => s + x, 0) / win.length;
    const varr = win.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (win.length - 1);
    const sd = Math.sqrt(varr);
    if (!(sd > 0)) continue;
    out[i] = (v - mean) / sd;
  }
  return out;
}

// 최근 window 관측 중 현재값 이하의 비율(%). 표본이 min_periods 미만이면 null.
export function pctileRank(values, idx, { window = PCTILE_WINDOW, minPeriods = Z_MIN_PERIODS } = {}) {
  const v = values[idx];
  if (v == null) return null;
  const win = [];
  for (let j = Math.max(0, idx - window + 1); j <= idx; j++) if (values[j] != null) win.push(values[j]);
  if (win.length < minPeriods) return null;
  return (win.filter(x => x <= v).length / win.length) * 100;
}

// idx 기준 1D/1W/1M 변화(bp). 해당 영업일 전 값이 없으면 null.
export function changesAt(values, idx) {
  const out = {};
  for (const [tag, off] of Object.entries(CHANGE_OFFSET)) {
    const j = idx - off;
    const prev = j >= 0 ? values[j] : null;
    out[tag] = (prev == null || values[idx] == null) ? null : round1(values[idx] - prev);
  }
  return out;
}

const round1 = v => (v == null ? null : Math.round(v * 10) / 10);

// 선택 일자 → 실제 데이터가 있는 인덱스. 정확히 없으면 그 이전 최근 영업일.
export function resolveDateIndex(dates, iso) {
  if (!dates.length) return -1;
  if (!iso) return dates.length - 1;
  let lo = 0, hi = dates.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= iso) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans < 0 ? 0 : ans;
}

// 기간 프리셋 → 표시 시작 인덱스
export const RANGE_SESSIONS = { '1y': 250, '3y': 750, '5y': 1250, all: null };
export function rangeStartIndex(len, preset) {
  const n = RANGE_SESSIONS[preset];
  return n == null ? 0 : Math.max(0, len - n);
}

const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : v.toFixed(d));
const signed = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d));

// ── 섹션 C: 계열 × 노드 매트릭스 ────────────────────────────────────────────
// 변화 호라이즌은 전부 '유효일(영업일) 인덱스' 오프셋이다 — 달력 일수가 아니다.
// 데이터가 이미 휴일 캐리를 걷어낸 영업일 격자라 행 오프셋이 곧 영업일 수다.
export const MATRIX_MODES = [
  { key: '1w', label: '1W 변화', kind: 'change', biz: 5, unit: 'bp', digits: 1 },
  { key: '1m', label: '1M 변화', kind: 'change', biz: 21, unit: 'bp', digits: 1 },
  { key: '3m', label: '3M 변화', kind: 'change', biz: 63, unit: 'bp', digits: 1 },
  { key: 'z250', label: 'z250', kind: 'z', unit: '', digits: 2 },
  { key: 'level', label: '현재 레벨', kind: 'level', unit: 'bp', digits: 1 },
];
export const DEFAULT_MATRIX_MODE = '1m';
export const MATRIX_MAIN_KEYS = SERIES_DEFS.filter(d => d.group === 'main').map(d => d.key);
export const MATRIX_AUX_KEYS = SERIES_DEFS.filter(d => d.group === 'aux').map(d => d.key);

// 계열 × 노드 매트릭스(순수). valuesOf/zOf 를 주입받아 캐시 정책을 호출부에 맡긴다.
//   - maxAbs 는 이 매트릭스(=이 모드) 안에서만 구한다. 모드가 다르면 스케일도 다르다
//     (bp 변화와 z 를 같은 농도 기준에 태우면 색이 서로 다른 뜻을 갖게 된다).
//   - 값이 없으면 null 그대로. 0 으로 대체하지 않는다.
export function buildMatrix({ keys, nodes, mode, valuesOf, zOf, idx }) {
  const baseIdx = mode.kind === 'change' ? idx - mode.biz : null;
  const cells = keys.map(k => nodes.map(n => {
    if (mode.kind === 'level') return valuesOf(k, n)[idx] ?? null;
    if (mode.kind === 'z') return zOf(k, n)[idx] ?? null;
    const vals = valuesOf(k, n);
    const cur = vals[idx];
    const prev = baseIdx >= 0 ? vals[baseIdx] : null;
    return (cur == null || prev == null) ? null : round1(cur - prev);
  }));
  let maxAbs = 0;
  for (const row of cells) for (const v of row) {
    if (v != null && Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
  }
  return { keys, nodes, mode, cells, maxAbs, idx, baseIdx };
}

// 셀 클릭 → B 섹션 선택 동기화. 그 셀 하나로 맞춘다(누적이 아니라 교체).
export function syncFromCell(state, key, node) {
  state.series = new Set([key]);
  state.node = node;
  return state;
}

// ── 섹션 D: 유동성 분해 ─────────────────────────────────────────────────────
export const D_PAIRS = ['M2_K3', 'M2_K2', 'M3_K3', 'M3_K2'];
export const DEFAULT_PAIR = 'M2_K3';
// 상단 3계열(항등식 sp = adj + liq.delta) / 하단 2계열(계보 효과의 출처)
export const dTopKeys = pair => [`sp.${pair}`, `adj.${pair}`, 'liq.delta'];
export const D_BOTTOM_KEYS = ['liq.msb', 'liq.ktb'];

// ── 레이아웃 ────────────────────────────────────────────────────────────────
function baseLayout(extra) {
  return Object.assign({
    paper_bgcolor: 'transparent', plot_bgcolor: C.bg,
    font: { color: C.muted, family: FONT, size: 11 },
    dragmode: 'zoom',
    margin: { l: 54, r: 16, t: 14, b: 40 }, hovermode: 'x unified',
    legend: { orientation: 'h', font: { size: 10 }, y: -0.18, yanchor: 'top' },
  }, extra);
}

function curveLayout(nodes) {
  return baseLayout({
    uirevision: 'ms-a',
    xaxis: {
      title: { text: '잔존(년)', font: { size: 10 } }, type: 'linear', uirevision: 'ms-a',
      tickvals: nodes, ticktext: nodes.map(n => n.toFixed(2)),
      gridcolor: C.grid, linecolor: C.axis, tickfont: { size: 10 }, zeroline: false,
    },
    yaxis: {
      title: { text: 'bp (K3 기준)', font: { size: 10 } }, uirevision: 'ms-a',
      gridcolor: C.grid, linecolor: C.axis, tickfont: { size: 10 },
      zeroline: true, zerolinecolor: C.axis, zerolinewidth: 1,
    },
  });
}

function tsLayout(title, zeroline) {
  return baseLayout({
    uirevision: 'ms-b',
    xaxis: {
      type: 'date', uirevision: 'ms-b',
      gridcolor: C.grid, linecolor: C.axis, tickfont: { size: 10 }, zeroline: false,
    },
    yaxis: {
      title: { text: title, font: { size: 10 } },
      gridcolor: C.grid, linecolor: C.axis, tickfont: { size: 10 },
      zeroline: zeroline, zerolinecolor: C.axis, zerolinewidth: 1,
    },
    showlegend: false,
    margin: { l: 54, r: 16, t: 14, b: 34 },
  });
}

// ── init (DOM) ──────────────────────────────────────────────────────────────
export async function initMsbKtb() {
  const $ = id => document.getElementById(id);
  const app = $('ms-app');
  if (!app) return;

  const status = $('ms-status');
  let doc;
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = await res.json();
  } catch (err) {
    status.className = 'empty';
    status.textContent = `데이터를 불러오지 못했습니다 (${err.message}). 로컬 서버로 열어야 합니다 — file:// 미지원.`;
    return;
  }

  const dates = Object.keys(doc.series).sort();
  const nodes = doc.nodes;
  status.remove();
  app.style.display = '';

  $('ms-last').textContent = dates[dates.length - 1] || '—';
  $('ms-count').textContent = `유효일수 ${dates.length.toLocaleString()}일`;
  $('ms-range').textContent = `${dates[0]} ~ ${dates[dates.length - 1]}`;

  const state = {
    date: dates[dates.length - 1],
    ghost: new Set(['1w', '1m']),
    series: new Set(DEFAULT_SERIES),
    node: nodes.includes(DEFAULT_NODE) ? DEFAULT_NODE : nodes[0],
    range: 'all',
    matrixMode: DEFAULT_MATRIX_MODE,
    matrixAux: false,
    pair: DEFAULT_PAIR,
  };

  // 선택 계열·노드에 대해서만 lazy 계산. 전 계열 사전 계산 금지(2556일 × 11계열).
  const cacheVals = new Map(), cacheZ = new Map();
  const valuesOf = (key, node) => {
    const ck = `${key}|${node}`;
    if (!cacheVals.has(ck)) cacheVals.set(ck, seriesValues(doc, key, nodes.indexOf(node), dates));
    return cacheVals.get(ck);
  };
  const zOf = (key, node) => {
    const ck = `${key}|${node}`;
    if (!cacheZ.has(ck)) cacheZ.set(ck, rollingZ(valuesOf(key, node)));
    return cacheZ.get(ck);
  };

  // ── 섹션 A ──
  const dateInput = $('ms-a-date');
  dateInput.min = dates[0];
  dateInput.max = dates[dates.length - 1];
  dateInput.value = state.date;

  function renderCurve() {
    const idx = resolveDateIndex(dates, state.date);
    const asof = dates[idx];
    $('ms-a-asof').textContent = asof === state.date ? asof : `${asof} (선택 ${state.date} → 직전 영업일)`;

    const cur = relativeCurve(doc.series[asof], nodes.length);
    const traces = [];
    for (const line of CURVE_LINES) {
      traces.push({
        type: 'scatter', mode: 'lines+markers', name: line.label, legendgroup: line.key,
        x: nodes, y: cur[line.key], connectgaps: false,
        line: { color: line.color, width: line.key === 'K3' ? 1.4 : 2, dash: line.key === 'K3' ? 'dash' : 'solid' },
        marker: { size: line.key === 'K3' ? 0 : 5 },
        hovertemplate: `<b>${line.label}</b> %{y:.1f} bp<extra></extra>`,
      });
      if (line.key === 'K3') continue;
      // 고스트: 같은 색·legendgroup, 점선+투명도, 범례 미표시(rv-curves 관례).
      for (const [tag, spec] of [['1w', { dash: 'dot', opacity: 0.55 }], ['1m', { dash: 'dashdot', opacity: 0.35 }]]) {
        if (!state.ghost.has(tag)) continue;
        const gi = idx - GHOST_OFFSET[tag];
        if (gi < 0) continue;
        const g = relativeCurve(doc.series[dates[gi]], nodes.length);
        traces.push({
          type: 'scatter', mode: 'lines', name: `${line.label} ${tag.toUpperCase()}`,
          legendgroup: line.key, showlegend: false, opacity: spec.opacity,
          x: nodes, y: g[line.key], connectgaps: false,
          line: { color: line.color, width: 1.2, dash: spec.dash },
          hovertemplate: `${line.label} ${tag.toUpperCase()} (${dates[gi]}) %{y:.1f} bp<extra></extra>`,
        });
      }
    }
    window.Plotly.react($('ms-a-chart'), traces, curveLayout(nodes), CONFIG);

    const rec = doc.series[asof];
    $('ms-a-cover').textContent = `종목수 M2 ${rec.cover.M2} · M3 ${rec.cover.M3} · K2 ${rec.cover.K2} · K3 ${rec.cover.K3}`;
    $('ms-a-flags').textContent = rec.flags.length ? rec.flags.join(' · ') : '없음';
  }

  // ── 섹션 B ──
  function renderSeriesToggles() {
    const chip = d => `<button class="chip${state.series.has(d.key) ? ' on' : ''}" data-key="${d.key}"
      style="--chip:${d.color}">${d.key}</button>`;
    $('ms-b-main').innerHTML = SERIES_DEFS.filter(d => d.group === 'main').map(chip).join('');
    $('ms-b-aux').innerHTML = SERIES_DEFS.filter(d => d.group === 'aux').map(chip).join('');
  }

  function renderTimeSeries() {
    const picked = SERIES_DEFS.filter(d => state.series.has(d.key));
    const lvl = [], zs = [];
    for (const d of picked) {
      const vals = valuesOf(d.key, state.node);
      const t = truncateToFirstObs(dates, vals);
      const from = Math.max(0, rangeStartIndex(dates.length, state.range) - t.startIdx);
      lvl.push({
        type: 'scatter', mode: 'lines', name: d.key,
        x: t.dates.slice(from), y: t.values.slice(from), connectgaps: false,
        line: { color: d.color, width: 1.5, dash: d.dash },
        hovertemplate: `<b>${d.key}</b> %{y:.1f} bp<extra></extra>`,
      });
      const z = zOf(d.key, state.node).slice(t.startIdx);
      zs.push({
        type: 'scatter', mode: 'lines', name: d.key,
        x: t.dates.slice(from), y: z.slice(from), connectgaps: false,
        line: { color: d.color, width: 1.3, dash: d.dash },
        hovertemplate: `<b>${d.key}</b> z %{y:.2f}<extra></extra>`,
      });
    }
    window.Plotly.react($('ms-b-level'), lvl, tsLayout('bp', true), CONFIG);
    window.Plotly.react($('ms-b-z'), zs, tsLayout(`z${Z_WINDOW}`, true), CONFIG);
    renderTable(picked);
  }

  function renderTable(picked) {
    const last = dates.length - 1;
    const rows = picked.map(d => {
      const vals = valuesOf(d.key, state.node);
      const ch = changesAt(vals, last);
      const z = zOf(d.key, state.node)[last];
      const p = pctileRank(vals, last);
      return `<tr>
        <td><span class="dot" style="background:${d.color}"></span>${d.key}</td>
        <td class="n">${fmt(vals[last], 1)}</td>
        <td>${signed(ch['1D'], 1)}</td>
        <td>${signed(ch['1W'], 1)}</td>
        <td>${signed(ch['1M'], 1)}</td>
        <td>${fmt(z, 2)}</td>
        <td>${p == null ? '—' : p.toFixed(0)}</td>
      </tr>`;
    }).join('');
    $('ms-b-table').innerHTML = rows
      || '<tr><td colspan="7" class="empty">선택된 계열 없음</td></tr>';
    $('ms-b-node-label').textContent = state.node.toFixed(2);
  }

  // ── 섹션 C: 계열 × 노드 매트릭스 ──
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderMatrix() {
    const mode = MATRIX_MODES.find(m => m.key === state.matrixMode);
    const keys = state.matrixAux ? [...MATRIX_MAIN_KEYS, ...MATRIX_AUX_KEYS] : MATRIX_MAIN_KEYS;
    const idx = dates.length - 1;
    // z 는 이 모드일 때만 계산한다(전 셀 사전 계산 금지). 캐시는 B 섹션과 공유.
    const M = buildMatrix({ keys, nodes, mode, valuesOf, zOf, idx });
    const onlyOne = state.series.size === 1 ? [...state.series][0] : null;

    const head = nodes.map(n => `<th>${n.toFixed(2)}</th>`).join('');
    const rows = M.cells.map((row, r) => {
      const key = keys[r];
      const tds = row.map((v, c) => {
        const node = nodes[c];
        const sel = key === onlyOne && node === state.node ? ' sel' : '';
        const attrs = `data-key="${esc(key)}" data-node="${node}"`;
        if (v == null) {
          return `<td class="nil${sel}" ${attrs} title="${esc(key)} @${node.toFixed(2)}년 · 값 없음(관측 범위 밖 또는 계열 시작 전)">·</td>`;
        }
        const pct = cellAlphaPct(v, M.maxAbs);
        const cvar = v > 0 ? '--cv3-pos' : '--cv3-neg';
        const bg = pct ? ` style="background:color-mix(in srgb, var(${cvar}) ${pct}%, transparent)"` : '';
        const vals = valuesOf(key, node);
        const cur = vals[idx];
        const base = M.baseIdx != null && M.baseIdx >= 0 ? vals[M.baseIdx] : null;
        const tip = mode.kind === 'change'
          ? `${key} @${node.toFixed(2)}년 · 현재 ${fmt(cur, 1)}bp · ${dates[M.baseIdx]} ${fmt(base, 1)}bp · 변화 ${signed(v, 1)}bp`
          : `${key} @${node.toFixed(2)}년 · 현재 ${fmt(cur, 1)}bp · ${mode.label} ${fmt(v, mode.digits)}`;
        return `<td class="cell${sel}"${bg} ${attrs} title="${esc(tip)}">${
          mode.kind === 'change' ? signed(v, mode.digits) : fmt(v, mode.digits)}</td>`;
      }).join('');
      return `<tr><th>${esc(key)}</th>${tds}</tr>`;
    }).join('');

    const baseNote = M.baseIdx != null
      ? (M.baseIdx >= 0 ? `기준 ${dates[idx]} − ${dates[M.baseIdx]} (${mode.biz}영업일)` : '이력 부족')
      : `기준 ${dates[idx]}`;
    $('ms-c-asof').textContent = `${baseNote} · 단위 ${mode.unit || 'z'} · 스케일 최대 |값| ${M.maxAbs.toFixed(mode.digits)}`;
    $('ms-c-table').innerHTML =
      `<thead><tr><th>계열 \\ 노드(년)</th>${head}</tr></thead><tbody>${rows}</tbody>`;
  }

  // ── 섹션 D: 유동성 분해 ──
  function dSeriesDef(key) {
    const found = SERIES_DEFS.find(d => d.key === key);
    return found || { key, color: C.muted, dash: 'solid' };
  }

  function dTrace(key, dashOverride) {
    const d = dSeriesDef(key);
    const vals = valuesOf(key, state.node);
    // 계열마다 시작일이 다르다(sp 는 2017-02, adj·liq 는 M3 계보가 생긴 뒤). 각자 자기
    // 시작일부터 그린다 — 짧은 쪽에 맞춰 앞을 잘라내지 않는다.
    const t = truncateToFirstObs(dates, vals);
    const from = Math.max(0, rangeStartIndex(dates.length, state.range) - t.startIdx);
    return {
      type: 'scatter', mode: 'lines', name: key,
      x: t.dates.slice(from), y: t.values.slice(from), connectgaps: false,
      line: { color: d.color, width: 1.5, dash: dashOverride || 'solid' },
      hovertemplate: `<b>${key}</b> %{y:.1f} bp<extra></extra>`,
    };
  }

  function renderDecomp() {
    const [spK, adjK] = dTopKeys(state.pair);
    const top = [dTrace(spK), dTrace(adjK), dTrace('liq.delta', 'dot')];
    top[1].line.color = '#f0883e'; // adj 는 sp 와 같은 축에서 겹치므로 색을 분리
    window.Plotly.react($('ms-d-top'), top, tsLayout('bp', true), CONFIG);
    window.Plotly.react($('ms-d-bottom'), D_BOTTOM_KEYS.map(k => dTrace(k)), tsLayout('bp', true), CONFIG);

    const last = dates.length - 1;
    const rowsHtml = [spK, adjK, 'liq.delta', ...D_BOTTOM_KEYS].map(k => {
      const d = dSeriesDef(k);
      const color = k === adjK ? '#f0883e' : d.color;
      const vals = valuesOf(k, state.node);
      return `<tr>
        <td><span class="dot" style="background:${color}"></span>${k}</td>
        <td class="n">${fmt(vals[last], 1)}</td>
        <td>${signed(changesAt(vals, last)['1M'], 1)}</td>
        <td>${fmt(zOf(k, state.node)[last], 2)}</td>
      </tr>`;
    }).join('');
    $('ms-d-table').innerHTML = rowsHtml;
    $('ms-d-node-label').textContent = state.node.toFixed(2);
    document.querySelectorAll('#ms-d-pair button').forEach(b =>
      b.classList.toggle('active', b.dataset.pair === state.pair));
  }

  function renderAll() { renderCurve(); renderTimeSeries(); renderMatrix(); renderDecomp(); }

  // ── 컨트롤 ──
  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    state.date = dateInput.value;
    renderCurve();
  });
  $('ms-a-ghost').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    const tag = b.dataset.ghost;
    if (state.ghost.has(tag)) state.ghost.delete(tag); else state.ghost.add(tag);
    b.classList.toggle('active', state.ghost.has(tag));
    renderCurve();
  });
  app.addEventListener('click', e => {
    const chip = e.target.closest('.chip'); if (!chip) return;
    const k = chip.dataset.key;
    if (state.series.has(k)) state.series.delete(k); else state.series.add(k);
    chip.classList.toggle('on', state.series.has(k));
    renderTimeSeries();
    renderMatrix(); // 선택 셀 하이라이트 동기
  });
  $('ms-b-node').addEventListener('change', e => {
    state.node = Number(e.target.value);
    renderTimeSeries();
    renderMatrix();
    renderDecomp(); // 노드는 B·D 공유
  });
  $('ms-b-range').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.range = b.dataset.range;
    document.querySelectorAll('#ms-b-range button').forEach(x => x.classList.toggle('active', x === b));
    renderTimeSeries();
    renderDecomp(); // 기간도 B·D 공유
  });

  // 섹션 C 컨트롤
  $('ms-c-mode').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.matrixMode = b.dataset.mode;
    document.querySelectorAll('#ms-c-mode button').forEach(x => x.classList.toggle('active', x === b));
    renderMatrix();
  });
  $('ms-c-aux').addEventListener('change', e => {
    state.matrixAux = e.target.checked;
    renderMatrix();
  });
  // 셀 클릭 → B 섹션(계열·노드) 동기. 노드는 D 와도 공유하므로 셋 다 다시 그린다.
  // 값 없는 셀(td.nil)은 대상이 아니다 — 동기해봐야 B·D 가 통째로 비어 고장처럼 보인다.
  $('ms-c-table').addEventListener('click', e => {
    const td = e.target.closest('td.cell[data-key]'); if (!td) return;
    syncFromCell(state, td.dataset.key, Number(td.dataset.node));
    $('ms-b-node').value = String(state.node);
    document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', state.series.has(c.dataset.key)));
    renderTimeSeries();
    renderMatrix();
    renderDecomp();
  });

  // 섹션 D 컨트롤
  $('ms-d-pair').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.pair = b.dataset.pair;
    renderDecomp();
  });

  // 노드 셀렉트 채우기
  $('ms-b-node').innerHTML = nodes.map(n =>
    `<option value="${n}"${n === state.node ? ' selected' : ''}>${n.toFixed(2)}년</option>`).join('');
  document.querySelectorAll('#ms-a-ghost button').forEach(b =>
    b.classList.toggle('active', state.ghost.has(b.dataset.ghost)));
  document.querySelectorAll('#ms-b-range button').forEach(b =>
    b.classList.toggle('active', b.dataset.range === state.range));
  document.querySelectorAll('#ms-c-mode button').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === state.matrixMode));

  renderSeriesToggles();
  renderAll();
}
