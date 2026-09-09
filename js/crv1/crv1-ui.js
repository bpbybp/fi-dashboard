// crv1-ui.js — CRV-1 국고 커브 구간 상대가치 화면.
//
// 용도는 하나다: "지금 커브에서 어느 구간이 중립 대비 어디에 있고, 그 위치가 최근 250영업일
//   범위의 어디쯤인가"를 한 화면에서 읽는 자(ruler).
//
// [측정 전용] 판단 문구·색상 신호·화살표를 넣지 않는다. 숫자는 전부 무채색이고, 색이라곤
//   범위 바의 마커(--accent) 한 점뿐이다. 그 점도 '어디쯤인가'를 가리킬 뿐 판정이 아니다.
//   임계값·이산 밴드·판정 라벨 금지 — 선을 하나라도 그으면 그 선을 넘었다는 사실이 곧
//   판정으로 읽힌다(CS-1 과 같은 규약).
//
// [계산 무개입] 산출은 전부 js/crv1/crv1-calc.js 가 한다. 이 파일은 **표시만** 한다 —
//   여기서 값을 다시 만들거나 보정하지 않는다. 화면이 계산을 조금씩 고쳐 쓰기 시작하면
//   테스트가 고정한 산식과 화면의 숫자가 갈라진다. 정렬·서식·결측 표기까지가 이 파일의 몫이다.
//   범위 바의 마커 위치도 calc 가 낸 range.pos(0~1)를 그대로 쓴다(여기서 다시 계산하지 않는다).
//
// 데이터: data/ktb-curve.js 를 classic <script> 로 먼저 읽어 window.KTB_CURVE 로 받는다
//   (curve-efficiency.html 과 같은 방식). fetch 없음 — 신규 네트워크 호출을 만들지 않는다.

import { snapshot, WINDOW } from './crv1-calc.js';
import { DEFAULT_WINDOW, WINDOW_LABEL, history, slice, stats } from './crv1-history.js';
import { captionText, chartSvg, headlineText } from './crv1-chart.js';

/** 중립 기준 토글. 기본은 듀레이션 — 시간 중립은 볼록 구간에서 구조적으로 어긋난다. */
export const NEUTRAL_BASES = [
  { key: 'duration', label: '듀레이션' },
  { key: 'time', label: '시간' },
];
export const DEFAULT_BASIS = 'duration';

/** 이력 패널 표시 토글. 기본은 비중 — 갭은 중립 선택에 딸린 파생값이라 한 겹 뒤다. */
export const CHART_MODES = [
  { key: 'ratio', label: '비중' },
  { key: 'gap', label: '갭' },
];
export const DEFAULT_MODE = 'ratio';

const LS_KEY = 'crv1-view';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (v, d = 2) => (isNum(v) ? v.toFixed(d) : '—');
const signed = (v, d = 2) => (isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(d) : '—');
/** 범위 끝값은 소수 1자리로 줄인다 — 2자리까지 두면 바 양옆이 숫자로 꽉 찬다. */
const end = (v) => (isNum(v) ? v.toFixed(1) : '—');

/** 구간 비중 행 라벨. 3점은 '/' 로 묶는다 — '–' 를 쓰면 범위로 읽힌다. */
export const tripleLabel = (it) => `${it.s}/${it.m}/${it.l}Y`;
/** 기울기 행 라벨. 이쪽은 실제 구간이므로 '–'. */
export const pairLabel = (it) => `${it.s}–${it.l}Y`;

/**
 * flag → 행 끝 라벨. 값이 없는 이유를 한 단어로만 밝힌다(판정이 아니라 사유 표기).
 *   tight       분모(양끝 금리차)가 5bp 미만 — 비중이 발산해 숫자가 의미를 잃는다
 *   missing     입력 결측(50Y 미관측 구간 등)
 *   degenerate  듀레이션이 만기에 단조증가하지 않음 — 정상 커브에선 안 나오는 방어 표기
 */
export function flagLabel(flag) {
  if (flag === 'tight') return '역전/압축';
  if (flag === 'missing') return '결측';
  if (flag === 'degenerate') return '퇴화';
  return '';
}

const FLAG_TITLE = {
  tight: '양끝 금리차가 5bp 미만이라 비중이 발산한다 — 산출하지 않는다',
  missing: '입력 금리가 결측이라 산출하지 않는다',
  degenerate: '듀레이션이 만기에 단조증가하지 않는다 — 방어 표기',
};

