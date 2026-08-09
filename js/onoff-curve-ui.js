// onoff-curve-ui.js — On/Off 커브 단면 화면(onoff-curve.html) 배선. 계산은 전부 js/onoff-curve.js.
// 이 파일은 DOM 갱신·날짜 조작만 한다. 수치를 여기서 만들지 않는다(계산 이중화 방지).
//
// [표시 원칙 — bpbybp scope]
//   판정 문구·배지·매매신호·밴드·퍼센타일 없음. 색은 계열(2Y/3Y)·역할(지표물/창 밖) 구분 용도로만
//   쓰고, 잔차 부호로 색을 바꾸지 않는다(리치/치프 판정은 화면이 할 일이 아니다).
//   잔차가 없으면 0으로 채우지 않고 '왜 없는지'를 적는다 — 빈칸과 0은 전혀 다른 정보다.

import { snapshot, allDates } from './onoff-curve.js';

const LS_THEME = 'oo-theme';
const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmt = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '—');

let DS = null;      // window.ONOFF_BONDS
let DATES = [];     // 전 종목 일자 합집합(오름차순)
let cur = null;     // 현재 표시 일자

// 요청 일자 → 데이터에 있는 가장 가까운 '이전' 영업일. 없으면 최초 일자.
function snapDate(want) {
  if (DATES.includes(want)) return { date: want, snapped: false };
  const prior = DATES.filter(d => d < want);
  if (prior.length) return { date: prior[prior.length - 1], snapped: true };
  return { date: DATES[0], snapped: true };
}

const ROLE_KO = { fit: '경과물', onTheRun: '지표물', excluded: '창 밖' };

// 잔차 셀 — 역할별로 무엇을 보여줄지와, 없을 때 사유를 정한다.
function residualCell(td, snap, bond) {
  const pick = m => {
    const r = snap.residuals.find(z => z.tag === bond.tag && z.method === m);
    return r ? r.value : undefined;
  };
  if (!bond.inWindow) { td.appendChild(el('span', 'na', '창 밖')); return; }
  if (snap.detail.insufficientFit) { td.appendChild(el('span', 'na', '경과물 부족')); return; }

  if (bond.role === 'onTheRun' && bond.tenor === '3Y') {
    const P = pick('premium'), R = pick('pairAdjusted');
    const W = (() => { const z = snap.residuals.find(x => x.method === 'placebo'); return z ? z.value : undefined; })();
    if (P == null) { td.appendChild(el('span', 'na', '-')); return; }
    td.appendChild(el('span', null, fmt(P, 2)));
    const d = snap.detail;
    const sub = el('span', 'sub',
      `R ${fmt(R, 2)} − W ${fmt(W, 2)}`);
    td.appendChild(sub);
    td.title =
      `프리미엄 P = R − W = ${fmt(P, 2)}bp\n` +
      `R(지표물 잔차) = (${d.on3.tag} − ${d.on3.ref}) − 기울기 ${fmt(d.on3.slope, 2)}bp/년 × ${d.on3.gapMonths}/12년 = ${fmt(R, 2)}bp\n` +
      `W(위약 잔차)  = (${d.placebo ? d.placebo.tag : '—'} − ${d.placebo ? d.placebo.ref : '—'}) − 기울기 ${d.placebo ? fmt(d.placebo.slope, 2) : '—'}bp/년 × ${d.placebo ? d.placebo.gapMonths : '—'}/12년 = ${fmt(W, 2)}bp\n` +
      `※ 3Y 지표물은 경과물 범위 밖이라 외삽이 불가피하다. 같은 계산을 경과물 최장 종목(위약)에 적용해 빼면 외삽 편향이 상쇄된다.`;
    return;
  }

  const v = pick('localInterp');
  if (v === undefined) { td.appendChild(el('span', 'na', '-')); return; }
  if (v === null) {
    td.appendChild(el('span', 'na', '경계'));
    td.title = '좌우 인접 경과물 중 한쪽이 없어 보간할 수 없다(커브 양 끝점).';
    return;
  }
  td.appendChild(el('span', null, fmt(v, 2)));
  if (bond.role === 'onTheRun' && snap.detail.on2 && snap.detail.on2.tag === bond.tag) {
    td.appendChild(el('span', 'sub', `보간 ${snap.detail.on2.left}·${snap.detail.on2.right}`));
    td.title = `좌우 경과물 ${snap.detail.on2.left}·${snap.detail.on2.right} 선형보간 대비 편차(내삽).`;
  } else {
    td.title = '좌우 인접 경과물 선형보간 대비 편차(leave-one-out).';
  }
}

