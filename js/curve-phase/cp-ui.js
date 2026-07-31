// cp-ui.js — Curve Phase Monitor 페이지 컨트롤러. 표현 계층만(계산·판정 로직은 cp-calc/cp-judge 무변경).
//   "질문 3개" 구조: 히어로 결론 → Q1(단기 반영 게이지) → Q2(장기 요인 분해) → Q3(사이클 오버레이).
//   문구는 cp-text.js 로 분리. 원 지표/차트는 <details> 접힘으로 보존(설계자용 2층 구조).

import { loadCurveData, loadCycles } from './cp-data.js';
import { spreadSeries, colSpreadBp, fwd5y5y, seriesDiff, decompKR, decompUS, decompCycles, summarize, band, BAND_HI, BAND_LO } from './cp-calc.js';
import { C, applyPalette, LOOKBACKS, renderSpreadChart, renderDecompChart, renderOverlayChart, renderGauge, exportChart } from './cp-charts.js';
import { judgeKR, judgeUS, realizedKR } from './cp-judge.js';
import { buildOverlay } from './cp-overlay.js';
import { buildHikeMarkers, deriveKRHikes, usHikesFlat } from './cp-hikes.js';
import * as TXT from './cp-text.js';

const LS_KEY = 'curve-phase';
const HIST_KEY = 'cp-judge-history';
const LS_THEME = 'cp-theme';
const state = { lookback: '3y' };
let DATA = null;    // { krYields, krBase, usYields, usTp }
let SERIES = null;  // KR { s3, s1 } (bp)
let KRB = null;     // KR 뒷단 { fy:%, s3010:bp }
let US = null;      // US { gap:bp, fy:%, tp:%, exp:% }
let DECOMP = null;  // { kr:[...], us:[...] }
let OVERLAY = null; // { kr:[...], us:[...] } 또는 null
let SNAP = null;    // 스냅샷(요약+판정+실현+Q입력)

// 사이클 오버레이 색(현재 세대 제외). 테마별 — 렌더 시점에 getCycleColors() 로 읽는다.
const CYCLE_PALETTES = {
  dark: ['#f0883e', '#3fb950', '#a371f7', '#f85149', '#8b949e'],
  light: ['#d98e04', '#2f8f4e', '#7c5cbf', '#c9453a', '#a39b8c'],
};
const getCycleColors = () =>
  CYCLE_PALETTES[document.documentElement.dataset.cpTheme === 'light' ? 'light' : 'dark'];

const Q3_FULL_WINDOW = 250; // = cp-overlay eventAligned post 기본값(창 T+250). 새 창 관례 아님 — 진행 표기 분모.

const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : x.toFixed(d));
const signed = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d));
const pctStr = (p) => (p == null ? '—' : `${Math.round(p)}p`);
const toBp = (c) => (c == null ? null : c * 100); // %p chg60 → bp
const chg60Bp = (chg60, unit) => (chg60 == null ? '—' : `${signed(unit === 'bp' ? chg60 : chg60 * 100, 0)}bp`);

function zColor(z) {
  if (z == null || Number.isNaN(z)) return C.muted;
  if (Math.abs(z) < 1) return C.muted;
  if (z > 0) return z >= 2 ? C.red : C.amber;
  return C.up;
}
function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const idx = (sortedAsc.length - 1) * q, lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

