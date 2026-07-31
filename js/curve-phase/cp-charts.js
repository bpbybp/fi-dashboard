// cp-charts.js — Curve Phase Monitor 차트 렌더링(Plotly, vendor 전역). ES module.
//   사이트 공용 토큰·baseLayout 규약 준수. DESIGN.md: 모든 시계열 차트 끝점 값 라벨 필수(동적 바인딩).
//   Phase 2: 프라이싱 갭 스프레드(bp) 다선 차트. 룩백 슬라이스는 세션수 기준.

// 팔레트 이원화 — dark 는 기존 C 값 그대로(이동만), light 는 KB CI 기반(onoff-spread 와 동일 체계).
// C 는 뮤터블 라이브 객체: 임포트한 모듈이 참조를 유지한 채 applyPalette 로 값만 갈아끼운다.
// 주의 — 모듈 최상위에서 C.xxx 를 상수에 복사하면 테마 전환이 반영되지 않는다(팔레트 키로 저장할 것).
const PALETTES = {
  dark: {
    accent: '#58a6ff', up: '#3fb950', amber: '#f0883e', red: '#f85149', purple: '#a371f7',
    grid: '#21262d', axis: '#484f58', muted: '#8b949e', text: '#c9d1d9',
    gaugeLo: 'rgba(63,185,80,0.16)',    // 소진 쪽(누르는 힘 없음)
    gaugeMid: 'rgba(139,148,158,0.10)', // 중간
    gaugeHi: 'rgba(240,136,62,0.18)',   // 잔량 쪽(누르는 힘 강함)
    markerLine: '#0d1117',              // 게이지 바늘 외곽선 = 배경색
  },
  light: {
    accent: '#60584c', up: '#2f8f4e', amber: '#d98e04', red: '#c9453a', purple: '#7c5cbf',
    grid: '#ebe7de', axis: '#c6bfb1', muted: '#837b6d', text: '#3c382f',
    gaugeLo: 'rgba(47,143,78,0.14)',
    gaugeMid: 'rgba(131,123,109,0.10)',
    gaugeHi: 'rgba(217,142,4,0.16)',
    markerLine: '#faf9f6',
  },
};
export const C = { ...PALETTES.dark };
export function applyPalette(theme) { Object.assign(C, PALETTES[theme === 'light' ? 'light' : 'dark']); }
export { PALETTES };

// 세로(자료 캡처) 비율 여부 — 렌더 시점에 읽는다(모듈 로드 시 캡처 금지). 게이지는 이 분기를 쓰지 않는다.
export const isNarrow = () => document.documentElement.dataset.cpRatio === 'narrow';

const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

// 룩백 → 세션수(영업일). all 은 전체.
export const LOOKBACKS = ['1y', '3y', '10y', 'all'];
export const LOOKBACK_LABEL = { '1y': '1Y', '3y': '3Y', '10y': '10Y', all: '전체' };
const SESSIONS = { '1y': 252, '3y': 756, '10y': 2520 };
export const sliceLookback = (data, lookback) =>
  (lookback === 'all' ? data : data.slice(-(SESSIONS[lookback] || data.length)));

const baseLayout = (extra = {}) => {
  const narrow = isNarrow();
  const lay = {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: C.muted, family: FONT, size: 11 },
    // narrow: 좌우 축소. 단 r 은 끝점 값 라벨(DESIGN.md 필수) 공간이라 완전 제거하지 않고 48 유지.
    margin: narrow ? { l: 44, r: 48, t: 10, b: 32 } : { l: 48, r: 54, t: 10, b: 32 },
    legend: { orientation: 'h', x: 0, y: 1.1, font: { size: narrow ? 9 : 11 } },
    hovermode: 'x unified',
    xaxis: { type: 'date', gridcolor: C.grid, linecolor: C.axis, zeroline: false, tickfont: { size: 10 } },
    yaxis: { gridcolor: C.grid, linecolor: C.axis, zeroline: true, zerolinecolor: C.axis, tickfont: { size: 10 },
      title: { text: 'bp', font: { size: 11 } } },
    ...extra,
  };
  // narrow 눈금 솎기 — 병합된 xaxis(기본·extra 무관)에 nticks 적용해 좁은 폭 날짜 겹침 방지.
  if (narrow) lay.xaxis = { ...lay.xaxis, nticks: 4 };
  return lay;
};

