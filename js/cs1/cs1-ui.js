// cs1-ui.js — CS-1 크레딧 섹터 스프레드 모니터 화면.
//
// 용도는 하나다: 발행금리를 보고 "이 레벨이 올해 범위 어디쯤인가"를 즉시 읽는 자(ruler).
//   예) 신한은행 3Y 4.18 발행 → 은행채AAA 행의 3년 칸에서 현재 스프레드와 YTD 범위 내 위치를 본다.
//
// [측정 전용] 시그널·해석·스코어링 텍스트를 넣지 않는다. 숫자는 전부 무채색으로 두고
//   방향(+/−)은 부호로만 읽는다. 셀 배경 히트맵(기본 off)의 색은 YTD 범위 내 위치의 연속
//   표현일 뿐, 좋다/나쁘다·가치 판정을 말하지 않는다 — 임계값·이산 밴드·판정 라벨은 넣지
//   않는다. 그래서 색은 어느 지점에서도 튀지 않고 중앙에서 양 끝으로 매끈하게만 짙어진다.
//   국고 당일 레벨은 표시하지 않는다 — 그건 보는 사람이 이미 알고 있고, 여기 얹으면
//   "국고 대비 몇 bp"라는 이 화면의 단위가 흐려진다.
//
// 데이터: data/cs1/spreads.json (원시 bp 스프레드 시계열만). 통계는 js/cs1/cs1-stats.js 에서
//   클라이언트가 계산한다. 신규 fetch 는 이 한 건뿐이고 다른 모듈 데이터는 건드리지 않는다.

import { cellStats } from './cs1-stats.js';

const DATA_URL = 'data/cs1/spreads.json';
const LS_KEY = 'cs1-view';

/** 상단 고정 행 — 이 화면을 만든 이유인 4개. 소스 순서와 무관하게 여기 순서로 둔다. */
const PINNED = ['산금채AAA', '중금채AAA', '은행채AAA', '공사채AAA'];

/**
 * 기본 노출 만기. 11개를 다 펼치면 셀이 5줄짜리라 가로로 읽히지 않는다.
 * '전체' 토글로 나머지(3월·6월·9월·1.5년·2.5년·4년·10년)를 꺼낸다.
 */
const DEFAULT_TENORS = ['1년', '2년', '3년', '5년'];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const fmt = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '—');
const signed = (v, d = 1) => (isNum(v) ? (v > 0 ? '+' : '') + v.toFixed(d) : '—');
/** 범위 표기는 정수 bp 로 줄인다 — 소수까지 두면 셀이 넘친다. */
const range = (r) => (isNum(r.min) && isNum(r.max) ? `${Math.round(r.min)}–${Math.round(r.max)}` : '—');

// ── 히트맵 틴트 ───────────────────────────────────────────────────────────────

/**
 * 셀 배경 틴트의 최대 불투명도. 이 위로 올리면 --muted 로 찍는 10px 보조 숫자와 범위 바가
 * 배경에 먹힌다(둘 다 무채색 저채도라 배경 채도에 취약하다). 그래서 색을 진하게 하는 대신
 * 여기서 멈추고, 보조 텍스트·바·마커 CSS 는 그대로 둔다.
 */
export const MAX_TINT_ALPHA = 0.22;
/** 타이트측(ytdPct 0) 청록 · 와이드측(ytdPct 100) 호박. 마커 --accent(청색)와 색상이 겹치지 않는 쌍. */
const TINT_TIGHT = '56, 178, 172';
const TINT_WIDE = '217, 144, 42';

/**
 * YTD 범위 내 위치(0~100) → 셀 배경 틴트 rgba.
 * 50(중앙)에서 알파 0, 양 끝으로 갈수록 선형으로 짙어져 MAX_TINT_ALPHA 에서 멈춘다.
 * 구간을 나누지 않는다 — 임계값을 하나라도 두면 그 선을 넘었다는 사실이 판정으로 읽힌다.
 * pct 가 숫자가 아니면 null → 배경을 칠하지 않는다.
 */
export function heatColor(pct) {
  if (!isNum(pct)) return null;
  const a = Math.round((Math.abs(pct - 50) / 50) * MAX_TINT_ALPHA * 1000) / 1000;
  return `rgba(${pct >= 50 ? TINT_WIDE : TINT_TIGHT}, ${a})`;
}