// ── 스냅샷: 요약 + 판정 + 실현 + Q 입력 (계산은 cp-calc/judge 그대로) ──
function computeSnapshot() {
  const s3 = summarize(SERIES.s3), s1 = summarize(SERIES.s1);
  const fy = summarize(KRB.fy), s3010 = summarize(KRB.s3010);
  const tp = summarize(US.tp), exp = summarize(US.exp);
  const kr = judgeKR({ v1pct: s3.pct, kr5y5yChg60: toBp(fy.chg60), usTpChg60: toBp(tp.chg60) });
  const us = judgeUS({ usExpChg60: toBp(exp.chg60), usTpChg60: toBp(tp.chg60) });
  const real = realizedKR(DECOMP.kr.at(-1));
  // 직전 인상(20영업일 내) → 게이지 이동폭(3Y−기준 스프레드 변화)
  const b = DATA.krBase.data;
  let hikeDate = null;
  for (let i = b.length - 1; i > 0; i--) { if (b[i].rate > b[i - 1].rate) { hikeDate = b[i].date; break; } }
  let hike = null;
  if (hikeDate) {
    const s = SERIES.s3, idx = s.findIndex((d) => d[0] >= hikeDate), last = s.length - 1;
    if (idx > 0 && last - idx <= 20) hike = { date: hikeDate, deltaBp: Math.round((s[last][1] - s[idx - 1][1]) * 10) / 10 };
  }
  // Q3: 과거 사이클 Δ 범위 + 현재 출발점
  let q3 = null;
  if (OVERLAY) {
    const past = OVERLAY.kr.filter((o) => !o.current && o.deltaBp != null);
    const cur = OVERLAY.kr.find((o) => o.current);
    if (past.length && cur) {
      const ds = past.map((o) => o.deltaBp);
      q3 = { nCycles: past.length, deltaHi: Math.max(...ds), deltaLo: Math.min(...ds),
        currentT0Bp: cur.t0Bp, isLowest: cur.t0Bp <= Math.min(...past.map((o) => o.t0Bp)) };
    }
  }
  return { s3, s1, fy, s3010, tp, exp, kr, us, real, hike, q3 };
}

// ── 히어로: 판정 라벨(+괄호) · 결론 문장 · 실현 · 괴리 보조 · 기준일 ──
function renderHero() {
  const { kr, us, real, s3, fy, tp, exp } = SNAP;
  const el = document.getElementById('hero');
  el.className = `hero tone-${kr.tone}`;
  const diverge = TXT.divergenceNote(kr.key, real ? real.direction : null);
  el.innerHTML =
    `<div class="h-verdict">국면 판정 · <b>${TXT.krDisplayLabel(kr.key)}</b> <span class="h-paren">${TXT.verdictParen(kr.key)}</span></div>`
    + `<div class="h-conclusion">${TXT.conclusion(kr.key, us.key)}</div>`
    + (real ? `<div class="h-realized">${TXT.heroRealized(real)}</div>` : '')
    + (diverge ? `<div class="h-diverge">${diverge}</div>` : '')
    + `<div class="h-dates">기준일 · 단기게이지 <span class="k">${s3.date}</span> · KR 사이클금리 <span class="k">${fy.date}</span> · US 보유보상 <span class="k">${tp.date}</span> · US 체력 <span class="k">${exp.date}</span></div>`;
}

// ── Q1: 게이지 2개 + 해설 ──
function gaugeInput(series) {
  const sum = summarize(series);
  const sorted = series.map((d) => d[1]).slice().sort((a, b) => a - b);
  const cur = sum.last;
  return {
    min: sorted[0], max: sorted[sorted.length - 1], value: cur,
    t30: quantile(sorted, 0.30), t70: quantile(sorted, 0.70),
    leftLabel: TXT.GAUGE_LABELS.left, rightLabel: TXT.GAUGE_LABELS.right,
    valueLabel: `${fmt(cur, 1)}bp · 상위 ${sum.pct == null ? '—' : Math.round(100 - sum.pct)}%`,
  };
}
function renderGauges() {
  renderGauge('gauge-3y', gaugeInput(SERIES.s3));
  renderGauge('gauge-1y', gaugeInput(SERIES.s1));
}

// ── 섹션 해설 문구 ──
function renderBlurbs() {
  const { s3, fy, s3010, tp, exp, us, hike, q3 } = SNAP;
  document.getElementById('q1-blurb').textContent = TXT.q1Blurb({
    spreadBp: s3.last, pct: s3.pct, hikeDeltaBp: hike ? hike.deltaBp : null, hikeDate: hike ? hike.date : null,
  });
  document.getElementById('q2-us-blurb').textContent = TXT.q2US({ expDeltaBp: toBp(exp.chg60), tpDeltaBp: toBp(tp.chg60), usKey: us.key });
  document.getElementById('q2-kr-blurb').textContent = TXT.q2KR({ fyDeltaBp: toBp(fy.chg60), s3010Pct: s3010.pct });
  document.getElementById('q2-kr-note').textContent = TXT.Q2_KR_NOTE;
  if (q3) document.getElementById('q3-blurb').textContent = TXT.q3Blurb(q3);
}

