// rv-curves.js — Curve RV 섹터 커브 오버레이 패널 (CV-1). curve-rv 페이지 전용.
//   측정만: 전 섹터의 스프레드/절대금리 커브를 한 차트에 겹쳐 그린다. 판단·시그널 없음.
//   데이터: window.FENRIR_SERIES['credit-spread'] (기존 로드분 재사용, 신규 fetch 없음).
//   단위 규약: 국고채권_* = 금리 레벨(%). 나머지 섹터 = 국고 대비 스프레드(%p).
//     yield 모드: 섹터금리(노드) = 국고(동일노드) + 스프레드(동일노드). 국고 자신은 레벨 그대로.
//     spread 모드: %p → bp(×100). 국고 행은 스프레드 0이라 제외.
//   결측: 어느 한쪽 노드가 null이면 해당 노드 skip(보간·connectgaps 금지).

const COLORS = {
  bg: '#0d1117', accent: '#58a6ff', grid: '#21262d', axis: '#484f58',
  text: '#c9d1d9', muted: '#8b949e',
};
const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
// CV-2: 축 줌·이동 활성화. 드래그=구간 확대, 휠=줌, 축 드래그=이동, 더블클릭=원복.
//   모드바는 hover 시에만 노출, 줌·팬·리셋만 남긴다(내보내기는 기존 PNG 프리셋이 정본).
const CONFIG = {
  displayModeBar: true, displaylogo: false,
  modeBarButtonsToRemove: ['select2d', 'lasso2d', 'autoScale2d', 'toImage'],
  scrollZoom: true, responsive: true, doubleClick: 'reset',
};
const LS_KEY = 'curve-rv-curves';

const GHOST_OFFSET = { '1m': 21, '3m': 63 }; // 영업일(인덱스) 오프셋

// 등급 순서 그라데이션: AAA(파랑) → BBB+(적색). 국고는 --accent(참조선).
const GRADE_COLORS = {
  'AAA': '#4c8dff', 'AA+': '#6e7bff', 'AA0': '#9b6bf2',
  'AA-': '#c55cd6', 'A+': '#e85fa8', 'A0': '#f2726d', 'BBB+': '#f85149',
};
const DASH_FAMILIES = ['카드채', '여전채']; // 등급 내 패밀리 구분: 이들은 dash, 나머지 solid

// 등급 안에서의 패밀리 색 미세조정 — GRADE_COLORS 보다 우선한다.
//   AAA 한 등급에 공사·은행·회사에 더해 산금·중금까지 5개가 몰려 전부 같은 파랑 solid 가 되면
//   차트에서 서로 분간이 안 된다. 정책금융기관채(산금·중금)만 같은 파랑 계열의 명도 변주로 뗀다.
//   '등급=색' 규약은 유지(계열을 바꾸지 않는다). 되돌리려면 이 맵을 비우면 된다.
const FAMILY_COLORS = { '산금채': '#8ab4ff', '중금채': '#2f6fe0' };

// 기본 노출 섹터(그 외는 legendonly). 국고채권은 금리 모드에서만 추가 노출.
const DEFAULT_VISIBLE = new Set(['산금채AAA', '중금채AAA', '공사채AAA', '은행채AAA', '회사채AAA', '회사채AA-', '회사채A0', '회사채BBB+']);

// ── 순수 계산 (테스트 대상) ──

