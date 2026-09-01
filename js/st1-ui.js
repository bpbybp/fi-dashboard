// st1-ui.js — ST-1 단기물 호가 기록 입력 UI (Phase 2).
//
// ── 파서의 역할이 바뀌었다 ───────────────────────────────────────────────
//   입력은 붙여넣기가 아니라 **사용자 직접 타이핑**이다. 따라서 `js/st1-parser.js` 는
//   "완벽한 추출기"가 아니라 **실시간 입력 보조**다. 파싱이 틀려도 사용자가 프리뷰에서
//   즉시 고칠 수 있으면 된다 — 그래서 이 파일의 설계 기준은 추출 정확도가 아니라
//   **고치기 쉬움**이다.
//
// ── 화면값이 이긴다 ─────────────────────────────────────────────────────
//   기록되는 것은 파싱 결과가 아니라 **프리뷰에 보이는 값**이다. 사용자가 손댄 필드는
//   원문을 다시 편집해도 덮어쓰지 않는다(dirty 추적) — 고친 것이 조용히 되돌아가면
//   "고칠 수 있다"는 전제 자체가 무너진다.
//
// ── 저장 3계층 (Phase 3) ────────────────────────────────────────────────
//   ① data/st1/quotes.json      영구 기록. 로드 시 fetch, **읽기 전용**(파일 편집으로만 바뀐다)
//   ② localStorage 'st1-buffer' **미내보내기분만**. 내보내기 후 비운다
//   ③ 화면 = mergeRows(①, ②)
//
//   요점은 ②가 무한 성장하지 않는다는 것이다. 내보내면 비니까 인위적 한도(slice(-N))가
//   필요 없다 — 한도는 조용한 유실을 만들고, 그건 "기록"이 목적인 모듈에서 최악이다.
//   같은 이유로 **저장 실패는 조용히 넘기지 않는다.** 화면에 경고를 띄운다.
//
// ── 커브 차트 (Phase 5) ─────────────────────────────────────────────────
//   계보별 적합선과 잔차 bp 를 그린다. 적합 산수는 전부 `js/st1-curve.js` 에 있고
//   여기서는 **좌표를 픽셀로 옮기는 일만** 한다.
//
//   ⚠️ 화면에 나가는 것은 **숫자와 좌표뿐**이다. 싸다·비싸다·저평가·타이트 같은 판단은
//   어떤 형태로도 쓰지 않고, 색으로 매수·매도를 암시하지도 않는다. 점 밝기는 오직
//   **경과 시간**을 뜻하며 그래서 단색의 명도만 바꾼다 — 적/녹 색상환을 쓰면 사람은
//   그것을 신호로 읽고, 그 순간 이 모듈은 기록 도구가 아니라 추천 도구가 된다.
//
//   차트는 원장 필터(발행사·종류·등급)와 **무관하다**. 필터는 표를 좁히는 도구고,
//   차트는 자기 컨트롤(기간·반감기·계보 토글)을 따로 갖는다.
//
//   범위 밖: CD·KOFR 대비 스프레드(외부 데이터 의존이 생긴다) · 알림 · 임계값.
//
// ── 구조 ────────────────────────────────────────────────────────────────
//   DOM 접근은 initSt1() 이하에만 둔다. 순수 로직은 export 해 DOM 없이 테스트한다
//   (모듈 최상위에 DOM 접근이 있으면 import 자체가 실패한다 — rv2-ui.js 와 같은 규약).

import {
  parseQuoteLine, normalizeIssuer, dedupeKey, mergeRows, todayLocal,
} from './st1-parser.js';
import {
  buildSeries, residualBp, residualDays, seriesKey,
  SERIES_ORDER, MIN_FIT_POINTS, DEFAULT_MAX_WEEKS, DEFAULT_HALF_LIFE_WEEKS,
} from './st1-curve.js';

// ── 상수 ─────────────────────────────────────────────────────────────────

/** 프리뷰 필드 = 화면에서 고칠 수 있는 6개. 순서가 곧 화면 순서다. */
export const PREVIEW_FIELDS = ['issuer', 'kind', 'grade', 'maturity', 'rate', 'amount'];

/** 종류 선택지 — 파서가 내는 정규화 결과와 같은 어휘여야 필터가 새지 않는다. */
export const KINDS = ['CP', '예담', '전단채', 'ABSTB'];

/** 등급 선택지 — 파서 GRADE_RE 와 같은 어휘. */
export const GRADES = ['A1', 'A2+', 'A2', 'A2-', 'A3+', 'A3', 'A3-', 'B+', 'B', 'B-', 'C', 'D'];

/** 필터에서 "값이 비어 있는 행"을 고르는 특수값. 빈 문자열은 '전체' 라 따로 필요하다. */
export const FILTER_NONE = '__none__';

const EMPTY_PREVIEW = () => ({ issuer: '', kind: '', grade: '', maturity: '', rate: '', amount: '' });

// ── 저장 계층 상수 ───────────────────────────────────────────────────────

/** ① 영구 기록. 읽기 전용 — 화면에서 지울 수 없다. */
export const COMMITTED_URL = 'data/st1/quotes.json';
/** ② 미내보내기 버퍼. */
export const LS_BUFFER = 'st1-buffer';
/** 테마(세션 데이터와 분리 — 봉투 규약은 같다). */
export const LS_THEME = 'st1-theme';
/** ③ 차트 컨트롤 상태. 기록이 아니라 **보기 설정**이라 유실돼도 무해하다(테마와 같은 급). */
export const LS_VIEW = 'st1-view';
export const ENVELOPE_VERSION = 1;
export const EXPORT_KIND = 'st1-export';