// ── 커브 단면 차트 (Plotly) ──
// [수직 점선에 대한 주의] 명세는 "지표물에서 적합선까지 수직 점선"이었으나, 표에 적힌 잔차는
// 어느 쪽도 '경과물 1차 적합선 대비 편차'가 아니다(2Y = 좌우 이웃 선형보간 대비, 3Y = R−W).
// 적합선까지 그으면 표와 다른 숫자를 눈으로 보여주게 되므로, 수직선은 각 지표물이 '실제로 재는
// 준거'까지 긋는다 — 2Y는 이웃 현(chord) 위의 보간점, 3Y는 준거물에서 기울기로 뻗은 외삽점.
// 그래서 수직선 길이가 표의 값과 정확히 일치한다. 1차 적합선은 배경 참조선으로 따로 그린다.
const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function renderChart(snap) {
  const box = $('oc-chart');
  if (!box || typeof window.Plotly === 'undefined') return;
  const C = {
    text: cssVar('--text'), muted: cssVar('--muted'), border: cssVar('--border-2'),
    t2y: cssVar('--t2y'), t3y: cssVar('--t3y'), accent: cssVar('--accent-ink'), warn: cssVar('--warn'),
  };
  const byTag = t => snap.bonds.find(b => b.tag === t);
  const resid = (tag, method) => {
    const r = snap.residuals.find(z => z.tag === tag && z.method === method);
    return r ? r.value : undefined;
  };
  const residText = b => {
    if (!b.inWindow) return '창 밖';
    if (snap.detail.insufficientFit) return '경과물 부족';
    if (b.role === 'onTheRun' && b.tenor === '3Y') {
      const P = resid(b.tag, 'premium');
      return P == null ? '-' : `${fmt(P, 2)} (P)`;
    }
    const v = resid(b.tag, 'localInterp');
    return v === undefined ? '-' : (v === null ? '경계' : fmt(v, 2));
  };
  const pack = arr => ({
    x: arr.map(b => b.residualMonths),
    y: arr.map(b => b.relativeYield),
    text: arr.map(b => b.tag),
    customdata: arr.map(b => [b.maturity, b.coupon.toFixed(3), residText(b), b.tenor]),
  });
  const HOVER =
    '<b>%{text}</b> (%{customdata[3]})<br>' +
    '만기 %{customdata[0]} · 쿠폰 %{customdata[1]}%<br>' +
    '잔존 %{x}개월 · 상대금리 %{y:.1f}bp<br>' +
    '잔차 %{customdata[2]}<extra></extra>';

  const fitB = snap.bonds.filter(b => b.role === 'fit');
  const on2 = snap.bonds.find(b => b.role === 'onTheRun' && b.tenor === '2Y');
  const on3 = snap.bonds.find(b => b.role === 'onTheRun' && b.tenor === '3Y');
  const outB = snap.bonds.filter(b => b.role === 'excluded');

  const traces = [];
  // 경과물 1차 적합선 — 적합에 쓰인 구간에만
  if (fitB.length >= 2 && snap.fit.slope != null) {
    const x0 = fitB[0].residualMonths, x1 = fitB[fitB.length - 1].residualMonths;
    const yAt = m => snap.fit.intercept + snap.fit.slope * (m / 12);
    traces.push({
      x: [x0, x1], y: [yAt(x0), yAt(x1)], name: '경과물 1차 적합', type: 'scatter', mode: 'lines',
      line: { color: C.muted, width: 1, dash: 'solid' },
      hovertemplate: `1차 적합 ${fmt(snap.fit.slope, 2)}bp/년 (n=${snap.fit.n})<extra></extra>`,
    });
  }
  if (fitB.length) traces.push({
    ...pack(fitB), name: '경과물', type: 'scatter', mode: 'lines+markers',
    line: { color: C.text, width: 1.6 },
    marker: { size: 9, color: C.text, symbol: 'circle' },
    hovertemplate: HOVER,
  });

  const shapes = [], annos = [];
  const vline = (x, y0, y1, color) => shapes.push({
    type: 'line', xref: 'x', yref: 'y', x0: x, x1: x, y0, y1,
    line: { color, width: 2.2, dash: 'dot' },
  });

  // 2Y 지표물 — 좌우 이웃 현(chord) 위 보간점까지의 수직선 = 표의 잔차
  if (on2 && snap.detail.on2 && snap.detail.on2.left && snap.detail.on2.right) {
    const L = byTag(snap.detail.on2.left), R = byTag(snap.detail.on2.right);
    traces.push({
      x: [L.residualMonths, R.residualMonths], y: [L.relativeYield, R.relativeYield],
      name: '2Y 준거(이웃 보간)', type: 'scatter', mode: 'lines',
      line: { color: C.t2y, width: 1, dash: 'dash' }, opacity: 0.7,
      hovertemplate: `2Y 지표물 준거 — ${L.tag}·${R.tag} 선형보간<extra></extra>`,
    });
    const v = resid(on2.tag, 'localInterp');
    if (v != null) {
      const base = on2.relativeYield - v;
      vline(on2.residualMonths, base, on2.relativeYield, C.t2y);
      annos.push({
        x: on2.residualMonths, y: (base + on2.relativeYield) / 2, xanchor: 'right', xshift: -9,
        text: `${fmt(v, 2)}`, showarrow: false, font: { size: 11, color: C.t2y, family: 'monospace' },
      });
    }
    traces.push({
      ...pack([on2]), name: '2Y 지표물', type: 'scatter', mode: 'markers',
      marker: { size: 14, color: C.t2y, symbol: 'diamond', line: { width: 1, color: C.text } },
      hovertemplate: HOVER,
    });
  } else if (on2) {
    traces.push({
      ...pack([on2]), name: '2Y 지표물', type: 'scatter', mode: 'markers',
      marker: { size: 14, color: C.t2y, symbol: 'diamond', line: { width: 1, color: C.text } },
      hovertemplate: HOVER,
    });
  }

  // 3Y 지표물 — 준거물에서 기울기로 뻗은 외삽점까지 = R. 위약도 같은 방식으로 그려 P = R − W 를 눈에 보이게.
  const ray = (refTag, tgt, slope, color, label, val, place) => {
    const ref = byTag(refTag);
    if (!ref || !tgt || slope == null) return;
    const pred = ref.relativeYield + slope * (tgt.residualMonths - ref.residualMonths) / 12;
    traces.push({
      x: [ref.residualMonths, tgt.residualMonths], y: [ref.relativeYield, pred],
      name: label, type: 'scatter', mode: 'lines',
      line: { color, width: 1, dash: 'dash' }, opacity: 0.75,
      hovertemplate: `${label} — ${ref.tag} 기준 기울기 ${fmt(slope, 2)}bp/년 외삽<extra></extra>`,
    });
    vline(tgt.residualMonths, pred, tgt.relativeYield, color);
    annos.push({
      x: tgt.residualMonths, y: (pred + tgt.relativeYield) / 2,
      ...place, text: `${val}`, showarrow: false, font: { size: 11, color, family: 'monospace' },
    });
  };
  if (on3 && snap.detail.on3) {
    const d = snap.detail;
    // 라벨 충돌 방지 — W 는 왼쪽 아래, R 은 오른쪽 위로 갈라놓는다.
    if (d.placebo) ray(d.placebo.ref, byTag(d.placebo.tag), d.placebo.slope, C.warn,
                       'W 위약 준거', `W ${fmt(resid(d.placebo.tag, 'placebo'), 2)}`,
                       { xanchor: 'right', xshift: -10, yshift: 13 });
    ray(d.on3.ref, on3, d.on3.slope, C.t3y, 'R 지표물 준거',
        `R ${fmt(resid(on3.tag, 'pairAdjusted'), 2)}`,
        { xanchor: 'right', xshift: -10, yshift: 14 });
  }
  if (on3) traces.push({
    ...pack([on3]), name: '3Y 지표물', type: 'scatter', mode: 'markers',
    marker: { size: 15, color: C.t3y, symbol: 'star', line: { width: 1, color: C.text } },
    hovertemplate: HOVER,
  });

  // ── 잔차 서브패널 (y3) — 위 커브 패널과 x 축을 공유해 "커브에서 어디 있는 종목이 얼마 튀는가"가
  // 세로로 대응된다. 값이 없는 것(경계·창 밖·경과물 부족)은 아예 그리지 않는다 — 0으로 오해될 여지 제거.
  const rBars = [];
  if (!snap.detail.insufficientFit) {
    for (const b of snap.bonds) {
      if (!b.inWindow) continue;
      let v, extra = '';
      if (b.role === 'onTheRun' && b.tenor === '3Y') {
        v = resid(b.tag, 'premium');
        const R = resid(b.tag, 'pairAdjusted');
        const W = (() => { const z = snap.residuals.find(x => x.method === 'placebo'); return z ? z.value : undefined; })();
        extra = `P = R ${fmt(R, 2)} − W ${fmt(W, 2)}`;
      } else {
        v = resid(b.tag, 'localInterp');
        if (v === null) continue;                       // 경계 — 보간 불가
        extra = b.role === 'onTheRun' ? '이웃 선형보간(내삽)' : '이웃 선형보간(LOO)';
      }
      if (v == null) continue;
      rBars.push({ b, v, extra });
    }
  }
  const resTrace = rBars.length ? [{
    x: rBars.map(r => r.b.residualMonths), y: rBars.map(r => r.v),
    text: rBars.map(r => r.b.tag),
    customdata: rBars.map(r => [r.b.tenor, ROLE_KO[r.b.role], r.extra]),
    name: '잔차', type: 'bar', xaxis: 'x', yaxis: 'y3', width: 1.6,
    marker: {
      color: rBars.map(r => r.b.tenor === '2Y' ? C.t2y : C.t3y),
      opacity: rBars.map(r => r.b.role === 'onTheRun' ? 0.95 : 0.45),
      line: { width: rBars.map(r => r.b.role === 'onTheRun' ? 1.5 : 0), color: C.text },
    },
    showlegend: false,
    hovertemplate: '<b>%{text}</b> (%{customdata[0]} · %{customdata[1]})<br>' +
                   '잔존 %{x}개월 · 잔차 %{y:.2f}bp<br>%{customdata[2]}<extra></extra>',
  }] : [];

  // 잔차는 1~10bp 인데 창 밖 종목까지 넣으면 y 폭이 80~100bp 로 벌어져 수직선이 2~4px 로 뭉갠다.
  // 그래서 위 칸(y)은 잔존창 안만 확대해 잔차를 읽을 수 있게 하고, 아래 띠(y2)에 창 밖 포함
  // 전 구간을 참고용으로 깐다. 두 칸 모두 실제 좌표이며 축을 자르거나 왜곡하지 않는다.
  const ctx = snap.bonds.length ? [{
    x: snap.bonds.map(b => b.residualMonths), y: snap.bonds.map(b => b.relativeYield),
    text: snap.bonds.map(b => b.tag),
    customdata: snap.bonds.map(b => [b.maturity, b.coupon.toFixed(3), residText(b), b.tenor]),
    name: '전 구간(참고)', type: 'scatter', mode: 'markers', xaxis: 'x', yaxis: 'y2',
    marker: {
      size: 7, symbol: snap.bonds.map(b => b.inWindow ? 'circle' : 'circle-open'),
      color: snap.bonds.map(b => b.inWindow ? (b.tenor === '2Y' ? C.t2y : C.t3y) : C.muted),
      opacity: 0.55, line: { width: 1.2 },
    },
    showlegend: false, hovertemplate: HOVER,
  }] : [];
  for (const grp of [outB.filter(b => b.residualMonths < 12), outB.filter(b => b.residualMonths > 36)]) {
    if (!grp.length) continue;
    const mid = grp[Math.floor(grp.length / 2)];
    annos.push({
      x: mid.residualMonths, y: mid.relativeYield, yref: 'y2', yshift: -18,
      text: '창 밖', showarrow: false, font: { size: 10, color: C.muted },
    });
  }

  // 위 칸 y 범위 — 창 안 종목 + 준거 외삽점까지 담고 여유 8%
  const inW = snap.bonds.filter(b => b.inWindow).map(b => b.relativeYield);
  const refY = shapes.flatMap(s => [s.y0, s.y1]);
  const ys = inW.concat(refY);
  const pad = ys.length ? Math.max(1, (Math.max(...ys) - Math.min(...ys)) * 0.08) : 1;

  window.Plotly.react(box, traces.concat(resTrace, ctx), {
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: C.muted, size: 11 },
    margin: { l: 60, r: 18, t: 12, b: 40 },
    barmode: 'overlay', bargap: 0.55,
    xaxis: { title: { text: '잔존만기 (개월)', font: { size: 11 } }, gridcolor: C.border, zeroline: false, dtick: 3, anchor: 'y2' },
    yaxis: {
      title: { text: '상대금리 (bp) — 잔존창 확대', font: { size: 11 } },
      gridcolor: C.border, zeroline: false, domain: [0.54, 1],
      range: ys.length ? [Math.min(...ys) - pad, Math.max(...ys) + pad] : undefined,
    },
    yaxis3: {
      title: { text: '잔차 (bp)', font: { size: 11 } }, gridcolor: C.border,
      zeroline: true, zerolinecolor: C.muted, zerolinewidth: 1, domain: [0.22, 0.46],
    },
    yaxis2: { title: { text: '전 구간', font: { size: 10 } }, gridcolor: C.border, zeroline: false, domain: [0, 0.12] },
    shapes, annotations: annos,
    hovermode: 'closest',
    legend: { orientation: 'h', y: -0.20, font: { size: 10 } },
    showlegend: true,
  }, { displayModeBar: false, responsive: true });
}