// 특정 인덱스(영업일)에서 한 섹터의 커브를 만든다. null 노드는 x/y 모두 제외.
//   mode='yield': 국고 레벨 + 스프레드 합성(국고 자신은 레벨). 단위 % → y는 %.
//   mode='spread': 스프레드 %p → bp. 국고채권은 빈 배열(스프레드 0, 무의미).
export function buildCurveAtIndex(data, sector, idx, mode) {
  const { meta, series } = data;
  const mats = meta.maturities, nodes = meta.nodes;
  const isKtb = sector === '국고채권';
  const x = [], y = [];
  if (mode === 'spread' && isKtb) return { x, y }; // 국고 + spread → 명시적 제외
  for (let i = 0; i < mats.length; i++) {
    const ktbArr = series['국고채권_' + mats[i]];
    const secArr = series[sector + '_' + mats[i]];
    const ktb = ktbArr ? ktbArr[idx] : null;
    const raw = secArr ? secArr[idx] : null;
    let val = null;
    if (mode === 'yield') {
      if (isKtb) val = num(ktb) ? ktb : null;
      else if (num(ktb) && num(raw)) val = ktb + raw; // 절대금리 = 국고 + 스프레드
    } else { // spread
      if (num(raw)) val = raw * 100; // %p → bp
    }
    if (val == null) continue; // 결측 노드 skip (보간 금지)
    x.push(nodes[i]);
    y.push(val);
  }
  return { x, y };
}

// 최신 인덱스에서 offsetBizDays 만큼 과거로. 범위 밖이면 null.
export function resolveGhostIndex(dates, offsetBizDays) {
  const idx = dates.length - 1 - offsetBizDays;
  return (idx >= 0 && idx < dates.length) ? idx : null;
}

function num(v) { return typeof v === 'number' && Number.isFinite(v); }
function familyOf(sector) { return sector.slice(0, 3); }
function gradeOf(sector) { return sector.slice(3); } // 패밀리(3자) 제거 → 등급
function sectorColor(sector) {
  if (sector === '국고채권') return COLORS.accent;
  return FAMILY_COLORS[familyOf(sector)] || GRADE_COLORS[gradeOf(sector)] || COLORS.muted;
}
function isDash(sector) { return DASH_FAMILIES.includes(familyOf(sector)); }

// ── 트레이스 조립 ──

function buildTraces(data, { mode, ghost, preserved }) {
  const sectors = data.meta.sectors;
  const latest = data.dates.length - 1;
  const showG1 = ghost === '1m' || ghost === 'both';
  const showG3 = ghost === '3m' || ghost === 'both';
  const g1 = resolveGhostIndex(data.dates, GHOST_OFFSET['1m']);
  const g3 = resolveGhostIndex(data.dates, GHOST_OFFSET['3m']);
  const yfmt = mode === 'spread' ? '%{y:.0f} bp' : '%{y:.2f} %';
  const traces = [];

  for (const sector of sectors) {
    if (mode === 'spread' && sector === '국고채권') continue;
    const color = sectorColor(sector);
    const dash = isDash(sector) ? 'dash' : 'solid';
    const width = sector === '국고채권' ? 2.6 : 1.7;
    const isDefault = DEFAULT_VISIBLE.has(sector) || (mode === 'yield' && sector === '국고채권');
    const vis = preserved.has(sector) ? preserved.get(sector) : (isDefault ? true : 'legendonly');

    const cur = buildCurveAtIndex(data, sector, latest, mode);
    traces.push({
      type: 'scatter', mode: 'lines', name: sector, legendgroup: sector, visible: vis,
      x: cur.x, y: cur.y, line: { color, width, dash },
      hovertemplate: `<b>${sector}</b> ${yfmt}<extra></extra>`,
    });
    // 과거 비교(고스트): 같은 색·legendgroup, 점선+투명도, 범례 미표시.
    if (showG1 && g1 != null) traces.push(ghostTrace(data, sector, g1, mode, color, vis, yfmt, '1M', 'dot', 0.55, 1.2));
    if (showG3 && g3 != null) traces.push(ghostTrace(data, sector, g3, mode, color, vis, yfmt, '3M', 'dashdot', 0.35, 1.2));
  }
  return traces;
}

function ghostTrace(data, sector, idx, mode, color, vis, yfmt, tag, dash, opacity, width) {
  const g = buildCurveAtIndex(data, sector, idx, mode);
  return {
    type: 'scatter', mode: 'lines', name: `${sector} ${tag}`, legendgroup: sector,
    visible: vis, showlegend: false, opacity,
    x: g.x, y: g.y, line: { color, width, dash },
    hovertemplate: `${sector} ${tag} ${yfmt}<extra></extra>`,
  };
}