// ── 판정 이력 (하단) ──
function loadHistory() { try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; } }
function upsertHistory(entry) {
  const h = loadHistory();
  const i = h.findIndex((e) => e.vintage === entry.vintage);
  if (i >= 0) h[i] = entry; else h.push(entry);
  h.sort((a, b) => (a.vintage < b.vintage ? -1 : 1));
  const trimmed = h.slice(-60);
  try { localStorage.setItem(HIST_KEY, JSON.stringify(trimmed)); } catch { /* noop */ }
  return trimmed;
}
function renderHistory() {
  const hist = loadHistory();
  const el = document.getElementById('hist');
  // 저장은 원 라벨(krLabel) 유지, 표시만 용어 사전(krKey→display) 변환.
  const rows = hist.slice(-10).reverse().map((e) =>
    `<div class="v-hist-row"><span class="k">${e.vintage}</span> ${TXT.krDisplayLabel(e.krKey) || e.krLabel}`
    + `${e.net == null ? '' : ` · 최근 한 달 ${signed(e.net, 1)}bp`}</div>`).join('');
  el.innerHTML = `<div class="v-hist-title">국면 판정 이력(최근)</div>`
    + (rows || '<div class="v-hist-row">이력 없음 — 다음 접속부터 누적</div>');
}

// ── 상세(원 카드/차트) ──
// colorKey = 팔레트 키(값이 아님). 모듈 로드 시점에 C.accent 를 복사하면 테마 전환이 반영되지 않는다.
const SPREADS = [
  { key: 's3', label: '3Y − 기준금리', tenor: 'y3', colorKey: 'accent' },
  { key: 's1', label: '1Y − 기준금리', tenor: 'y1', colorKey: 'up' },
];
const BANDS = [
  { key: 'resid', head: `≥${BAND_HI}p · 잔량많음`, desc: '인상 경로의 소화가 단기 구간에서 진행 중 — 역사적 플랫 국면' },
  { key: 'mixed', head: `${BAND_LO}–${BAND_HI}p · 혼재`, desc: '단기·장기 정보 혼재' },
  { key: 'exhausted', head: `≤${BAND_LO}p · 소진`, desc: '반영 소진 — 추가 정보는 장기 구간으로' },
];
function renderCards() {
  const baseRate = DATA.krBase.data.at(-1);
  const cards = SPREADS.map((s) => {
    const { last, pct, z } = summarize(SERIES[s.key]);
    return `<div class="stat">
      <div class="stat-label">${s.label}</div>
      <div class="stat-main">${fmt(last, 1)}<span class="stat-unit">bp</span></div>
      <div class="stat-sub">pct <span style="color:${zColor(z)}">${pctStr(pct)}</span> · z250 ${z == null ? '—' : signed(z, 2)}</div>
    </div>`;
  }).join('');
  document.getElementById('summary').innerHTML = cards + `<div class="stat">
      <div class="stat-label">기준금리(현재)</div>
      <div class="stat-main">${fmt(baseRate.rate, 2)}<span class="stat-unit">%</span></div>
      <div class="stat-sub">최신 ${baseRate.date}</div>
    </div>`;
}
function renderGuide() {
  const { pct } = summarize(SERIES.s3);
  const active = band(pct);
  const rows = BANDS.map((b) => `<div class="guide-row${b.key === active ? ' active' : ''}">
      <span class="guide-head">${b.head}</span><span class="guide-desc">${b.desc}</span></div>`).join('');
  document.getElementById('kr-guide').innerHTML =
    `<div class="guide-title">단기 반영 밴드 · 3Y−기준 = <b>${pctStr(pct)}</b></div>${rows}`;
}
function levelCard(label, sum) {
  return `<div class="stat"><div class="stat-label">${label}</div>
      <div class="stat-main">${fmt(sum.last, 2)}<span class="stat-unit">%</span></div>
      <div class="stat-sub">z250 ${sum.z == null ? '—' : signed(sum.z, 2)} · Δ60d ${chg60Bp(sum.chg60, '%')}</div></div>`;
}
function bpCard(label, sum) {
  return `<div class="stat"><div class="stat-label">${label}</div>
      <div class="stat-main">${fmt(sum.last, 1)}<span class="stat-unit">bp</span></div>
      <div class="stat-sub">z250 ${sum.z == null ? '—' : signed(sum.z, 2)} · Δ60d ${chg60Bp(sum.chg60, 'bp')}</div></div>`;
}
function renderKRBackCards() {
  document.getElementById('kr-back-summary').innerHTML =
    levelCard('사이클 이후 금리(5y5y)', summarize(KRB.fy)) + bpCard('초장기 보상(30−10)', summarize(KRB.s3010));
}
function renderUSCards() {
  const gap = summarize(US.gap);
  document.getElementById('us-summary').innerHTML = `<div class="stat">
      <div class="stat-label">DGS2 − EFFR</div>
      <div class="stat-main">${fmt(gap.last, 1)}<span class="stat-unit">bp</span></div>
      <div class="stat-sub">pct <span style="color:${zColor(gap.z)}">${pctStr(gap.pct)}</span> · z250 ${gap.z == null ? '—' : signed(gap.z, 2)}</div>
    </div>`
    + levelCard('사이클 이후 금리(5y5y)', summarize(US.fy))
    + levelCard('경제 체력 재평가', summarize(US.exp))
    + levelCard('장기채 보유 보상(TP)', summarize(US.tp));
}