/**
 * YTD 범위 내 위치를 방향어로. 백분율은 그 방향 쪽에서 읽은 값이다
 * (pct 30 → "타이트측 70%" — 타이트 끝에 70% 만큼 가 있다는 뜻).
 * 섹터 간 행은 두 크레딧의 차라 타이트/와이드라는 크레딧 해석이 성립하지 않는다.
 * 거기서는 폭이 늘었나 줄었나만 말할 수 있으므로 확대측/축소측을 쓴다.
 */
function directionText(pct, isCross) {
  const n = Math.round(pct);
  return pct >= 50
    ? `${isCross ? '확대측' : '와이드측'} ${n}%`
    : `${isCross ? '축소측' : '타이트측'} ${100 - n}%`;
}

// ── 행 구성 ──────────────────────────────────────────────────────────────────

/**
 * meta → 세 묶음의 행 정의. 순수 함수(테스트 대상).
 * @returns {{ pinned:Array, cross:Array, rest:Array }}  각 원소 { id, label, sub }
 */
export function buildRows(meta) {
  const bench = meta.benchmark;
  const suffix = '_vs_' + bench;
  const vsKtb = meta.seriesOrder.filter((id) => id.endsWith(suffix));
  const cross = meta.seriesOrder.filter((id) => !id.endsWith(suffix));

  const nameOf = (id) => id.slice(0, -suffix.length);
  const pinnedIds = PINNED.map((n) => n + suffix).filter((id) => vsKtb.includes(id));

  return {
    pinned: pinnedIds.map((id) => ({ id, label: nameOf(id), sub: `vs ${bench}` })),
    cross: cross.map((id) => {
      const [x, y] = id.split('_vs_');
      return { id, label: `${x} − ${y}`, sub: '섹터 간' };
    }),
    rest: vsKtb.filter((id) => !pinnedIds.includes(id))
      .map((id) => ({ id, label: nameOf(id), sub: `vs ${bench}` })),
  };
}

// ── 셀 ───────────────────────────────────────────────────────────────────────

/**
 * 셀 한 칸. opts = { heatmap:boolean, isCross:boolean }.
 * 배경 틴트는 vs-국고 행에서만, 히트맵이 켜져 있고 YTD 위치가 있을 때만 칠한다.
 * 인라인 style 로 넣는 이유는 값이 연속이라 클래스로 표현할 수 없기 때문이다.
 */
export function cellHTML(s, opts = {}) {
  if (!isNum(s.value)) return '<td class="nil" title="관측 없음">—</td>';
  const pct = s.ytdPct;
  const bar = pct == null
    ? '<div class="bar empty" title="YTD 범위 없음"></div>'
    : `<div class="bar"><i style="left:${pct.toFixed(1)}%"></i></div>`;
  const ytdTip = pct == null
    ? `YTD ${range(s.ytd)} (${s.ytd.n}일)`
    : `YTD ${range(s.ytd)} (${s.ytd.n}일) 중 ${directionText(pct, opts.isCross)}`
      + ` · 고점까지 ${fmt(s.ytd.max - s.value)}bp · 저점까지 ${fmt(s.value - s.ytd.min)}bp`;
  const tip = `현재 ${fmt(s.value)}bp · 전일 Δ ${signed(s.delta)} · ${ytdTip} · `
    + `250일 ${range(s.win)} (${s.win.n}일) · z250 ${fmt(s.z, 2)}`;
  const tint = opts.heatmap && !opts.isCross ? heatColor(pct) : null;
  return `<td title="${esc(tip)}"${tint ? ` style="background:${tint}"` : ''}>`
    + `<div class="v">${fmt(s.value)}</div>`
    + `<div class="d">${signed(s.delta)}</div>`
    + bar
    + `<div class="r">${range(s.ytd)}</div>`
    + `<div class="w">250d ${range(s.win)}</div>`
    + `<div class="z">z ${fmt(s.z, 2)}</div>`
    + '</td>';
}

function rowHTML(doc, row, tenors, opts) {
  const cells = tenors.map((t) => {
    const arr = doc.series[row.id] && doc.series[row.id][t];
    return arr ? cellHTML(cellStats(arr, doc.dates), opts) : '<td class="nil" title="해당 만기 없음">—</td>';
  }).join('');
  return `<tr><th><span class="rl">${esc(row.label)}</span><span class="rs">${esc(row.sub)}</span></th>${cells}</tr>`;
}

function groupHTML(doc, title, rows, tenors, opts, attrs = '') {
  if (!rows.length) return '';
  return `<tr class="grp"${attrs}><th colspan="${tenors.length + 1}">${esc(title)}</th></tr>`
    + rows.map((r) => rowHTML(doc, r, tenors, opts)).join('');
}

// ── 상태 ─────────────────────────────────────────────────────────────────────