function layout(mode) {
  return {
    paper_bgcolor: 'transparent', plot_bgcolor: COLORS.bg,
    font: { color: COLORS.muted, family: FONT, size: 11 },
    // CV-2: uirevision — 고스트·범례 토글로 Plotly.react 가 다시 돌아도 줌·팬 상태를 유지한다.
    //   y축만 mode 를 revision 으로 써서 spread(bp)↔yield(%) 전환 시 단위가 다른 y줌은 리셋한다.
    dragmode: 'zoom', uirevision: 'cv',
    xaxis: {
      title: { text: '만기', font: { size: 10 } }, type: 'linear', uirevision: 'cv',
      tickvals: [0.25, 0.5, 1, 2, 3, 5, 10], ticktext: ['3M', '6M', '1Y', '2Y', '3Y', '5Y', '10Y'],
      gridcolor: COLORS.grid, linecolor: COLORS.axis, tickfont: { size: 10 }, zeroline: false,
    },
    yaxis: {
      title: { text: mode === 'spread' ? 'bp' : '%', font: { size: 10 } }, uirevision: mode,
      gridcolor: COLORS.grid, linecolor: COLORS.axis, tickfont: { size: 10 }, zeroline: false,
    },
    margin: { l: 52, r: 16, t: 14, b: 40 }, hovermode: 'x unified',
    legend: { orientation: 'h', font: { size: 10 }, groupclick: 'togglegroup', y: -0.18, yanchor: 'top' },
  };
}

// ── 상태 (localStorage: viewMode, ghost 만) ──
function loadState() {
  const st = { viewMode: 'spread', ghost: 'none' };
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (s && ['spread', 'yield'].includes(s.viewMode)) st.viewMode = s.viewMode;
    if (s && ['none', '1m', '3m', 'both'].includes(s.ghost)) st.ghost = s.ghost;
  } catch { /* noop */ }
  return st;
}
function saveState(st) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ viewMode: st.viewMode, ghost: st.ghost })); } catch { /* noop */ }
}

// 현재 렌더의 범례 on/off(세션 유지)를 섹터별로 보존. 고스트(showlegend:false)는 무시.
function readVisibility(el) {
  const m = new Map();
  const data = el && el.data;
  if (!Array.isArray(data)) return m;
  for (const t of data) {
    if (t.showlegend === false) continue;
    if (t.legendgroup && !m.has(t.legendgroup)) m.set(t.legendgroup, t.visible === undefined ? true : t.visible);
  }
  return m;
}

// ── init ──
export function initSectorCurves() {
  const data = typeof window !== 'undefined' && window.FENRIR_SERIES && window.FENRIR_SERIES['credit-spread'];
  const el = typeof document !== 'undefined' && document.getElementById('cv-chart');
  if (!data || !el || typeof window === 'undefined' || !window.Plotly) return;

  const state = loadState();

  function render() {
    const preserved = readVisibility(el);
    const traces = buildTraces(data, { mode: state.viewMode, ghost: state.ghost, preserved });
    window.Plotly.react(el, traces, layout(state.viewMode), CONFIG);
    syncButtons();
  }

  function syncButtons() {
    document.querySelectorAll('#cv-view button').forEach(b => b.classList.toggle('active', b.dataset.view === state.viewMode));
    document.querySelectorAll('#cv-ghost button').forEach(b => b.classList.toggle('active', b.dataset.ghost === state.ghost));
  }

  const viewBar = document.getElementById('cv-view');
  if (viewBar) viewBar.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.viewMode = b.dataset.view; saveState(state); render();
  });
  const ghostBar = document.getElementById('cv-ghost');
  if (ghostBar) ghostBar.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.ghost = b.dataset.ghost; saveState(state); render();
  });

  render();
}