// ── 봉투 (레포 관례: { kind, version, ... }) ─────────────────────────────

/**
 * 봉투에서 rows 를 꺼낸다. **kind·version 이 다르면 빈 배열**이다.
 * 남의 키를 잘못 읽거나 구버전 구조를 그대로 믿는 쪽이, 못 읽는 쪽보다 위험하다.
 */
export function readEnvelope(raw, kind = LS_BUFFER, version = ENVELOPE_VERSION) {
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!s || s.kind !== kind || s.version !== version || !Array.isArray(s.rows)) return [];
    return s.rows;
  } catch { return []; }
}

/** 버퍼 저장 봉투. */
export function bufferEnvelope(rows) {
  return { kind: LS_BUFFER, version: ENVELOPE_VERSION, rows: Array.isArray(rows) ? rows : [] };
}

/** 내보내기 payload. tools/st1-merge.mjs 가 읽는 형식과 같아야 한다. */
export function exportPayload(rows) {
  return { kind: EXPORT_KIND, version: ENVELOPE_VERSION, rows: Array.isArray(rows) ? rows : [] };
}

/** 내보내기 파일명 — 오늘 날짜(로컬). */
export function exportFilename(date = todayLocal()) {
  return `st1-${date}.json`;
}

/** quotes.json 의 rows. 형식이 어긋나면 빈 배열(첫 배포 시점의 404 와 같은 취급). */
export function readCommitted(json) {
  return json && Array.isArray(json.rows) ? json.rows : [];
}

// ── 차트 보기 설정 (Phase 5) ─────────────────────────────────────────────

/** 표시 기간 선택지(주). null = 전체 기간. */
export const VIEW_WEEKS = [4, 8, null];
/** 반감기 선택지(주). null = 가중없음. */
export const VIEW_HALF_LIVES = [1, 2, 4, null];

/** 기본 보기 — 8주 창 · 반감기 2주 · 계보 전부 표시. */
export const DEFAULT_VIEW = () => ({
  maxWeeks: DEFAULT_MAX_WEEKS, halfLifeWeeks: DEFAULT_HALF_LIFE_WEEKS, hidden: [],
});

/**
 * 저장된 보기 설정 읽기. 봉투 규약은 버퍼·테마와 같다(kind·version 이 다르면 무시).
 *
 * 값은 **선택지 안에 있는지까지** 확인한다. 저장된 뒤 선택지가 바뀌면 select 에 없는
 * 값이 남아 컨트롤이 빈 채로 뜨고, 사용자는 무엇이 적용됐는지 알 수 없게 된다.
 */
export function readView(raw) {
  const d = DEFAULT_VIEW();
  try {
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!s || s.kind !== LS_VIEW || s.version !== ENVELOPE_VERSION || !s.view) return d;
    const v = s.view;
    return {
      maxWeeks: VIEW_WEEKS.includes(v.maxWeeks) ? v.maxWeeks : d.maxWeeks,
      halfLifeWeeks: VIEW_HALF_LIVES.includes(v.halfLifeWeeks) ? v.halfLifeWeeks : d.halfLifeWeeks,
      hidden: Array.isArray(v.hidden) ? v.hidden.filter((k) => SERIES_ORDER.includes(k)) : d.hidden,
    };
  } catch { return d; }
}

/** 보기 설정 봉투. */
export function viewEnvelope(view) {
  const v = view || DEFAULT_VIEW();
  return {
    kind: LS_VIEW,
    version: ENVELOPE_VERSION,
    view: {
      maxWeeks: v.maxWeeks ?? null,
      halfLifeWeeks: v.halfLifeWeeks ?? null,
      hidden: Array.isArray(v.hidden) ? [...v.hidden] : [],
    },
  };
}

// ── 순수 로직 (DOM 없음 · 테스트 대상) ───────────────────────────────────