/**
 * 기울기 행 정렬 — 렌더 시점 값 기준 내림차순, null 은 최하단.
 * 같은 값·null 끼리는 원래(만기 오름차순) 순서를 유지한다(안정 정렬).
 * 원본 배열을 건드리지 않는다.
 */
export function sortSlopes(slopes) {
  return slopes
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const av = isNum(a.it.slope), bv = isNum(b.it.slope);
      if (av && bv) return (b.it.slope - a.it.slope) || (a.i - b.i);
      if (av) return -1;   // 값 있는 행이 먼저
      if (bv) return 1;
      return a.i - b.i;    // null 끼리는 만기 순서 유지
    })
    .map((x) => x.it);
}

/**
 * 화면이 쓰는 뷰 모델. 계산은 snapshot 이 다 하고 여기서는 기울기 정렬만 얹는다.
 * @param {{grid:number[], rows:Array}} curve  window.KTB_CURVE
 * @param {'duration'|'time'} basis
 */
export function buildView(curve, basis = DEFAULT_BASIS) {
  const snap = snapshot(curve, { neutral: basis });
  return { ...snap, slopes: sortSlopes(snap.slopes) };
}

/** 창 표기. 250 미만이면 그 사실을 숨기지 않고 가용 행수를 함께 밝힌다. */
export function windowLabel(view) {
  const base = `창 n=${view.window}`;
  return view.window >= WINDOW ? base : `${base} (250 미만 — 가용 ${view.rowsAvailable}행 전량)`;
}

/**
 * 250일 위치 셀. 트랙은 창 min–max, 마커는 현재값 한 점.
 * 구간을 색으로 나누지 않는다(밴드 = 판정이 되어버린다).
 * pos 가 없으면(표본 1개·폭 0) 마커 없이 흐린 트랙만 둔다 — 범위가 있다는 사실은 남긴다.
 */
export function barHTML(range, unit) {
  if (!isNum(range.min) || !isNum(range.max)) {
    return '<div class="rb none" title="창 안 유효 관측 없음">—</div>';
  }
  const marker = range.pos == null
    ? '<div class="bar empty" title="위치 산출 불가(표본 1개 또는 폭 0)"></div>'
    : `<div class="bar"><i style="left:${(range.pos * 100).toFixed(1)}%"></i></div>`;
  const tip = `창 ${end(range.min)} ~ ${end(range.max)}${unit} · 표본 ${range.n}일`
    + (range.pos == null ? ' · 위치 산출 불가' : ` · 위치 ${(range.pos * 100).toFixed(0)}%`);
  return `<div class="rb" title="${esc(tip)}">`
    + `<span class="e">${end(range.min)}</span>${marker}<span class="e">${end(range.max)}</span>`
    + `<span class="n">n=${range.n}</span></div>`;
}

/** 값이 없는 행의 자리표시. 사유 라벨은 행 끝 별도 칸에 붙는다. */
const nil = '<span class="nil">—</span>';

/**
 * 구간 비중 1행. tight 여도 중립은 참조용으로 남긴다(금리를 쓰지 않는 값이라 살아 있다).
 * data-key 는 아래 이력 패널이 어느 조합을 그릴지 고르는 손잡이다 — 값이 없는 행도 고를 수
 * 있어야 한다(오늘 압축이어도 이력은 있다). 선택 하이라이트는 렌더가 아니라 classList 로
 * 얹는다 — 호버 미리보기마다 표를 다시 그리면 마우스가 자기 아래의 DOM 을 잃는다.
 */
export function weightRowHTML(it) {
  const dead = it.flag != null;
  const lab = flagLabel(it.flag);
  return `<tr data-key="${esc(it.key)}"${dead ? ' class="dead"' : ''}>`
    + `<th>${esc(tripleLabel(it))}</th>`
    + `<td class="num">${dead ? nil : fmt(it.ratio)}</td>`
    + `<td class="num">${fmt(it.neutral)}</td>`
    + `<td class="num">${dead ? nil : signed(it.gap)}</td>`
    + `<td class="pos">${dead ? nil : barHTML(it.range, '%p')}</td>`
    + `<td class="flag">${lab ? `<span class="fl" title="${esc(FLAG_TITLE[it.flag] || '')}">${esc(lab)}</span>` : ''}</td>`
    + '</tr>';
}