// 끝점 값 라벨(DESIGN.md 필수). 여러 라벨이 겹치면 세로로 최소 간격 벌림.
function endpointAnnotations(traces, dp) {
  const pts = traces
    .filter((t) => t.x.length)
    .map((t) => ({ x: t.x[t.x.length - 1], y: t.y[t.y.length - 1], color: t.line.color }))
    .sort((a, b) => b.y - a.y);
  return pts.map((p) => ({
    x: p.x, y: p.y, xref: 'x', yref: 'y',
    text: `${p.y > 0 ? '+' : ''}${p.y.toFixed(dp)}`,
    showarrow: false, xanchor: 'left', xshift: 6,
    font: { family: FONT, size: 10.5, color: p.color },
  }));
}

// lines: [{ name, color, data:[[date,val]] }]. unit: 'bp'(정수1자리)|'%'(2자리). divId 에 렌더.
export function renderSpreadChart(divId, lines, lookback, unit = 'bp') {
  const dp = unit === 'bp' ? 1 : 2;
  const traces = lines.map((l) => {
    const d = sliceLookback(l.data, lookback);
    return {
      x: d.map((r) => r[0]), y: d.map((r) => r[1]), name: l.name, mode: 'lines',
      line: { color: l.color, width: 1.7 },
      hovertemplate: `%{x|%Y-%m-%d}<br>${l.name} %{y:.${dp}f}${unit}<extra></extra>`,
    };
  });
  Plotly.newPlot(divId,
    traces,
    baseLayout({ annotations: endpointAnnotations(traces, dp), yaxis: { gridcolor: C.grid, linecolor: C.axis, zeroline: true, zerolinecolor: C.axis, tickfont: { size: 10 }, title: { text: unit, font: { size: 11 } } } }),
    { displayModeBar: false, responsive: true });
}

// 기울기 변화 분해 누적 막대(bp). points: [{date, total, ...}], comps: [{key,name,color}](누적 대상).
//   막대는 상대 누적(barmode:relative, +위/−아래), 합계는 선으로 오버레이 + 끝점 라벨.
export function renderDecompChart(divId, points, comps) {
  const x = points.map((p) => p.date);
  const traces = comps.map((c) => ({
    x, y: points.map((p) => p[c.key]), name: c.name, type: 'bar',
    marker: { color: c.color },
    hovertemplate: `%{x|%Y-%m-%d}<br>${c.name} %{y:.1f}bp<extra></extra>`,
  }));
  const total = points.map((p) => p.total);
  traces.push({
    x, y: total, name: 'Δ 합계', type: 'scatter', mode: 'lines',
    line: { color: C.text, width: 1.3 },
    hovertemplate: `%{x|%Y-%m-%d}<br>Δ 합계 %{y:.1f}bp<extra></extra>`,
  });
  const anno = x.length ? [{
    x: x[x.length - 1], y: total[total.length - 1], xref: 'x', yref: 'y',
    text: `${total[total.length - 1] > 0 ? '+' : ''}${total[total.length - 1].toFixed(1)}`,
    showarrow: false, xanchor: 'left', xshift: 6, font: { family: FONT, size: 10.5, color: C.text },
  }] : [];
  Plotly.newPlot(divId, traces,
    baseLayout({ barmode: 'relative', annotations: anno }),
    { displayModeBar: false, responsive: true });
}

