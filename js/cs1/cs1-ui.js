// cs1-ui.js — CS-1 크레딧 섹터 스프레드 모니터 화면.
//
// 용도는 하나다: 발행금리를 보고 "이 레벨이 올해 범위 어디쯤인가"를 즉시 읽는 자(ruler).
//   예) 신한은행 3Y 4.18 발행 → 은행채AAA 행의 3년 칸에서 현재 스프레드와 YTD 범위 내 위치를 본다.
//
// [측정 전용] 시그널·해석·스코어링 텍스트를 넣지 않는다. 색으로 좋다/나쁘다를 말하지 않는다.
//   범위 바에는 현위치 마커만 찍고, 숫자는 전부 무채색으로 둔다. 방향(+/−)은 부호로만 읽는다.
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

function cellHTML(s) {
  if (!isNum(s.value)) return '<td class="nil" title="관측 없음">—</td>';
  const pct = s.ytdPct;
  const bar = pct == null
    ? '<div class="bar empty" title="YTD 범위 없음"></div>'
    : `<div class="bar"><i style="left:${pct.toFixed(1)}%"></i></div>`;
  const tip = `현재 ${fmt(s.value)}bp · 전일 Δ ${signed(s.delta)} · `
    + `YTD ${range(s.ytd)} (${s.ytd.n}일, 현위치 ${pct == null ? '—' : pct.toFixed(0) + '%'}) · `
    + `250일 ${range(s.win)} (${s.win.n}일) · z250 ${fmt(s.z, 2)}`;
  return `<td title="${esc(tip)}">`
    + `<div class="v">${fmt(s.value)}</div>`
    + `<div class="d">${signed(s.delta)}</div>`
    + bar
    + `<div class="r">${range(s.ytd)}</div>`
    + `<div class="w">250d ${range(s.win)}</div>`
    + `<div class="z">z ${fmt(s.z, 2)}</div>`
    + '</td>';
}

function rowHTML(doc, row, tenors) {
  const cells = tenors.map((t) => {
    const arr = doc.series[row.id] && doc.series[row.id][t];
    return arr ? cellHTML(cellStats(arr, doc.dates)) : '<td class="nil" title="해당 만기 없음">—</td>';
  }).join('');
  return `<tr><th><span class="rl">${esc(row.label)}</span><span class="rs">${esc(row.sub)}</span></th>${cells}</tr>`;
}

function groupHTML(doc, title, rows, tenors, attrs = '') {
  if (!rows.length) return '';
  return `<tr class="grp"${attrs}><th colspan="${tenors.length + 1}">${esc(title)}</th></tr>`
    + rows.map((r) => rowHTML(doc, r, tenors)).join('');
}

// ── 상태 ─────────────────────────────────────────────────────────────────────

function loadState() {
  const st = { allTenors: false, showRest: false };
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (s && typeof s.allTenors === 'boolean') st.allTenors = s.allTenors;
    if (s && typeof s.showRest === 'boolean') st.showRest = s.showRest;
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

  function tenors() {
    return state.allTenors ? meta.tenors : meta.tenors.filter((t) => DEFAULT_TENORS.includes(t));
  }

  function render() {
    const tn = tenors();
    head.innerHTML = '<tr><th class="corner">섹터</th>'
      + tn.map((t) => `<th>${esc(t)}</th>`).join('') + '</tr>';
    body.innerHTML =
      groupHTML(doc, `vs ${meta.benchmark} — 정책·은행·공사`, rows.pinned, tn)
      + groupHTML(doc, '섹터 간', rows.cross, tn)
      + (state.showRest ? groupHTML(doc, `vs ${meta.benchmark} — 그 외 ${rows.rest.length}개`, rows.rest, tn) : '');

    document.querySelectorAll('#cs1-tenor button').forEach((b) => {
      b.classList.toggle('active', (b.dataset.tenor === 'all') === state.allTenors);
    });
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
  restBtn.addEventListener('click', () => {
    state.showRest = !state.showRest;
    saveState(state); render();
  });

  statusEl.style.display = 'none';
  appEl.style.display = '';
  render();
}