// ── 차트(룩백 의존) ──
function renderKRChart() {
  renderSpreadChart('chart-kr-gap', SPREADS.map((s) => ({ name: s.label, color: C[s.colorKey], data: SERIES[s.key] })), state.lookback, 'bp');
}
function renderKRBackCharts() {
  renderSpreadChart('chart-kr-5y5y', [{ name: 'KR 5y5y', color: C.purple, data: KRB.fy }], state.lookback, '%');
  renderSpreadChart('chart-kr-3010', [{ name: 'KR 30Y−10Y', color: C.amber, data: KRB.s3010 }], state.lookback, 'bp');
}
function renderUSLevelCharts() {
  renderSpreadChart('chart-us-gap', [{ name: 'DGS2 − EFFR', color: C.accent, data: US.gap }], state.lookback, 'bp');
  renderSpreadChart('chart-us-decomp',
    [{ name: '경제 체력 재평가', color: C.up, data: US.exp }, { name: '장기채 보유 보상', color: C.amber, data: US.tp }],
    state.lookback, '%');
}
function renderLookbackCharts() { renderKRChart(); renderKRBackCharts(); renderUSLevelCharts(); }

// ── 분해 차트(범례 = 표시 용어) ──
function renderDecompCharts() {
  renderDecompChart('chart-kr-decomp', DECOMP.kr, [
    { key: 'front', name: TXT.DECOMP_LEGEND.frontKR, color: C.accent },
    { key: 'back', name: TXT.DECOMP_LEGEND.backKR, color: C.purple },
  ]);
  renderDecompChart('chart-us-decomp2', DECOMP.us, [
    { key: 'front', name: TXT.DECOMP_LEGEND.frontUS, color: C.accent },
    { key: 'backExp', name: TXT.DECOMP_LEGEND.backExpUS, color: C.up },
    { key: 'backTp', name: TXT.DECOMP_LEGEND.backTpUS, color: C.amber },
  ]);
}