function renderChartNote(snap) {
  const n = $('oc-chart-note');
  n.replaceChildren();
  const d = snap.detail;
  const bits = [];
  bits.push(el('b', null, '수직 점선 '));
  bits.push('= 각 지표물이 실제로 재는 준거까지의 거리(표의 잔차와 같은 값). ');
  if (d.on2) bits.push(`2Y는 이웃 ${d.on2.left}·${d.on2.right} 선형보간(파선)까지. `);
  if (d.on3) bits.push(`3Y는 준거 ${d.on3.ref}에서 기울기 ${fmt(d.on3.slope, 2)}bp/년으로 뻗은 외삽선까지 = R, `);
  if (d.placebo) bits.push(`위약 ${d.placebo.tag}도 같은 방식으로 W. P = R − W. `);
  bits.push(document.createElement('br'));
  bits.push(el('b', null, '경과물 1차 적합선(회색 실선) '));
  bits.push('은 커브 형태 참조용이며 잔차의 준거가 아니다 — 잔차를 이 선까지의 거리로 읽지 말 것.');
  n.append(...bits);
}

// ── 구간 기울기 ──
// 인접 종목쌍의 기울기를 쌍의 잔존 중점으로 구간에 배정해 평균한 값. 그 구간에 인접쌍이 아예
// 없으면 '-' — 0 이 아니라 '재지 못했다'는 뜻이다.
const SEG_COLS = [['12–18M', 'm12_18'], ['18–24M', 'm18_24'], ['24–30M', 'm24_30'], ['30–36M', 'm30_36']];
function renderSlopes(snap) {
  const card = $('oc-slopes');
  card.replaceChildren();
  const t = el('table', 'slopes');
  const thead = el('thead'), hr = el('tr');
  hr.appendChild(el('th', null, '구간'));
  for (const [label] of SEG_COLS) hr.appendChild(el('th', null, label));
  thead.appendChild(hr); t.appendChild(thead);
  const tb = el('tbody'), r = el('tr');
  r.appendChild(el('td', null, 'bp/년'));
  for (const [, key] of SEG_COLS) {
    const v = snap.segments[key];
    const td = el('td', v == null ? 'na' : null, v == null ? '-' : fmt(v, 2));
    if (v == null) td.title = '해당 잔존 구간에 인접 종목쌍이 없어 기울기를 산출할 수 없음';
    r.appendChild(td);
  }
  tb.appendChild(r); t.appendChild(tb);
  card.appendChild(t);
}