/** 숫자 입력 정리. 사용자가 "3.70%" · "100억" 을 그대로 두어도 읽는다. */
function numOrNull(v) {
  const t = String(v ?? '').trim().replace(/[%억]\s*$/, '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * 만기 입력 필드 → { maturity_ym, maturity_date }.
 * **파서를 그대로 재사용한다** — 만기 문법의 단일 근원을 UI 가 따로 갖지 않기 위함이다.
 * (`26.11.20` · `2026-11` · `27/3` · `27년 3월` 모두 파서가 이미 아는 형태다.)
 */
export function parseMaturityField(text) {
  const t = String(text ?? '').trim();
  if (!t) return { maturity_ym: null, maturity_date: null };
  const r = parseQuoteLine(t);
  return { maturity_ym: r.maturity_ym, maturity_date: r.maturity_date };
}

/** 파싱 결과 → 프리뷰 값(전부 문자열). 만기는 정확일자가 있으면 그쪽을 보여준다. */
export function previewFromParsed(p) {
  if (!p) return EMPTY_PREVIEW();
  return {
    issuer: p.issuer ?? '',
    kind: p.kind ?? '',
    grade: p.grade ?? '',
    maturity: p.maturity_date ?? p.maturity_ym ?? '',
    rate: p.rate == null ? '' : String(p.rate),
    amount: p.amount == null ? '' : String(p.amount),
  };
}

/**
 * 재파싱 결과를 프리뷰에 얹되 **사용자가 손댄 필드는 지킨다.**
 * @param {object} next    새 파싱 결과의 프리뷰
 * @param {object} current 화면의 현재 값
 * @param {object} dirty   { 필드명: true } — 사용자가 직접 고친 필드
 */
export function mergePreview(next, current = {}, dirty = {}) {
  const out = {};
  for (const k of PREVIEW_FIELDS) out[k] = dirty[k] ? (current[k] ?? '') : (next?.[k] ?? '');
  return out;
}

/**
 * 프리뷰 값 → 기록 행. **파싱값이 아니라 화면값으로 만든다.**
 *
 * 등급은 대문자로 접는다. 값을 바꾸는 것이 아니라 표기를 고정하는 것으로,
 * 안 하면 `a1` 과 `A1` 이 dedupeKey 상 다른 행이 되어 원장이 갈라진다.
 * flags 는 파싱 시점이 아니라 **최종 저장값 기준**으로 다시 센다.
 *
 * @param {object} preview PREVIEW_FIELDS 값들(문자열)
 * @param {{date?:string, raw?:string, source?:string}} meta
 */
export function rowFromPreview(preview = {}, meta = {}) {
  const issuerRaw = String(preview.issuer ?? '').trim() || null;
  const { maturity_ym, maturity_date } = parseMaturityField(preview.maturity);
  const rate = numOrNull(preview.rate);
  const amount = numOrNull(preview.amount);
  const kind = String(preview.kind ?? '').trim() || null;
  const gradeRaw = String(preview.grade ?? '').trim();

  const flags = [];
  if (rate == null) flags.push('no_rate');
  if (maturity_ym == null) flags.push('no_maturity');
  if (issuerRaw == null) flags.push('no_issuer');

  return {
    date: meta.date || todayLocal(),
    issuer: normalizeIssuer(issuerRaw),
    issuer_raw: issuerRaw,
    kind,
    grade: gradeRaw ? gradeRaw.toUpperCase() : null,
    maturity_ym,
    maturity_date,
    rate,
    amount,
    source: meta.source ?? null,
    raw: typeof meta.raw === 'string' ? meta.raw : '',
    flags,
  };
}

/**
 * 원장에 1건 추가. dedupeKey 중복이면 넣지 않는다.
 * 병합 자체는 파서의 `mergeRows` 를 재사용한다(중복 규약의 단일 근원).
 * @returns {{ rows: object[], added: boolean, key: string }}
 */
export function appendRow(rows, row) {
  const out = mergeRows(rows, [row]);
  return { rows: out.rows, added: out.added === 1, key: dedupeKey(row) };
}

/** dedupeKey 로 1건 삭제. 원장 안에서 키는 유일하다(중복은 애초에 안 들어간다). */
export function removeByKey(rows, key) {
  return (Array.isArray(rows) ? rows : []).filter((r) => dedupeKey(r) !== key);
}

/**
 * 잔존개월 — **렌더 시 계산한다. 저장하지 않는다.**
 *
 * 월 단위가 기본이다(만기 입력이 연-월인 경우가 많다). 정확일자를 알 때만
 * 일 비교로 한 달을 깎는다 — 기준 8/31, 만기 9/1 을 "1개월"로 읽으면 곤란하다.
 * @returns {number|null} 개월수(과거 만기면 음수)
 */
export function monthsRemaining(baseDate, maturityYm, maturityDate = null) {
  const bm = String(baseDate ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const mm = String(maturityYm ?? '').match(/^(\d{4})-(\d{2})$/);
  if (!bm || !mm) return null;
  let months = (Number(mm[1]) - Number(bm[1])) * 12 + (Number(mm[2]) - Number(bm[2]));
  const md = String(maturityDate ?? '').match(/^\d{4}-\d{2}-(\d{2})$/);
  if (md && Number(md[1]) < Number(bm[3])) months -= 1;
  return months;
}

/** 원장의 고유 발행사 — 가나다순. 자동완성과 표기 분기 확인의 입력. */
export function uniqueIssuers(rows) {
  const set = new Set((Array.isArray(rows) ? rows : []).map((r) => r && r.issuer).filter(Boolean));
  return [...set].sort((a, b) => a.localeCompare(b, 'ko'));
}

/** 접두사 매칭 자동완성 후보. prefix 가 비면 전체를 준다. */
export function issuerSuggestions(rows, prefix, limit = 20) {
  const p = String(prefix ?? '').trim().toLowerCase();
  const all = uniqueIssuers(rows);
  const hit = p ? all.filter((s) => s.toLowerCase().startsWith(p)) : all;
  return hit.slice(0, limit);
}

/**
 * 표시 필터. Phase 2 는 발행사·종류·등급 3개뿐이다.
 * 발행사는 부분일치(타이핑 중에도 걸리게), 종류·등급은 완전일치.
 * 빈 값 = 전체, FILTER_NONE = 해당 필드가 비어 있는 행만.
 */
export function applyFilters(rows, f = {}) {
  const issuer = String(f.issuer ?? '').trim().toLowerCase();
  const kind = f.kind ?? '';
  const grade = f.grade ?? '';
  const match = (want, got) => {
    if (!want) return true;
    if (want === FILTER_NONE) return got == null || got === '';
    return got === want;
  };
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r) return false;
    if (issuer && !String(r.issuer ?? '').toLowerCase().includes(issuer)) return false;
    if (!match(kind, r.kind)) return false;
    if (!match(grade, r.grade)) return false;
    return true;
  });
}