/** 듀레이션당 기울기 1행. */
export function slopeRowHTML(it) {
  const dead = it.flag != null;
  const lab = flagLabel(it.flag);
  return `<tr${dead ? ' class="dead"' : ''}>`
    + `<th>${esc(pairLabel(it))}</th>`
    + `<td class="num">${dead ? nil : signed(it.slope)}</td>`
    + `<td class="pos">${dead ? nil : barHTML(it.range, 'bp/dur')}</td>`
    + `<td class="flag">${lab ? `<span class="fl" title="${esc(FLAG_TITLE[it.flag] || '')}">${esc(lab)}</span>` : ''}</td>`
    + '</tr>';
}

/** 두 표의 tbody HTML. 상단은 만기 오름차순 고정, 하단은 값 내림차순. */
export function renderTables(view) {
  return {
    weights: view.weights.map(weightRowHTML).join(''),
    slopes: view.slopes.map(slopeRowHTML).join(''),
  };
}

// ── 이력 패널 (Phase 4) ──────────────────────────────────────────────────────
//
// 표는 최신일 한 줄이고 차트는 그 줄이 어디서 왔는지를 보여 준다. 둘은 같은 산식(weightsAt)에서
// 나오므로 차트 제목의 현재값과 표의 같은 행 숫자는 항상 일치해야 한다 — 어긋나면 배선 오류다.

/**
 * 차트 한 장에 필요한 것 전부. 계산은 crv1-history 가, 그리기는 crv1-chart 가 한다.
 * 여기서 값을 만들거나 보정하지 않는다(이 파일의 규약 — 헤더 11-14행).
 *
 * @param {ReturnType<import('./crv1-history.js').history>} hist
 * @param {string} key                조합 키. 없거나 못 찾으면 첫 조합으로 접는다.
 * @param {'ratio'|'gap'} mode
 * @param {number|'all'} win
 */
export function chartModel(hist, key, mode = DEFAULT_MODE, win = DEFAULT_WINDOW) {
  const s = hist.series.find((x) => x.key === key) || hist.series[0];
  const values = mode === 'gap' ? s.gap : s.ratio;
  const st = stats(values, win, s.flag);
  const last = s.dates.length - 1;
  return {
    key: s.key,
    label: tripleLabel(s),
    headline: headlineText({ ratio: s.ratio[last], neutral: s.neutral[last], gap: s.gap[last] }),
    caption: captionText(st),
    stats: st,
    svg: chartSvg({
      dates: slice(s.dates, win),
      main: slice(values, win),
      // 중립은 비중과 같은 축 위에서만 뜻이 있다. 갭 뷰에서 중립은 정의상 0선이라 겹친다.
      dashed: mode === 'gap' ? null : slice(s.neutral, win),
      mean: st.mean,
      zeroRef: mode === 'gap',
      unit: mode === 'gap' ? '%p' : '%',
      signed: mode === 'gap',
      ariaLabel: `${tripleLabel(s)} ${mode === 'gap' ? '갭' : '비중'} ${WINDOW_LABEL[win]} 이력`,
    }),
  };
}

/** 토글 버튼 활성 표시. data-* 값이 현재 상태와 같은 버튼에만 .active 를 얹는다. */
function markActive(containerId, attr, value) {
  const box = document.getElementById(containerId);
  if (!box) return;
  for (const btn of box.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset[attr] === String(value));
  }
}

// ── 상태 ─────────────────────────────────────────────────────────────────────

function loadBasis() {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (NEUTRAL_BASES.some((b) => b.key === v)) return v;
  } catch { /* noop */ }
  return DEFAULT_BASIS;
}
function saveBasis(b) {
  try { localStorage.setItem(LS_KEY, b); } catch { /* noop */ }
}

// ── init ─────────────────────────────────────────────────────────────────────