// ── 사이클 오버레이 ──
// 색은 저장하지 않고 렌더 시점에 입힌다(테마 전환 반영). 순서는 입력 배열 순 — 다크/라이트 동일 배정.
function withColors(overlays) {
  const cyc = getCycleColors();
  let i = 0;
  return overlays.map((o) => ({ ...o, color: o.current ? C.accent : cyc[i++ % cyc.length] }));
}
// 마커 범례 1줄. ▲/◇ 글리프는 마커색과 무관한 기호 안내 → muted 텍스트(accent-as-text 아님).
//   '◇ 미표시'는 그 사이클의 최종 인상이 창(T+250) 밖이라는 뜻(예: KR 2005/2021·US 2016/2022).
const HIKE_LEGEND = '<div class="cyc-legend">▲ 인상 · ◇ 최종 인상 · 크기 ∝ 인상폭 · ◇ 미표시 = 최종 인상이 창 밖</div>';
function renderCaptions(id, overlays) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = HIKE_LEGEND + overlays.map((o) => {
    const d = o.deltaBp == null ? '' : `<span class="cyc-delta">Δ ${signed(o.deltaBp, 1)}bp</span>`;
    const win = o.lastOffset == null ? '' : ` <span class="cyc-win">(T0→T+${o.lastOffset})</span>`;
    return `<div class="cyc-row">
        <span class="cyc-swatch" style="background:${o.color}${o.current ? '' : ';opacity:.55'}"></span>
        <span class="cyc-lab">${o.label}</span><span class="cyc-cap">${o.caption}</span>${d}${win}</div>`;
  }).join('');
}
// 마커 부착: KR=기준금리 도출 인상, US=전체 인상(usHikesFlat) 을 각 사이클 창(o.points)에 매핑.
//   buildHikeMarkers 가 창 밖·offset 0(T=0 첫 인상) 제외 → 0개면 renderOverlayChart 가 trace skip.
function attachMarkers(overlays, market, hikes) {
  return overlays.map((o) => ({ ...o, market, markers: buildHikeMarkers(o.points, hikes) }));
}
function renderOverlays() {
  if (!OVERLAY) return;
  const krHikes = deriveKRHikes(DATA.krBase.data), usHikes = usHikesFlat();
  const kr = attachMarkers(withColors(OVERLAY.kr), 'KR', krHikes);
  const us = attachMarkers(withColors(OVERLAY.us), 'US', usHikes);
  renderOverlayChart('chart-kr-overlay', kr);
  renderOverlayChart('chart-us-overlay', us);
  renderCaptions('kr-caps', kr);
  renderCaptions('us-caps', us);
}

// ── Q3b: 인상 사이클 플랫의 성분 분해 테이블(측정만) ──
//   Δs310 은 오버레이 deltaBp 와 바이트 일치(동일 소스·창). 기여 정수·100%초과/음수 있는 그대로.
function renderQ3Decomp() {
  const el = document.getElementById('q3-decomp');
  if (!el || !OVERLAY) return;
  const rows = decompCycles(OVERLAY.kr, DATA.krYields.data, 'y3', 'y10');
  const bp = (x) => (x == null ? '—' : `${signed(x, 1)}`);
  const pc = (x) => (x == null ? '—' : `${x}%`);
  const body = rows.map((r) => {
    const win = r.current
      ? `진행 ${r.lastOffset}일/${Q3_FULL_WINDOW}일`
      : `T0→T+${r.lastOffset}`;
    return `<tr${r.current ? ' class="q3d-current"' : ''}>
        <td>${r.label}</td><td class="num">${win}</td>
        <td class="num">${bp(r.ds310)}</td>
        <td class="num">${bp(r.dyShort)}</td><td class="num">${bp(r.dyLong)}</td>
        <td class="num">${pc(r.shortContrib)}</td><td class="num">${pc(r.longContrib)}</td>
      </tr>`;
  }).join('');
  el.innerHTML = `<thead><tr>
      <th>사이클</th><th class="num">창</th><th class="num">Δs310</th>
      <th class="num">Δy3</th><th class="num">Δy10</th><th class="num">3Y 기여</th><th class="num">10Y 기여</th>
    </tr></thead><tbody>${body}</tbody>`;
  document.getElementById('q3-decomp-note').innerHTML =
    '<div>기여율 합 100%. 3Y 기여가 음수면 3Y도 하락했으나 10Y가 더 하락(불플랫), 100% 초과면 10Y도 상승했으나 3Y가 더 상승(베어플랫).</div>'
    + '<div>Δs310가 +(스팁)인 행은 같은 기여율이 \'스팁에 대한 기여\'로 읽힘 — 10Y 기여가 100% 초과면 3Y도 상승했으나 10Y가 더 상승(스팁 주도).</div>';
}

function renderControls() {
  document.querySelectorAll('#lookback-seg button').forEach((b) => b.classList.toggle('active', b.dataset.lb === state.lookback));
}

// 플롯 카드(.chart-box 보유)에만 발표용 PNG 버튼. 게이지·표 카드 제외. 한 번만 부착.
const CP_EXPORT_CHARTS = ['chart-kr-gap', 'chart-us-gap', 'chart-us-decomp2', 'chart-kr-decomp',
  'chart-us-decomp', 'chart-kr-5y5y', 'chart-kr-3010', 'chart-kr-overlay', 'chart-us-overlay'];