// ── DOM (여기서부터 브라우저 전용) ───────────────────────────────────────

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** ① 확정분(quotes.json). 화면에서 지울 수 없다. */
let COMMITTED = [];
/** ② 미내보내기분(localStorage). 지우기·내보내기 대상은 여기뿐이다. */
let BUFFER = [];
/** 확정분 키 집합 — 삭제 버튼 비활성 판정에 쓴다. */
let COMMITTED_KEYS = new Set();
let PREVIEW = EMPTY_PREVIEW();
let DIRTY = {};
/** 차트 컨트롤 상태. */
let VIEW = DEFAULT_VIEW();
/** 마지막 렌더의 계보별 { points, fit }. 프리뷰 잔차가 차트와 같은 적합을 쓰게 하는 캐시다. */
let CURVES = {};

/** 화면 원장 = ① + ②. 중복 판정도 이 합집합 기준이다. */
const allRows = () => mergeRows(COMMITTED, BUFFER).rows;

/** 확정분 로드. **404 는 정상**이다(첫 배포 시점엔 파일이 없을 수 있다). */
async function loadCommitted() {
  try {
    const res = await fetch(COMMITTED_URL, { cache: 'no-cache' });
    if (!res || !res.ok) return [];
    return readCommitted(await res.json());
  } catch { return []; }
}

function loadBuffer() {
  try { return readEnvelope(localStorage.getItem(LS_BUFFER)); } catch { return []; }
}

/** @returns {boolean} 저장 성공 여부. 실패를 숨기지 않는다 — 호출부가 경고를 띄운다. */
function saveBuffer() {
  try { localStorage.setItem(LS_BUFFER, JSON.stringify(bufferEnvelope(BUFFER))); return true; }
  catch { return false; }
}

export async function initSt1() {
  const lineEl = $('st1-line');
  const dateEl = $('st1-date');
  dateEl.value = todayLocal();

  // 프리뷰 입력들 — 사용자가 고치면 dirty 로 잠근다(재파싱이 덮지 않도록).
  for (const k of PREVIEW_FIELDS) {
    const el = $(`st1-f-${k}`);
    el.addEventListener('input', () => {
      DIRTY[k] = true;
      PREVIEW[k] = el.value;
      paintEmptyState();
      if (k === 'issuer') refreshIssuerList(el.value);
      renderChart(); // 미확정 마커·잔차는 필드를 고칠 때마다 따라와야 한다
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); record(); } });
  }

  // 원문 입력 — 칠 때마다 재파싱해 프리뷰를 채운다(손댄 필드는 지킨다).
  lineEl.addEventListener('input', () => {
    const parsed = parseQuoteLine(lineEl.value, { date: dateEl.value });
    PREVIEW = mergePreview(previewFromParsed(parsed), PREVIEW, DIRTY);
    paintPreview();
  });
  lineEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); record(); } });

  $('st1-record').addEventListener('click', record);
  $('st1-reset-preview').addEventListener('click', () => { clearInput(); });
  $('st1-export').addEventListener('click', exportBuffer);

  for (const id of ['st1-fl-issuer', 'st1-fl-kind', 'st1-fl-grade']) {
    $(id).addEventListener('input', renderLedger);
    $(id).addEventListener('change', renderLedger);
  }
  $('st1-theme').addEventListener('click', toggleTheme);

  fillSelect($('st1-f-kind-list'), KINDS);
  fillSelect($('st1-f-grade-list'), GRADES);
  fillFilterSelect($('st1-fl-kind'), KINDS, '종류 전체');
  fillFilterSelect($('st1-fl-grade'), GRADES, '등급 전체');

  initChartControls(); // paintPreview·renderLedger 가 renderChart 를 부르므로 그보다 먼저다
  applyStoredTheme();
  paintPreview();
  renderLedger();
  lineEl.focus();

  // 확정분은 네트워크라 뒤늦게 온다 — 먼저 그리고 도착하면 다시 그린다.
  BUFFER = loadBuffer();
  COMMITTED = await loadCommitted();
  COMMITTED_KEYS = new Set(COMMITTED.map(dedupeKey));
  renderLedger();
  if (BUFFER.length) notify(`미내보내기 ${BUFFER.length}건을 복원했습니다.`);
}

/** datalist 채우기 — 외부 의존 없이 브라우저 기본 자동완성만 쓴다. */
function fillSelect(listEl, values) {
  listEl.innerHTML = values.map((v) => `<option value="${esc(v)}"></option>`).join('');
}