// Q1 게이지: 가로 바 위 바늘. 역사 범위 min~max, 현재 위치 마커, 30/70 pct 구분선, 좌우 끝 라벨.
//   g: { min, max, value, t30, t70, leftLabel, rightLabel, valueLabel }.
export function renderGauge(divId, g) {
  const { min, max, value, t30, t70, leftLabel, rightLabel, valueLabel } = g;
  const rect = (x0, x1, color) => ({ type: 'rect', xref: 'x', yref: 'y', x0, x1, y0: 0.3, y1: 0.7, fillcolor: color, line: { width: 0 }, layer: 'below' });
  const vline = (x) => ({ type: 'line', xref: 'x', yref: 'y', x0: x, x1: x, y0: 0.2, y1: 0.8, line: { color: C.muted, width: 1, dash: 'dot' } });
  const traces = [{
    x: [value], y: [0.5], mode: 'markers',
    marker: { color: C.accent, size: 14, symbol: 'triangle-down', line: { color: C.markerLine, width: 1 } },
    hovertemplate: `${valueLabel}<extra></extra>`,
  }];
  const layout = {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: C.muted, family: FONT, size: 9 },
    margin: { l: 10, r: 10, t: 20, b: 30 }, showlegend: false,
    xaxis: { range: [min, max], fixedrange: true, zeroline: false, showgrid: false, tickfont: { size: 9 } },
    yaxis: { range: [0, 1], visible: false, fixedrange: true },
    shapes: [
      rect(min, t30, C.gaugeLo),   // 소진 쪽(누르는 힘 없음)
      rect(t30, t70, C.gaugeMid),  // 중간
      rect(t70, max, C.gaugeHi),   // 잔량 쪽(누르는 힘 강함)
      vline(t30), vline(t70),
    ],
    annotations: [
      { x: value, y: 0.5, yshift: 17, text: valueLabel, showarrow: false, font: { family: FONT, size: 11, color: C.accent } },
      { xref: 'paper', x: 0, yref: 'paper', y: -0.04, yanchor: 'top', xanchor: 'left', text: leftLabel, showarrow: false, font: { size: 9, color: C.muted } },
      { xref: 'paper', x: 1, yref: 'paper', y: -0.04, yanchor: 'top', xanchor: 'right', text: rightLabel, showarrow: false, font: { size: 9, color: C.muted } },
    ],
  };
  Plotly.newPlot(divId, traces, layout, { displayModeBar: false, responsive: true, staticPlot: false });
}