function addExportButtons() {
  CP_EXPORT_CHARTS.forEach((elId) => {
    const box = document.getElementById(elId);
    const head = box && box.closest('.chart-card') && box.closest('.chart-card').querySelector('.chart-head');
    if (!head || head.querySelector('.png-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'png-btn'; btn.type = 'button'; btn.textContent = 'PNG';
    btn.title = '발표용 고해상도 PNG 내보내기 (1200px·라이트 고정)';
    btn.addEventListener('click', () => exportChart(elId, `cp-${elId}_present`)); // Plotly 가 .png 부착
    head.appendChild(btn);
  });
}
function renderFootnote() {
  const my = DATA.krYields.meta, mb = DATA.krBase.meta, uy = DATA.usYields.meta, ut = DATA.usTp.meta;
  document.getElementById('footnote').innerHTML =
    `<div><b>측정 한계</b> — 이 화면은 측정만 합니다(포지션 제안 없음).</div>`
    + `<div>① 한국은 공식 장기채 보유 보상(텀프리미엄) 시계열이 없어 '장기 요인'을 합산(사이클 이후 금리)으로만 측정하고, 미국 분해를 참고로 해석합니다.</div>`
    + `<div>② '사이클 이후 금리(5y5y)'는 2×10Y−5Y 단순 근사 — 레벨 편의가 있어 방향·상대위치(z) 추적 전용입니다.</div>`
    + `<div>③ 단기/장기 요인 분해는 관측이 아니라 모델 추정(미국 ACM 포함)입니다.</div>`
    + `<div>기준금리 반영은 <span class="k">직전 관측값 carry-forward(계단, 보간 없음)</span>. 2008-03 이전은 콜금리목표제 — ECOS back-stitch. `
    + `판정 임계값(게이지 30/70 · 60일 ±10bp)은 초기값(관찰 후 조정). 판정=조건(60일), 실현=최근 한 달(20일) 분해 — 갈릴 수 있음.</div>`
    + `<div>출처: <span class="k">ECOS</span> 국고채 ${my.updated_at}·기준금리 ${mb.updated_at} · <span class="k">FRED</span> US ${uy.updated_at}·ACM ${ut.updated_at}.</div>`;
}

function renderAll() {
  renderHero(); renderBlurbs(); renderGauges();
  renderCards(); renderGuide(); renderKRBackCards(); renderUSCards();
  renderDecompCharts(); renderOverlays(); renderQ3Decomp(); renderLookbackCharts();
  renderControls(); renderHistory(); renderFootnote();
}

// ── 라이트/다크 토글 (자료·캡처용 · localStorage 'cp-theme' · 기본 dark) ──
// CSS 는 html[data-cp-theme] 로 전환. 차트 팔레트는 applyPalette 로 갈아끼운 뒤 색이 들어간 것만 다시 그린다.
// GC 섹션(gc-ui.js)은 같은 이벤트를 독립적으로 듣는다 — 여기서 GC 를 호출하지 않는다.
function applyTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.cpTheme = t;
  applyPalette(t);
  const btn = document.getElementById('cp-theme-toggle');
  if (btn) btn.textContent = t === 'light' ? '☀️ 라이트' : '🌙 다크';
  return t;
}

// 색이 들어간 요소만 현재 상태 그대로 다시 그린다(계산·판정 재실행 없음).
function redrawForTheme() {
  if (!SNAP) return;
  renderGauges();                              // 게이지: 바늘·음영 rect
  renderCards(); renderUSCards();              // zColor 가 들어간 카드
  renderDecompCharts(); renderOverlays(); renderLookbackCharts();
}

function initTheme() {
  let saved = 'dark';
  try { saved = localStorage.getItem(LS_THEME) === 'light' ? 'light' : 'dark'; } catch { /* noop */ }
  applyTheme(saved);
  const btn = document.getElementById('cp-theme-toggle');
  if (btn) btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.cpTheme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem(LS_THEME, next); } catch { /* noop */ }
    window.dispatchEvent(new CustomEvent('cp-theme-change', { detail: { theme: next } }));
  });
  window.addEventListener('cp-theme-change', redrawForTheme);
}