export function initCrv1() {
  const statusEl = document.getElementById('crv1-status');
  const appEl = document.getElementById('crv1-app');
  if (!statusEl || !appEl) return;

  const curve = typeof window !== 'undefined' ? window.KTB_CURVE : null;
  if (!curve || !Array.isArray(curve.rows) || curve.rows.length === 0) {
    statusEl.className = 'empty';
    statusEl.innerHTML = '<b>데이터를 불러오지 못했습니다.</b><br>'
      + 'data/ktb-curve.js 가 없거나 비어 있습니다. update-data.bat 을 실행해 생성하십시오.';
    return;
  }

  let basis = loadBasis();
  let mode = DEFAULT_MODE;
  let win = DEFAULT_WINDOW;
  let selKey = null;      // 클릭으로 고정한 행. 첫 렌더에서 첫 조합으로 채운다.
  let hoverKey = null;    // 호버 미리보기. mouseleave 면 비우고 고정 행으로 되돌아간다.

  // 이력은 basis 당 한 번만 만든다(2,629행 × 9조합 ≈ 30ms). 창 전환·행 선택·호버는
  // 이 결과를 슬라이스만 하므로 재계산이 없다 — 호버마다 다시 계산하면 표 위를 훑는 것만으로
  // 초당 수십 번 전체 이력이 돌게 된다.
  const histCache = Object.create(null);
  const getHist = (b) => (histCache[b] ||= history(curve, { neutral: b }));

  const wbody = document.getElementById('crv1-wbody');
  const chartEl = document.getElementById('crv1-chart');
  const titleEl = document.getElementById('crv1-chart-title');
  const headEl = document.getElementById('crv1-chart-head');
  const capEl = document.getElementById('crv1-chart-caption');

  /** 고정 행 하이라이트. 표를 다시 그리지 않고 class 만 갈아 끼운다. */
  const applySel = () => {
    if (!wbody) return;
    for (const tr of wbody.querySelectorAll('tr[data-key]')) {
      tr.classList.toggle('sel', tr.dataset.key === selKey);
    }
  };

  const drawChart = () => {
    if (!chartEl) return;
    const m = chartModel(getHist(basis), hoverKey || selKey, mode, win);
    selKey ||= m.key;                       // 첫 렌더: 첫 조합이 곧 초기 선택
    chartEl.innerHTML = m.svg;
    if (titleEl) titleEl.textContent = m.label;
    if (headEl) headEl.textContent = m.headline;
    if (capEl) capEl.textContent = m.caption;
    markActive('crv1-mode', 'mode', mode);
    markActive('crv1-win', 'win', win);
  };

  const draw = () => {
    let view;
    try {
      view = buildView(curve, basis);
    } catch (err) {
      statusEl.className = 'empty';
      statusEl.style.display = '';
      statusEl.textContent = `계산 실패: ${err.message}`;
      appEl.style.display = 'none';
      return;
    }
    const t = renderTables(view);
    wbody.innerHTML = t.weights;
    document.getElementById('crv1-sbody').innerHTML = t.slopes;
    document.getElementById('crv1-asof').textContent = view.date;
    document.getElementById('crv1-window').textContent = windowLabel(view);
    document.getElementById('crv1-neutral-col').textContent =
      `중립 (${NEUTRAL_BASES.find((b) => b.key === basis).label})`;
    markActive('crv1-basis', 'basis', basis);
    drawChart();       // 중립 기준이 바뀌면 neutral·gap 이 통째로 달라진다 → 차트도 같이 간다
    applySel();
  };

  document.getElementById('crv1-basis').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.dataset.basis === basis) return;
    basis = btn.dataset.basis;
    saveBasis(basis);
    draw();
  });

  document.getElementById('crv1-mode')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.dataset.mode === mode) return;
    mode = btn.dataset.mode;
    drawChart();
  });

  document.getElementById('crv1-win')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const v = btn.dataset.win === 'all' ? 'all' : Number(btn.dataset.win);
    if (v === win) return;
    win = v;
    drawChart();
  });

  // 클릭 = 고정, 호버 = 미리보기. 미리보기는 하이라이트를 옮기지 않는다 — 표에서 시선이
  // 지나간 행마다 강조가 따라다니면 무엇이 선택된 것인지 알 수 없게 된다.
  if (wbody) {
    wbody.addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-key]');
      if (!tr || tr.dataset.key === selKey) return;
      selKey = tr.dataset.key;
      hoverKey = null;
      applySel();
      drawChart();
    });
    wbody.addEventListener('mouseover', (e) => {
      const tr = e.target.closest('tr[data-key]');
      const k = tr ? tr.dataset.key : null;
      if (k === hoverKey) return;
      hoverKey = k;
      drawChart();
    });
    wbody.addEventListener('mouseleave', () => {
      if (hoverKey == null) return;
      hoverKey = null;
      drawChart();
    });
  }

  statusEl.style.display = 'none';
  appEl.style.display = '';
  draw();
}