// 사이클 오버레이: x=세션 오프셋(T=0 대비), y=기울기 bp. 현재=굵은 선, 과거=반투명, 참고=점선.
//   overlays: [{ label, color, current, ref, points:[{offset,bp}], markers?, market? }].
//   markers(cp-hikes.buildHikeMarkers): [{offset, y, size, isFinal, rateAfter, hikeBp, date}].
//     ▲=인상 · ◇=최종 인상. 크기 ∝ 인상폭. 마커 trace 는 라인 뒤에 append → z-order 상 라인 위.
//     라인 opacity 상속(참고·과거=0.5) → 시각 위계 유지. 0개 사이클은 trace 자체를 만들지 않는다.
export function renderOverlayChart(divId, overlays) {
  const visible = overlays.filter((o) => o.points.length);
  const traces = visible.map((o) => ({
    x: o.points.map((p) => p.offset), y: o.points.map((p) => p.bp), name: o.label, mode: 'lines',
    line: { color: o.color, width: o.current ? 2.6 : 1.4, dash: o.ref ? 'dot' : 'solid' },
    opacity: o.current ? 1 : 0.5,
    hovertemplate: `T%{x:+d}세션<br>${o.label} %{y:.1f}bp<extra></extra>`,
  }));
  // 마커 trace: 라인 뒤에 append(위에 그려짐). hovermode:'x unified' 에서 해당 T+N 컬럼에 한 행으로 낀다.
  //   customdata=[date, 인상폭bp, 인상후%]. US 는 '상단' 표기. <extra></extra> 로 우측 트레이스 박스 제거.
  const markerTraces = [];
  for (const o of visible) {
    if (!o.markers || !o.markers.length) continue; // 0개 사이클(예: KR 2026) → skip
    const suffix = o.market === 'US' ? '상단 ' : '';
    markerTraces.push({
      x: o.markers.map((m) => m.offset), y: o.markers.map((m) => m.y),
      mode: 'markers', name: o.label, showlegend: false,
      marker: {
        color: o.color,
        size: o.markers.map((m) => m.size),
        symbol: o.markers.map((m) => (m.isFinal ? 'diamond' : 'triangle-up')),
        line: { color: C.markerLine, width: 0.8 },
      },
      opacity: o.current ? 1 : 0.5, // 라인과 동일 opacity 상속
      customdata: o.markers.map((m) => [m.date, m.hikeBp, m.rateAfter]),
      hovertemplate: `%{customdata[0]} · +%{customdata[1]}bp · 인상 후 ${suffix}%{customdata[2]:.2f}%<extra></extra>`,
    });
  }
  const layout = baseLayout({
    shapes: [{ type: 'line', xref: 'x', yref: 'paper', x0: 0, x1: 0, y0: 0, y1: 1,
      line: { color: C.axis, width: 1, dash: 'dash' } }],
    xaxis: { type: 'linear', gridcolor: C.grid, linecolor: C.axis, zeroline: false, tickfont: { size: 10 },
      title: { text: 'T=0(첫 인상일) 대비 세션(영업일)', font: { size: 11 } } },
  });
  Plotly.newPlot(divId, [...traces, ...markerTraces], layout, { displayModeBar: false, responsive: true });
}

// ── 발표용 PNG 내보내기 프리셋 (DESIGN.md "발표용 내보내기 프리셋" 참조) ──
//   슬라이드 2.7인치 칸 기준 400dpi 를 넘기려 캡처 대신 내보내기 해상도를 직접 지정.
//   1200×1450(세로 380:460 비율) × Plotly scale 2 = 2400×2900. 화면 테마·비율과 무관하게 항상 light 고정.
const EXPORT = {
  W: 1200, H: 1450, SCALE: 2,
  M: 1200 / 380,              // ≈ 3.16 배율 상수
  bg: '#ffffff',             // 불투명 흰 배경(슬라이드 삽입용, 투명 금지)
  grid: '#f0ede6',           // light 팔레트(#ebe7de)보다 한 단계 옅게
  zero: '#e2ddd2',           // zeroline 동일 계열
  axis: '#c6bfb1', ink: '#837b6d',
  margin: { l: 155, r: 230, t: 130, b: 150 }, // 확대 글자·끝점 라벨 수용(고정 → 조합 무관 동일)
};
// 다크 트레이스/주석/도형 색 → light 강제. 화면이 이미 light 면 키에 없으므로 그대로 통과(항등).
// 주의: #8b949e 는 '사이클[4] 트레이스'로만 데이터에 등장 → #a39b8c. muted 폰트색 등 layout 크롬은 아래에서 명시 오버라이드.
const DARK_TO_LIGHT = {
  '#58a6ff': '#60584c', '#3fb950': '#2f8f4e', '#f0883e': '#d98e04',
  '#f85149': '#c9453a', '#a371f7': '#7c5cbf', '#c9d1d9': '#3c382f',
  '#8b949e': '#a39b8c', '#484f58': '#c6bfb1',
};
const toLight = (c) => (c && DARK_TO_LIGHT[c]) || c;
const mapColor = (c) => (Array.isArray(c) ? c.map(toLight) : toLight(c));