function fillFilterSelect(selEl, values, allLabel) {
  selEl.innerHTML = [`<option value="">${esc(allLabel)}</option>`]
    .concat(values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`))
    .concat([`<option value="${FILTER_NONE}">(없음)</option>`])
    .join('');
}

function refreshIssuerList(prefix) {
  $('st1-issuer-list').innerHTML = issuerSuggestions(allRows(), prefix)
    .map((v) => `<option value="${esc(v)}"></option>`).join('');
}

/** 비어 있는 필드는 회색으로 구분한다 — 판단 색상이 아니라 "아직 안 채워졌다"는 표시다. */
function paintEmptyState() {
  for (const k of PREVIEW_FIELDS) {
    $(`st1-f-${k}`).classList.toggle('is-empty', String(PREVIEW[k] ?? '').trim() === '');
  }
}

function paintPreview() {
  for (const k of PREVIEW_FIELDS) $(`st1-f-${k}`).value = PREVIEW[k] ?? '';
  paintEmptyState();
  refreshIssuerList(PREVIEW.issuer);
  renderChart();
}

function notify(msg, tone = '') {
  const el = $('st1-notice');
  el.textContent = msg;
  el.className = `notice ${tone}`;
}

function record() {
  const lineEl = $('st1-line');
  const row = rowFromPreview(PREVIEW, { date: $('st1-date').value, raw: lineEl.value });
  // 중복 판정은 확정분 + 버퍼 **합집합** 기준. 버퍼만 보면 이미 커밋된 호가가 다시 쌓인다.
  if (!appendRow(allRows(), row).added) {
    notify('이미 기록된 호가입니다 — 같은 일자·발행사·종류·등급·만기·금리.', 'warn');
    return;
  }
  BUFFER = appendRow(BUFFER, row).rows;
  const saved = saveBuffer();
  const missing = row.flags.length ? ` (미기입: ${row.flags.join(', ')})` : '';
  if (saved) {
    notify(`기록 ${allRows().length}건${missing}`);
  } else {
    // 조용한 유실이 최악이다 — 화면에 남고, 왜 위험한지까지 말한다.
    notify(`⚠ 저장 실패 — 화면에는 남았지만 새로고침하면 사라집니다. 지금 내보내기로 파일에 받아두세요.${missing}`, 'warn');
  }
  clearInput();
  renderLedger();
}

/**
 * 버퍼만 JSON 으로 내보낸다(확정분은 이미 파일에 있다).
 * 다운로드가 끝난 뒤 **확인을 받고** 비운다 — 실수로 날리면 복구할 수 없다.
 * 다운로드 자체는 js/onoff-admin-ui.js:99-105 패턴 클론(원본 무수정).
 */
function exportBuffer() {
  if (!BUFFER.length) return;
  const name = exportFilename();
  const text = `${JSON.stringify(exportPayload(BUFFER), null, 2)}\n`;
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);

  const n = BUFFER.length;
  if (!confirm(`${name} 을(를) 받았습니다.\n\n미내보내기 ${n}건을 비울까요?\n파일을 실제로 저장했는지 먼저 확인하세요 — 비우면 복구할 수 없습니다.`)) {
    notify(`내보내기 ${name} — 버퍼는 그대로 ${n}건 남겨두었습니다.`);
    return;
  }
  BUFFER = [];
  const saved = saveBuffer();
  notify(saved
    ? `내보내기 ${name} — 버퍼 ${n}건을 비웠습니다. tools/st1-merge.mjs 로 data/st1/quotes.json 에 병합하세요.`
    : `⚠ 내보내기 ${name} — 버퍼를 비웠으나 저장에 실패했습니다. 새로고침 전 확인하세요.`,
  saved ? '' : 'warn');
  renderLedger();
}

/** 연속 입력이 기본 워크플로다 — 비우고 포커스는 원문 입력에 남긴다. */
function clearInput() {
  $('st1-line').value = '';
  PREVIEW = EMPTY_PREVIEW();
  DIRTY = {};
  paintPreview();
  $('st1-line').focus();
}

function renderLedger() {
  const rows = allRows();
  const filtered = applyFilters(rows, {
    issuer: $('st1-fl-issuer').value,
    kind: $('st1-fl-kind').value,
    grade: $('st1-fl-grade').value,
  });
  $('st1-count').textContent = filtered.length === rows.length
    ? `${rows.length}건`
    : `${filtered.length} / ${rows.length}건`;
  $('st1-status').textContent =
    `기록 ${rows.length}건 (확정 ${COMMITTED.length} / 미내보내기 ${BUFFER.length})`;
  $('st1-export').disabled = BUFFER.length === 0;

  // 차트는 표 필터를 따르지 않지만 **원장 자체가 바뀌면** 다시 그려야 한다.
  // 아래 빈 원장 조기반환보다 먼저 부른다 — 표가 비어도 차트는 그려질 수 있다(필터 때문에).
  renderChart();

  const body = $('st1-tbody');
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="10" class="empty">${rows.length ? '필터에 걸리는 행이 없습니다.' : '아직 기록이 없습니다.'}</td></tr>`;
    return;
  }
  // 최신이 위. 원장 배열은 append 순서라 표시만 뒤집는다.
  body.innerHTML = [...filtered].reverse().map((r) => {
    const m = monthsRemaining(r.date, r.maturity_ym, r.maturity_date);
    const key = dedupeKey(r);
    const locked = COMMITTED_KEYS.has(key); // 확정분은 파일 편집으로만 지운다
    const cell = (v, cls = '') => `<td class="${cls}">${v == null || v === '' ? '<span class="na">—</span>' : esc(v)}</td>`;
    const del = locked
      ? `<button class="btn btn-x" type="button" disabled title="확정 기록입니다 — ${COMMITTED_URL} 편집으로만 지울 수 있습니다">삭제</button>`
      : `<button class="btn btn-x" type="button" data-key="${esc(key)}">삭제</button>`;
    return `<tr${locked ? ' class="is-committed"' : ''}>
      ${cell(r.date, 'mono')}
      ${cell(r.issuer)}
      ${cell(r.kind)}
      ${cell(r.grade, 'mono')}
      ${cell(r.maturity_date || r.maturity_ym, 'mono')}
      ${cell(m == null ? null : `${m}M`, 'num')}
      ${cell(r.rate == null ? null : r.rate.toFixed(2), 'num')}
      ${cell(r.amount == null ? null : r.amount, 'num')}
      <td class="raw" title="${esc(r.raw)}">${esc(r.raw)}</td>
      <td class="num">${del}</td>
    </tr>`;
  }).join('');

  for (const b of body.querySelectorAll('button[data-key]')) {
    b.addEventListener('click', () => {
      BUFFER = removeByKey(BUFFER, b.dataset.key); // 버퍼 행만 지워진다
      const saved = saveBuffer();
      notify(saved ? `삭제 — 남은 ${allRows().length}건`
        : '⚠ 삭제했으나 저장에 실패했습니다 — 새로고침하면 되살아납니다.', saved ? '' : 'warn');
      renderLedger();
    });
  }
}