function renderTable(snap) {
  const card = $('oc-table-card');
  card.replaceChildren();
  if (!snap.bonds.length) {
    card.appendChild(el('div', 'empty', `${snap.date} 관측 종목 없음`));
    return;
  }
  const table = el('table', 'grid');
  const thead = el('thead');
  const hr = el('tr');
  const COLS = [
    ['종목', null],
    ['계열', null],
    ['만기', null],
    ['쿠폰', null],
    ['잔존', '만기월 − 관측월 (개월). 원본에 만기 일(日)이 없어 월 단위가 상한.'],
    ['상대금리', '앵커 전환 누적 오프셋 포함 — 같은 날 종목 간 비교용. 서로 다른 날짜의 레벨을 직접 비교하지 말 것.'],
    ['역할', '지표물 = tenor 계열별 first 최신. 잔존 12~36개월 밖이면 창 밖.'],
    ['잔차', '경과물·2Y 지표물 = 좌우 인접 경과물 선형보간 대비 편차. 3Y 지표물 = P(=R−W).'],
  ];
  for (const [label, tip] of COLS) {
    const th = el('th', null, label);
    if (tip) th.title = tip;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tb = el('tbody');
  for (const b of snap.bonds) {
    const tr = el('tr', b.role === 'onTheRun' ? 'r-onrun' : (b.role === 'excluded' ? 'r-out' : null));
    tr.appendChild(el('td', null, b.tag));
    const tdT = el('td');
    tdT.appendChild(el('span', `pill ${b.tenor === '2Y' ? 't2y' : 't3y'}`, b.tenor));
    tr.appendChild(tdT);
    tr.appendChild(el('td', 'num', b.maturity));
    tr.appendChild(el('td', 'num', b.coupon.toFixed(3)));
    tr.appendChild(el('td', 'num', `${b.residualMonths}M`));
    tr.appendChild(el('td', 'num', fmt(b.relativeYield, 1)));
    const tdR = el('td', null, ROLE_KO[b.role]);
    if (b.isOnTheRun && b.role === 'excluded') {
      tdR.textContent = '창 밖';
      tdR.appendChild(el('span', 'sub', '지표물'));
    }
    tr.appendChild(tdR);
    const tdV = el('td', 'num');
    residualCell(tdV, snap, b);
    tr.appendChild(tdV);
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  card.appendChild(table);
}

function renderWarn(snap) {
  const box = $('oc-warn');
  const on3 = snap.bonds.find(b => b.isOnTheRun && b.tenor === '3Y');
  if (on3 && !on3.inWindow) {
    box.replaceChildren();
    box.append(
      `3Y 지표물 `, el('span', 'k', on3.tag),
      `: 잔존 ${on3.residualMonths}개월 — 경과물 커브 범위 밖, 측정 불가`,
    );
    box.classList.remove('hidden');
  } else if (snap.detail.insufficientFit) {
    box.replaceChildren(document.createTextNode(
      `경과물 ${snap.detail.fitCount}개 — 3종목 미만이라 잔차를 산출할 수 없음`));
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
}

function renderMeta(snap) {
  const bar = $('oc-meta');
  bar.replaceChildren();
  const nFit = snap.bonds.filter(b => b.role === 'fit').length;
  const nOn = snap.bonds.filter(b => b.role === 'onTheRun').length;
  const nOut = snap.bonds.filter(b => b.role === 'excluded').length;
  bar.appendChild(el('span', 'sname', `${snap.date} 단면`));
  bar.appendChild(el('span', 'meta',
    `관측 ${snap.bonds.length}종목 · 경과물 ${nFit} / 지표물 ${nOn} / 창 밖 ${nOut}`));
  bar.appendChild(el('span', 'meta',
    `경과물 1차 적합 ${snap.fit.slope == null ? '—' : `${fmt(snap.fit.slope, 2)}bp/년 (n=${snap.fit.n})`}`));
  bar.appendChild(el('span', 'meta', `데이터 최신 ${DS.updated} · 전체 ${DS.bonds.length}종목 · ${DATES.length}영업일`));
}

function renderLegend() {
  const n = $('oc-legend');
  n.replaceChildren();
  n.append(
    el('b', null, '읽는 법 '),
    '· 잔차는 그날 경과물 커브 대비 편차(bp)다. ',
    el('b', null, '경계'), ' = 커브 양 끝점이라 좌우 보간 불가. ',
    el('b', null, '창 밖'), ' = 잔존 12~36개월 범위 밖이라 미측정. ',
    el('b', null, '경과물 부족'), ' = 경과물 3종목 미만. 빈 값을 0으로 채우지 않는다.',
    document.createElement('br'),
    el('b', null, '상대금리 열 '),
    '· 앵커 전환 누적 오프셋이 실려 있다. 같은 날 종목 간 차이만 의미가 있고, ',
    '서로 다른 날짜의 레벨을 직접 비교하면 안 된다(잔차 열은 같은 날 차이만 쓰므로 영향받지 않는다).',
  );
}

function render() {
  const snap = snapshot(DS, cur);
  $('oc-date').value = cur;
  $('oc-prev').disabled = DATES.indexOf(cur) <= 0;
  $('oc-next').disabled = DATES.indexOf(cur) >= DATES.length - 1;
  renderMeta(snap);
  renderWarn(snap);
  renderChart(snap);
  renderChartNote(snap);
  renderSlopes(snap);
  renderTable(snap);
}

// ── 잔차 시계열 ──
// snapshot() 은 일자당 ~0.3ms 라 2,719일 전체를 매번 훑으면 종목을 바꿀 때마다 0.8초씩 멎는다.
// 첫 렌더 뒤 한 번만 전 일자를 훑어 종목별 행을 색인해 두고, 이후에는 색인만 읽는다.
// 색인은 snapshot 의 산출물을 그대로 담을 뿐 수치를 다시 만들지 않는다.
let TS_INDEX = null;   // Map<tag, [{ date, m, residual, method, role, R, W }]>
let tsTag = null, tsRange = '250';

function buildIndex() {
  const idx = new Map();
  for (const b of DS.bonds) idx.set(b.tag, []);
  for (const d of DATES) {
    const snap = snapshot(DS, d);
    const W = (() => { const z = snap.residuals.find(x => x.method === 'placebo'); return z ? z.value : null; })();
    for (const b of snap.bonds) {
      const pick = m => {
        const r = snap.residuals.find(z => z.tag === b.tag && z.method === m);
        return r ? r.value : null;
      };
      const is3YOn = b.role === 'onTheRun' && b.tenor === '3Y';
      idx.get(b.tag).push({
        date: d, m: b.residualMonths, role: b.role,
        residual: is3YOn ? pick('premium') : pick('localInterp'),
        method: is3YOn ? 'premium' : 'localInterp',
        R: is3YOn ? pick('pairAdjusted') : null,
        W: is3YOn ? W : null,
      });
    }
  }
  TS_INDEX = idx;
}

function renderTs() {
  const box = $('oc-ts-chart');
  if (!box || !TS_INDEX || typeof window.Plotly === 'undefined') return;
  const C = { text: cssVar('--text'), muted: cssVar('--muted'), border: cssVar('--border-2'),
              t2y: cssVar('--t2y'), t3y: cssVar('--t3y') };
  const meta = DS.bonds.find(b => b.tag === tsTag);
  let rows = TS_INDEX.get(tsTag) || [];
  if (tsRange === '250') {
    const cut = DATES.slice(-250)[0];
    rows = rows.filter(r => r.date >= cut);
  }
  const color = meta && meta.tenor === '2Y' ? C.t2y : C.t3y;
  // 창 밖·경계 구간은 residual 이 null → connectgaps:false 로 선이 끊긴다(0 으로 잇지 않는다).
  const trace = {
    x: rows.map(r => r.date), y: rows.map(r => r.residual),
    customdata: rows.map(r => [r.m, ROLE_KO[r.role], r.method === 'premium' ? 'P (=R−W)' : '이웃 선형보간',
                               r.R == null ? '' : `R ${fmt(r.R, 2)} / W ${fmt(r.W, 2)}`]),
    type: 'scatter', mode: 'lines+markers', connectgaps: false,
    line: { color, width: 1.4 }, marker: { size: 3.5, color },
    name: tsTag, showlegend: false,
    hovertemplate: '%{x}<br>잔차 %{y:.2f}bp · %{customdata[2]}<br>' +
                   '잔존 %{customdata[0]}개월 · %{customdata[1]} %{customdata[3]}<extra></extra>',
  };
  const nOk = rows.filter(r => r.residual != null).length;
  const nGap = rows.length - nOk;
  $('oc-ts-status').textContent = `${rows.length}영업일 중 산출 ${nOk} · 끊김 ${nGap}`;
  window.Plotly.react(box, [trace], {
    paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: C.muted, size: 11 },
    margin: { l: 56, r: 18, t: 12, b: 40 },
    xaxis: { gridcolor: C.border, zeroline: false },
    yaxis: { title: { text: '잔차 (bp)', font: { size: 11 } }, gridcolor: C.border,
             zeroline: true, zerolinecolor: C.muted, zerolinewidth: 1 },
    hovermode: 'closest', showlegend: false,
  }, { displayModeBar: false, responsive: true });

  const n = $('oc-ts-note');
  n.replaceChildren();
  n.append(
    el('b', null, '선 끊김 '),
    '= 그날 잔차를 산출하지 못한 구간(잔존 12~36개월 창 밖, 커브 양 끝 경계점, 경과물 3종목 미만). 0 으로 잇지 않는다. ',
    document.createElement('br'),
    '0선 외에 밴드·퍼센타일은 두지 않는다 — 세대 간 분산이 신호보다 커서 밴드가 의미를 갖지 못한다.',
  );
}

function initTs() {
  const sel = $('oc-ts-tag');
  sel.replaceChildren();
  const opts = [...DS.bonds].sort((a, b) => (a.maturity < b.maturity ? -1 : a.maturity > b.maturity ? 1 : 0));
  for (const b of opts) {
    const o = el('option', null, `${b.tag}  ${b.tenor}  만기 ${b.maturity}`);
    o.value = b.tag;
    sel.appendChild(o);
  }
  // 기본 선택 = 최신일의 3Y 지표물
  const last = snapshot(DS, DATES[DATES.length - 1]);
  const on3 = last.bonds.find(b => b.isOnTheRun && b.tenor === '3Y');
  tsTag = on3 ? on3.tag : opts[opts.length - 1].tag;
  sel.value = tsTag;
  sel.addEventListener('change', () => { tsTag = sel.value; renderTs(); });
  $('oc-ts-range').addEventListener('click', e => {
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    tsRange = btn.dataset.range;
    for (const b of $('oc-ts-range').querySelectorAll('button')) b.classList.toggle('active', b === btn);
    renderTs();
  });
  $('oc-ts-status').textContent = '색인 생성 중…';
  // 첫 화면을 먼저 그리고 나서 색인을 만든다(2,719일 × snapshot ≈ 1초).
  setTimeout(() => { buildIndex(); renderTs(); }, 0);
}

function go(want, { fromPicker = false } = {}) {
  const { date, snapped } = snapDate(want);
  const box = $('oc-snap');
  if (snapped && fromPicker) {
    box.replaceChildren();
    box.append(`선택한 `, el('span', 'k', want), `는 데이터에 없는 날 — 가장 가까운 이전 영업일 `,
               el('span', 'k', date), `로 이동했습니다.`);
    box.classList.remove('hidden');
  } else {
    box.classList.add('hidden');
  }
  cur = date;
  render();
}

// ── 라이트/다크 토글 (onoff-spread 와 localStorage 키 공유 · 기본 dark) ──
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.ooTheme = t;
  const btn = $('oc-theme-toggle');
  if (btn) btn.textContent = t === 'light' ? '☀️ 라이트' : '🌙 다크';
}

export function initOnoffCurve() {
  DS = window.ONOFF_BONDS;
  applyTheme(localStorage.getItem(LS_THEME));
  $('oc-theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.ooTheme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(LS_THEME, next); } catch (e) { /* 시크릿 모드 등 */ }
    applyTheme(next);
    window.dispatchEvent(new CustomEvent('oo-theme-change', { detail: { theme: next } }));
  });
  // 차트 색은 CSS 변수에서 읽어오므로 테마가 바뀌면 다시 그린다.
  window.addEventListener('oo-theme-change', () => {
    if (cur) renderChart(snapshot(DS, cur));
    if (TS_INDEX) renderTs();
  });

  if (!DS || !Array.isArray(DS.bonds) || !DS.bonds.length) {
    $('oc-meta').replaceChildren(el('span', 'sname', 'data/onoff-bonds.js 를 불러오지 못했습니다'));
    $('oc-table-card').replaceChildren(el('div', 'empty',
      'window.ONOFF_BONDS 가 비어 있습니다 — tools/convert-onoff-bonds.mjs 를 실행해 산출물을 만드세요.'));
    return;
  }

  DATES = allDates(DS);
  const dEl = $('oc-date');
  dEl.min = DATES[0];
  dEl.max = DATES[DATES.length - 1];
  renderLegend();

  // input[type=date] 는 연/월/일 세그먼트가 하나씩 확정될 때마다 change 를 쏜다. 연도를 '2026' 으로
  // 타이핑하면 0002 → 0020 → 0202 → 2026 순으로 네 번 발화하고, 그때마다 스냅이 걸려 엉뚱한 날로
  // 튄다. 입력이 멎을 때까지 기다렸다가 한 번만 반영한다(달력 위젯 선택은 1회 발화라 영향 없음).
  let dTimer = null;
  dEl.addEventListener('change', () => {
    clearTimeout(dTimer);
    dTimer = setTimeout(() => { if (dEl.value) go(dEl.value, { fromPicker: true }); }, 350);
  });
  $('oc-prev').addEventListener('click', () => { const i = DATES.indexOf(cur); if (i > 0) go(DATES[i - 1]); });
  $('oc-next').addEventListener('click', () => { const i = DATES.indexOf(cur); if (i >= 0 && i < DATES.length - 1) go(DATES[i + 1]); });
  $('oc-latest').addEventListener('click', () => go(DATES[DATES.length - 1]));

  go(DATES[DATES.length - 1]);
  initTs();
}