// 화면 gd 를 건드리지 않고(딥카피만), 프리셋 배율·light 팔레트를 적용한 {data, layout} 을 만든다.
export function buildExportSpec(elId) {
  const gd = document.getElementById(elId);
  if (!gd || !gd.data || !gd.layout) return null;
  const fS = EXPORT.M * 1.5, lS = EXPORT.M * 2, mS = EXPORT.M * 1.5; // 폰트×M×1.5 · 선×M×2 · 마커×M×1.5
  const px = (v, base) => Math.round((v == null ? base : v) * fS);
  const data = JSON.parse(JSON.stringify(gd.data));
  const layout = JSON.parse(JSON.stringify(gd.layout));

  for (const t of data) {
    if (t.line) {
      if (t.line.color) t.line.color = mapColor(t.line.color);
      if (t.line.width != null) t.line.width *= lS;
    }
    if (t.marker) {
      if (t.marker.color) t.marker.color = mapColor(t.marker.color);
      if (t.marker.size != null) t.marker.size = Array.isArray(t.marker.size) ? t.marker.size.map((s) => s * mS) : t.marker.size * mS;
      if (t.marker.line) {
        if (t.marker.line.color) t.marker.line.color = mapColor(t.marker.line.color);
        if (t.marker.line.width != null) t.marker.line.width *= lS;
      }
    }
  }

  // 크기·배경·마진·폰트는 화면 비율과 무관하게 고정값으로 강제(→ 조합 무관 동일 출력).
  layout.width = EXPORT.W; layout.height = EXPORT.H; layout.autosize = false;
  layout.paper_bgcolor = EXPORT.bg; layout.plot_bgcolor = EXPORT.bg;
  layout.margin = { ...EXPORT.margin };
  layout.font = { ...(layout.font || {}), color: EXPORT.ink, size: px(11) };
  layout.legend = { ...(layout.legend || {}), font: { ...((layout.legend || {}).font || {}), size: px(9) } }; // 세로 base 9
  for (const ax of ['xaxis', 'yaxis']) {
    const a = layout[ax] = { ...(layout[ax] || {}) };
    a.gridcolor = EXPORT.grid; a.linecolor = EXPORT.axis; a.zerolinecolor = EXPORT.zero;
    a.nticks = 4;
    // Plotly 가 화면 크기에 맞춰 gd.layout 에 써넣은 계산 range 를 제거 → 내보내기 크기에서 재-autorange.
    // (화면 비율 300px/460px 마다 range 가 미세하게 달라 4조합 동일성이 깨지는 것을 방지)
    delete a.range; a.autorange = true;
    a.tickfont = { ...(a.tickfont || {}), size: px((a.tickfont || {}).size, 10), color: EXPORT.ink };
    if (a.title) a.title = { ...a.title, font: { ...((a.title || {}).font || {}), size: px(((a.title || {}).font || {}).size, 11) } };
  }
  for (const an of (layout.annotations || [])) {
    if (an.font) an.font = { ...an.font, size: px(an.font.size, 10), color: mapColor(an.font.color) };
  }
  for (const sh of (layout.shapes || [])) {
    if (sh.line) { if (sh.line.color) sh.line.color = mapColor(sh.line.color); if (sh.line.width != null) sh.line.width *= lS; }
    if (sh.fillcolor) sh.fillcolor = mapColor(sh.fillcolor);
  }
  return { data, layout };
}

// 화면 밖 숨김 컨테이너에 렌더 → PNG 다운로드 → 정리. 화면 차트는 relayout 하지 않는다.
export function exportChart(elId, filename) {
  const spec = buildExportSpec(elId);
  if (!spec) return Promise.resolve();
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:1200px;height:1450px;pointer-events:none;';
  document.body.appendChild(holder);
  return Plotly.newPlot(holder, spec.data, spec.layout, { staticPlot: true, displayModeBar: false, responsive: false })
    .then(() => Plotly.downloadImage(holder, { format: 'png', width: EXPORT.W, height: EXPORT.H, scale: EXPORT.SCALE, filename }))
    .finally(() => { try { Plotly.purge(holder); } catch { /* noop */ } holder.remove(); });
}