// ── 커브 차트 (Phase 5) ──────────────────────────────────────────────────
//
// SVG 를 문자열로 짓는다. 외부 차트 라이브러리는 쓰지 않는다 — no-build 레포라
// 번들러가 없고, 산점도 하나에 의존성을 들이면 페이지가 CDN 사정에 묶인다.

/** 좌표계는 viewBox 로 고정하고 CSS 로 폭을 늘린다. 반응형이 공짜로 따라온다. */
const SVG_W = 900;
const SVG_H = 250;
const PLOT = { x0: 56, x1: SVG_W - 18, y0: 16, y1: SVG_H - 34 };
/** 적합선·밴드를 몇 조각으로 끊어 그릴지. ln 곡선이라 직선 조각으로도 48개면 매끈하다. */
const FIT_SAMPLES = 48;

/**
 * 경과 주수 → 점 불투명도. 0주 최대 → 4주 이상 최저 고정, 등간격.
 *
 * ⚠️ 여기서 색상(hue)을 건드리면 안 된다. 밝기는 **시간**을 뜻하는데 적/녹을 쓰는 순간
 * 사람은 그것을 매수·매도로 읽는다. 단색 명도만 바꾼다.
 */
const AGE_ALPHA = [1, 0.82, 0.64, 0.46, 0.28];
const alphaForAge = (age) => AGE_ALPHA[Math.min(AGE_ALPHA.length - 1, Math.max(0, Math.floor(Number(age) || 0)))];