// ── 와이드/세로 비율 토글 (자료 캡처용 · localStorage 'cp-ratio' · 기본 wide) ──
// CSS 는 html[data-cp-ratio] 로 카드 레이아웃을 바꾸고, 차트는 새 컨테이너 크기로 다시 그린다(테마 재렌더 경로 재사용).
// GC 섹션은 같은 이벤트를 독립 수신 — 여기서 GC 를 호출하지 않는다.
function syncRatioSeg() {
  const cur = document.documentElement.dataset.cpRatio === 'narrow' ? 'narrow' : 'wide';
  document.querySelectorAll('#cp-ratio-seg button').forEach((b) => b.classList.toggle('active', b.dataset.ratio === cur));
}
function initRatio() {
  syncRatioSeg();
  const seg = document.getElementById('cp-ratio-seg');
  if (seg) seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-ratio]'); if (!btn) return;
    const r = btn.dataset.ratio === 'narrow' ? 'narrow' : 'wide';
    if (document.documentElement.dataset.cpRatio === r) return;
    document.documentElement.dataset.cpRatio = r;
    try { localStorage.setItem('cp-ratio', r); } catch { /* noop */ }
    syncRatioSeg();
    window.dispatchEvent(new CustomEvent('cp-ratio-change', { detail: { ratio: r } }));
  });
  window.addEventListener('cp-ratio-change', redrawForTheme);
}

function save() { try { localStorage.setItem(LS_KEY, JSON.stringify({ kind: LS_KEY, version: 1, lookback: state.lookback })); } catch { /* noop */ } }
function loadPrefs() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch { s = null; }
  if (s && LOOKBACKS.includes(s.lookback)) state.lookback = s.lookback;
}

function wire() {
  const seg = document.getElementById('lookback-seg');
  if (seg) seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    const lb = btn.dataset.lb; if (!LOOKBACKS.includes(lb) || lb === state.lookback) return;
    state.lookback = lb; save();
    renderLookbackCharts(); renderControls();
  });
  // <details> 안의 차트는 display:none 상태로 렌더되므로 열릴 때 리사이즈.
  document.querySelectorAll('details.adv').forEach((d) => d.addEventListener('toggle', () => {
    if (!d.open) return;
    d.querySelectorAll('.chart-box, .gauge-box').forEach((el) => { if (el && el.data) window.Plotly.Plots.resize(el); });
  }));
}

export async function initCurvePhase() {
  initTheme(); // 데이터 로드 실패해도 토글은 동작해야 하므로 가드보다 먼저
  initRatio();
  loadPrefs();
  const loaded = await loadCurveData();
  if (!loaded) {
    document.getElementById('app').insertAdjacentHTML('beforeend',
      `<div class="empty"><code>data/curve/*.json</code> 을 fetch로 읽으므로 <b>로컬 서버</b>가 필요합니다 (file:// 직접 열기 불가).<br>`
      + `예: <code>python -m http.server</code> 후 <code>localhost:8000/curve-phase.html</code></div>`);
    return;
  }
  DATA = loaded.data;
  const krRows = DATA.krYields.data, baseArr = DATA.krBase.data, usRows = DATA.usYields.data;
  SERIES = { s3: spreadSeries(krRows, baseArr, 'y3'), s1: spreadSeries(krRows, baseArr, 'y1') };
  KRB = { fy: fwd5y5y(krRows, 'y10', 'y5'), s3010: colSpreadBp(krRows, 'y30', 'y10') };
  const fy = fwd5y5y(usRows);
  const tp = DATA.usTp.data.map((r) => [r.date, r.tp10]);
  US = { gap: colSpreadBp(usRows, 'dgs2', 'effr'), fy, tp, exp: seriesDiff(fy, tp) };
  DECOMP = { kr: decompKR(krRows, baseArr), us: decompUS(usRows, DATA.usTp.data) };
  const cycles = await loadCycles();
  if (cycles) OVERLAY = { // 색 없이 보관 — renderOverlays 가 테마에 맞춰 입힌다
    kr: buildOverlay(krRows, 'y10', 'y3', cycles.kr || []),
    us: buildOverlay(usRows, 'dgs10', 'dgs2', cycles.us || []),
  };
  SNAP = computeSnapshot();
  upsertHistory({ vintage: DATA.krYields.meta.updated_at, krKey: SNAP.kr.key, krLabel: SNAP.kr.label, usLabel: SNAP.us.label, net: SNAP.real ? SNAP.real.netBp : null });
  wire();
  renderAll();
  addExportButtons();
}