function loadState() {
  // heatmap 기본 false — 이 화면의 기본형은 무채색이고, 색은 켜서 보는 보조 표시다.
  //   기존 저장값에는 이 필드가 없으므로 자동으로 off 로 열린다(마이그레이션 불필요).
  const st = { allTenors: false, showRest: false, heatmap: false };
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (s && typeof s.allTenors === 'boolean') st.allTenors = s.allTenors;
    if (s && typeof s.showRest === 'boolean') st.showRest = s.showRest;
    if (s && typeof s.heatmap === 'boolean') st.heatmap = s.heatmap;
  } catch { /* noop */ }
  return st;
}
function saveState(st) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(st)); } catch { /* noop */ }
}

// ── init ─────────────────────────────────────────────────────────────────────

export async function initCs1() {
  const statusEl = document.getElementById('cs1-status');
  const appEl = document.getElementById('cs1-app');
  if (!statusEl || !appEl) return;

  let doc;
  try {
    const res = await fetch(DATA_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    doc = await res.json();
  } catch (err) {
    statusEl.className = 'empty';
    statusEl.textContent = `데이터를 불러오지 못했습니다 (${DATA_URL}): ${err.message}. `
      + '로컬 서버로 열어야 합니다(file:// 미지원). 파일이 없으면 node tools/build-cs1.mjs 로 생성하세요.';
    return;
  }

  const meta = doc.meta;
  const rows = buildRows(meta);
  const state = loadState();

  document.getElementById('cs1-asof').textContent = meta.sourceLastDate;
  document.getElementById('cs1-range').textContent = `${meta.firstDate} ~ ${meta.sourceLastDate}`;
  document.getElementById('cs1-count').textContent =
    `${meta.seriesOrder.length}페어 × ${meta.tenors.length}만기 · ${doc.dates.length}영업일`;
  document.getElementById('cs1-bench').textContent = meta.benchmark;

  const body = document.getElementById('cs1-body');
  const head = document.getElementById('cs1-head');
  const restBtn = document.getElementById('cs1-rest');
  const legendEl = document.getElementById('cs1-legend');

  function tenors() {
    return state.allTenors ? meta.tenors : meta.tenors.filter((t) => DEFAULT_TENORS.includes(t));
  }

  function render() {
    const tn = tenors();
    // isCross 는 행 묶음에서 그대로 온다 — 시리즈 id 를 다시 파싱해 판정하지 않는다
    //   (buildRows 가 이미 나눠 놓은 사실을 두 번째 규칙으로 복제하면 둘이 어긋날 수 있다).
    const ktbOpts = { heatmap: state.heatmap, isCross: false };
    const crossOpts = { heatmap: state.heatmap, isCross: true };
    head.innerHTML = '<tr><th class="corner">섹터</th>'
      + tn.map((t) => `<th>${esc(t)}</th>`).join('') + '</tr>';
    body.innerHTML =
      groupHTML(doc, `vs ${meta.benchmark} — 정책·은행·공사`, rows.pinned, tn, ktbOpts)
      + groupHTML(doc, '섹터 간', rows.cross, tn, crossOpts)
      + (state.showRest ? groupHTML(doc, `vs ${meta.benchmark} — 그 외 ${rows.rest.length}개`, rows.rest, tn, ktbOpts) : '');

    document.querySelectorAll('#cs1-tenor button').forEach((b) => {
      b.classList.toggle('active', (b.dataset.tenor === 'all') === state.allTenors);
    });
    document.querySelectorAll('#cs1-heat button').forEach((b) => {
      b.classList.toggle('active', (b.dataset.heat === 'on') === state.heatmap);
    });
    // 범례는 히트맵이 켜졌을 때만 — 꺼진 화면에는 설명할 색이 없다.
    if (legendEl) legendEl.style.display = state.heatmap ? '' : 'none';
    restBtn.textContent = state.showRest
      ? `그 외 ${rows.rest.length}개 접기`
      : `그 외 ${rows.rest.length}개 펼치기 (회사채 등급 사다리 · 카드 · 여전)`;
    restBtn.setAttribute('aria-expanded', String(state.showRest));
  }

  document.getElementById('cs1-tenor').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.allTenors = b.dataset.tenor === 'all';
    saveState(state); render();
  });
  document.getElementById('cs1-heat').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.heatmap = b.dataset.heat === 'on';
    saveState(state); render();
  });
  restBtn.addEventListener('click', () => {
    state.showRest = !state.showRest;
    saveState(state); render();
  });

  statusEl.style.display = 'none';
  appEl.style.display = '';
  render();
}