/** 잔차 표기 — 부호를 항상 붙인다. 숫자만 낸다(판단어 없음). */
const fmtBp = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}bp`;
const n1 = (v) => Number(v).toFixed(1);

/** 선형 스케일. 도메인 폭이 0이면(점이 한 자리에 겹치면) 화면 가운데로 접는다. */
function scale(lo, hi, a, b) {
  const span = hi - lo;
  if (!(span > 0)) return () => (a + b) / 2;
  return (v) => a + ((v - lo) / span) * (b - a);
}

/** 1·2·5·10 배수 눈금. 축 라벨이 3.4732 처럼 나오면 읽히지 않는다. */
function niceTicks(lo, hi, want = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const k = raw / mag;
  const step = (k < 1.5 ? 1 : k < 3 ? 2 : k < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

/** 툴팁 한 줄 묶음. 속성값에 개행을 넣지 않으려고 `|` 로 잇고 표시할 때 되돌린다. */
function tipText(row, fit) {
  const bp = residualBp(row, fit);
  return [
    row.date ?? '—',
    row.issuer || row.issuer_raw || '—',
    row.maturity_date || row.maturity_ym || '—',
    row.rate == null ? '—' : `${Number(row.rate).toFixed(2)}%`,
    bp == null ? '잔차 —' : `잔차 ${fmtBp(bp)}`,
  ].join('|');
}

/** 계보 한 개의 SVG. 점이 MIN_FIT_POINTS 이상일 때만 호출된다. */
function chartSvg(key, series, pending) {
  const { points, fit } = series;

  // x 도메인 — 잔존일수. 프리뷰 마커가 화면 밖으로 나가지 않게 함께 넣는다.
  const taus = points.map((p) => p.tau);
  if (pending) taus.push(pending.tau);
  let xLo = Math.min(...taus);
  let xHi = Math.max(...taus);
  const xPad = Math.max(5, (xHi - xLo) * 0.08);
  xLo = Math.max(1, xLo - xPad); // ln 정의역 밖으로 나가지 않는다
  xHi += xPad;

  // y 도메인 — 점 + 밴드 상하단. 밴드를 빼면 ±1σ 가 잘려 나간다.
  const ys = points.map((p) => p.rate);
  if (pending) ys.push(pending.rate);
  const band = [];
  if (fit.ok) {
    for (let i = 0; i <= FIT_SAMPLES; i++) {
      const t = xLo + ((xHi - xLo) * i) / FIT_SAMPLES;
      const m = fit.predict(t);
      if (m == null) continue;
      band.push([t, m, m + fit.sigma, m - fit.sigma]);
      ys.push(m + fit.sigma, m - fit.sigma);
    }
  }
  let yLo = Math.min(...ys);
  let yHi = Math.max(...ys);
  const yPad = Math.max(0.02, (yHi - yLo) * 0.12);
  yLo -= yPad; yHi += yPad;

  const sx = scale(xLo, xHi, PLOT.x0, PLOT.x1);
  const sy = scale(yLo, yHi, PLOT.y1, PLOT.y0); // 화면 y 는 아래가 크다

  const xt = niceTicks(xLo, xHi, 5).filter((v) => v >= xLo && v <= xHi);
  const yt = niceTicks(yLo, yHi, 4).filter((v) => v >= yLo && v <= yHi);

  const grid = [
    ...yt.map((v) => `<line class="grid" x1="${PLOT.x0}" y1="${n1(sy(v))}" x2="${PLOT.x1}" y2="${n1(sy(v))}"/>`),
    ...xt.map((v) => `<line class="grid" x1="${n1(sx(v))}" y1="${PLOT.y0}" x2="${n1(sx(v))}" y2="${PLOT.y1}"/>`),
  ].join('');

  const axis = [
    ...yt.map((v) => `<text class="ax" x="${PLOT.x0 - 8}" y="${n1(sy(v) + 3.5)}" text-anchor="end">${v.toFixed(2)}</text>`),
    ...xt.map((v) => `<text class="ax" x="${n1(sx(v))}" y="${PLOT.y1 + 16}" text-anchor="middle">${Math.round(v)}</text>`),
    `<text class="ax lab" x="${PLOT.x1}" y="${PLOT.y1 + 29}" text-anchor="end">잔존일수 (기록 시점)</text>`,
    `<text class="ax lab" x="${PLOT.x0 - 8}" y="${PLOT.y0 - 3}" text-anchor="end">%</text>`,
  ].join('');

  let model = '';
  if (band.length) {
    const up = band.map(([t, , u]) => `${n1(sx(t))},${n1(sy(u))}`);
    const dn = band.map(([t, , , d]) => `${n1(sx(t))},${n1(sy(d))}`).reverse();
    const mid = band.map(([t, m]) => `${n1(sx(t))},${n1(sy(m))}`);
    model = `<g class="fit"><polygon class="band" points="${up.concat(dn).join(' ')}"/>`
      + `<polyline class="line" points="${mid.join(' ')}"/></g>`;
  }

  const dots = points.map((p) => {
    const tip = tipText(p.row || {}, fit);
    return `<circle class="dot" cx="${n1(sx(p.tau))}" cy="${n1(sy(p.rate))}" r="4"`
      + ` fill-opacity="${alphaForAge(p.weekAge)}" data-tip="${esc(tip)}">`
      + `<title>${esc(tip.split('|').join(' · '))}</title></circle>`;
  }).join('');

  // 미확정 마커 — 속 빈 원. 아직 기록되지 않은 값이라는 뜻이고, 그 이상은 아니다.
  const mark = pending
    ? `<circle class="pending" cx="${n1(sx(pending.tau))}" cy="${n1(sy(pending.rate))}" r="5.5"><title>미확정 (입력 중)</title></circle>`
    : '';

  return `<svg class="st1-chart" viewBox="0 0 ${SVG_W} ${SVG_H}" preserveAspectRatio="xMidYMid meet"`
    + ` role="img" aria-label="${esc(key)} 잔존일수 대비 금리 산점도">`
    + `${grid}`
    + `<line class="axis-line" x1="${PLOT.x0}" y1="${PLOT.y1}" x2="${PLOT.x1}" y2="${PLOT.y1}"/>`
    + `<line class="axis-line" x1="${PLOT.x0}" y1="${PLOT.y0}" x2="${PLOT.x0}" y2="${PLOT.y1}"/>`
    + `${model}${dots}${mark}${axis}</svg>`;
}

/** 계보 블록 — 제목줄 + (점이 충분하면) 차트. */
function seriesBlock(key, series, pending) {
  const n = series.points.length;
  const enough = n >= MIN_FIT_POINTS;
  // 점이 충분해도 잔존일수가 한 자리에 몰리면 fit.ok 가 false 다 — 점은 그리되 선은 긋지 않는다.
  const meta = enough && series.fit.ok
    ? `n=${series.fit.n} · σ ${n1(series.fit.sigma * 100)}bp`
    : `유효 관측 ${n}개 — 적합선 없음`;
  const head = `<div class="chart-head"><span class="cname">${esc(key)}</span>`
    + `<span class="cmeta">${esc(meta)}</span></div>`;
  return `<div class="chart-block">${head}${enough ? chartSvg(key, series, pending) : ''}</div>`;
}

/** 프리뷰가 좌표를 만들 수 있으면 그 행을, 아니면 null. */
function pendingRow() {
  const dateEl = $('st1-date');
  const row = rowFromPreview(PREVIEW, { date: dateEl ? dateEl.value : undefined, raw: '' });
  return row.rate != null && residualDays(row) != null ? row : null;
}

function paintResidual(pending, key) {
  const el = $('st1-resid');
  if (!el) return;
  if (!pending) { el.textContent = ''; return; }
  const series = CURVES[key];
  const bp = residualBp(pending, series && series.fit);
  el.textContent = bp == null ? `${key} · 적합선 없음` : `${key} · 적합선 대비 ${fmtBp(bp)}`;
}

function renderChart() {
  const host = $('st1-charts');
  if (!host) return;
  hideTip();

  // 원장 필터와 무관하게 전체 원장을 쓴다. 창·감쇠는 차트 자기 컨트롤이 정한다.
  CURVES = buildSeries(allRows(), {
    refDate: todayLocal(),
    maxWeeks: VIEW.maxWeeks,
    halfLifeWeeks: VIEW.halfLifeWeeks,
  });

  const pending = pendingRow();
  const pendingKey = pending ? seriesKey(pending) : null;

  const blocks = [];
  for (const key of SERIES_ORDER) {
    if (VIEW.hidden.includes(key)) continue;
    const series = CURVES[key];
    if (!series) continue;
    const mark = pending && pendingKey === key
      ? { tau: residualDays(pending), rate: pending.rate }
      : null;
    blocks.push(seriesBlock(key, series, mark));
  }

  host.innerHTML = blocks.length
    ? blocks.join('')
    : '<div class="empty">그릴 관측이 없습니다 — 만기와 금리가 모두 있는 기록이 필요합니다.</div>';

  paintResidual(pending, pendingKey);
}

function hideTip() {
  const t = $('st1-tip');
  if (t) t.hidden = true;
}

/**
 * 툴팁 — 차트 영역에 위임 리스너 하나. 점마다 붙이면 재렌더마다 전부 다시 달아야 한다.
 * pointer 이벤트라 hover 와 tap 이 같은 경로로 들어온다.
 */
function initTip() {
  const area = $('st1-chart-area');
  const tip = $('st1-tip');
  if (!area || !tip) return;

  const show = (e) => {
    const target = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (!target) { hideTip(); return; }
    tip.textContent = target.getAttribute('data-tip').split('|').join('\n');
    tip.hidden = false;

    // 위치는 영역 기준 상대좌표. 위가 좁으면 아래로 뒤집고, 좌우로는 영역 안에 가둔다.
    const ar = area.getBoundingClientRect();
    const cr = target.getBoundingClientRect();
    const x = Math.max(2, Math.min(cr.left - ar.left + cr.width / 2 - tip.offsetWidth / 2,
      ar.width - tip.offsetWidth - 2));
    const above = cr.top - ar.top - tip.offsetHeight - 8;
    tip.style.left = `${x}px`;
    tip.style.top = `${above < 0 ? cr.bottom - ar.top + 8 : above}px`;
  };

  area.addEventListener('pointerover', show);
  area.addEventListener('pointerdown', show);
  area.addEventListener('pointerleave', hideTip);
}

function loadView() {
  try { return readView(localStorage.getItem(LS_VIEW)); } catch { return DEFAULT_VIEW(); }
}

function saveView() {
  // 보기 설정이라 유실돼도 기록은 멀쩡하다 — 테마와 같이 조용히 넘긴다(버퍼와 다른 지점).
  try { localStorage.setItem(LS_VIEW, JSON.stringify(viewEnvelope(VIEW))); } catch { /* noop */ }
}

function initChartControls() {
  VIEW = loadView();

  const wk = $('st1-cv-weeks');
  const hl = $('st1-cv-half');
  wk.value = VIEW.maxWeeks == null ? 'all' : String(VIEW.maxWeeks);
  hl.value = VIEW.halfLifeWeeks == null ? 'none' : String(VIEW.halfLifeWeeks);
  wk.addEventListener('change', () => {
    VIEW.maxWeeks = wk.value === 'all' ? null : Number(wk.value);
    saveView(); renderChart();
  });
  hl.addEventListener('change', () => {
    VIEW.halfLifeWeeks = hl.value === 'none' ? null : Number(hl.value);
    saveView(); renderChart();
  });

  const box = $('st1-cv-series');
  box.innerHTML = SERIES_ORDER.map((k) => `<label class="tg"><input type="checkbox" data-series="${esc(k)}"`
    + `${VIEW.hidden.includes(k) ? '' : ' checked'}>${esc(k)}</label>`).join('');
  box.addEventListener('change', (e) => {
    const cb = e.target && e.target.closest ? e.target.closest('input[data-series]') : null;
    if (!cb) return;
    const k = cb.dataset.series;
    VIEW.hidden = cb.checked
      ? VIEW.hidden.filter((x) => x !== k)
      : [...new Set([...VIEW.hidden, k])];
    saveView(); renderChart();
  });

  initTip();
}

/** 라이트/다크 전환. 봉투 규약은 버퍼와 같다(키만 다르다). 기본은 라이트. */
function toggleTheme() {
  const d = document.documentElement.dataset;
  const next = d.cpTheme === 'dark' ? 'light' : 'dark';
  d.cpTheme = next;
  paintThemeButton();
  try { localStorage.setItem(LS_THEME, JSON.stringify({ kind: LS_THEME, version: ENVELOPE_VERSION, theme: next })); }
  catch { /* 테마는 부가기능 — 저장 실패가 화면을 막지 않는다(기록과 달리 유실돼도 무해) */ }
}

/** 저장된 테마 적용. HTML head 의 FOUC 스크립트와 같은 키·같은 봉투를 읽는다. */
function applyStoredTheme() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_THEME) || 'null');
    if (s && s.kind === LS_THEME && s.version === ENVELOPE_VERSION && s.theme === 'dark') {
      document.documentElement.dataset.cpTheme = 'dark';
    }
  } catch { /* noop */ }
  paintThemeButton();
}

function paintThemeButton() {
  $('st1-theme').textContent = document.documentElement.dataset.cpTheme === 'dark' ? '☀️ 라이트' : '🌙 다크';
}
