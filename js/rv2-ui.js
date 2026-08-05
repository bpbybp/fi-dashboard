// rv2-ui.js — RV-2 호가 랭킹 페이지 컨트롤러 (Phase 3).
//
// 절대 원칙 (RV-1 과 동일):
//  - 클라이언트 온리. 호가 원문은 브라우저 밖으로 나가지 않는다(서버·전송·커밋 없음).
//  - no-build. vanilla ES module. 외부 리소스 0 — RV-2 는 민평 업로드가 없어 SheetJS 도 필요 없다.
//  - localStorage 만 사용(키 rv2-session). 당일 누적, 날짜가 바뀌면 초기화.
//
// ── 저장 규약 (§1.7) — RV-1 과 정반대다 ──────────────────────────────────
//   RV-1 accumulate() 는 동일 키를 **덮어쓴다**. RV-2 는 **append** 한다:
//     instrumentKey (딜러+종목+만기+side) = 호가의 정체성. observations 배열의 소유자.
//     levelKey      (instrumentKey + 레벨) = 같으면 광고 반복, 다르면 레벨 변동.
//   같은 레벨 재게시는 last_seen 만 갱신하고, 레벨이 바뀌면 관측을 하나 더 쌓는다.
//   이 배열이 곧 호가 수명주기 데이터다 — 덮어쓰면 그 정보가 사라진다.
//
// ── 측정만 한다 ─────────────────────────────────────────────────────────
//   이상치는 **색상으로만** 표시한다. "싸다/비싸다/잡을 만하다" 같은 판단 텍스트를 쓰지 않는다.

import { parseRv2, instrumentKey, levelKey } from './rv2-parser.js';
import { buildBuckets, RV2_MIN_BUCKET_SAMPLE, RV2_MAD_K } from './rv2-buckets.js';

const LS_SESSION = 'rv2-session';
const LS_THEME = 'rv2-theme';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 로컬 날짜 키. UTC 로 자르면 한국 시간 오전 9시 이전이 전날로 잡힌다. */
export function todayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── 세션 ─────────────────────────────────────────────────────────────────

let SESSION = newSession();

function newSession() {
  return { dateKey: todayKey(), instruments: {}, demand: [], unclassified: [], stats: null };
}

function saveSession() {
  try { localStorage.setItem(LS_SESSION, JSON.stringify({ kind: LS_SESSION, version: 1, session: SESSION })); }
  catch { /* 용량 초과 등은 무시 — 저장 실패가 화면을 막지 않는다 */ }
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
    if (s && s.session && s.session.dateKey === todayKey()) SESSION = { ...newSession(), ...s.session };
  } catch { SESSION = newSession(); }
}

/**
 * §1.7 누적. **덮어쓰지 않고 append 한다.**
 * @returns {{ added:number, appended:number, repeated:number }}
 *   added    새 호가(instrument 신규)
 *   appended 기존 호가의 레벨 변동 → 관측 추가
 *   repeated 동일 레벨 재게시 → last_seen 만 갱신
 */
export function accumulate(session, quotes) {
  const counts = { added: 0, appended: 0, repeated: 0 };
  for (const q of quotes) {
    const ik = instrumentKey(q);
    const lk = levelKey(q);
    let inst = session.instruments[ik];
    if (!inst) {
      inst = session.instruments[ik] = { key: ik, first_seen: q.timestamp, last_seen: q.timestamp, latest: q, observations: [] };
      inst.observations.push({ levelKey: lk, timestamp: q.timestamp, last_seen: q.timestamp, q });
      counts.added++;
      continue;
    }
    inst.last_seen = q.timestamp;
    inst.latest = q;
    const prev = inst.observations[inst.observations.length - 1];
    if (prev && prev.levelKey === lk) { prev.last_seen = q.timestamp; counts.repeated++; }
    else { inst.observations.push({ levelKey: lk, timestamp: q.timestamp, last_seen: q.timestamp, q }); counts.appended++; }
  }
  return counts;
}

/** 세션의 현재 유효 호가 = instrument 별 최신 관측. */
export function currentQuotes(session) {
  return Object.values(session.instruments).map((i) => i.latest);
}

// ── 렌더 ─────────────────────────────────────────────────────────────────

function renderSessionInfo() {
  const n = Object.keys(SESSION.instruments).length;
  const obs = Object.values(SESSION.instruments).reduce((s, i) => s + i.observations.length, 0);
  $('rv2-session-info').textContent = n
    ? `${SESSION.dateKey} · 호가 ${n}건 · 관측 ${obs}건(레벨 변동 포함)`
    : `${SESSION.dateKey} · 비어 있음`;
}

function render() {
  renderSessionInfo();
  const quotes = currentQuotes(SESSION);
  if (!quotes.length && !SESSION.demand.length && !SESSION.unclassified.length) {
    $('rv2-summary').innerHTML = '<div class="empty">아직 파싱된 호가가 없습니다. 위 입력창에 붙여넣고 [파싱]을 누르세요.</div>';
    $('rv2-ranking').innerHTML = '';
    $('rv2-demand').innerHTML = '';
    $('rv2-unclassified').innerHTML = '';
    return;
  }
  $('rv2-summary').innerHTML = renderSummary(quotes);
  $('rv2-ranking').innerHTML = renderRanking(quotes);
  $('rv2-demand').innerHTML = '';    // Phase 3-3
  $('rv2-unclassified').innerHTML = ''; // Phase 3-3
}

/**
 * 파싱 결과 요약 (§6.2 규약).
 * **오프셋 미상은 랭킹에서 빼되 숨기지 않는다** — 사유별 카운트를 그대로 노출한다.
 * 미상 건수가 크면 그 세션의 랭킹 자체가 대표성이 없다는 신호이므로 사용자가 알아야 한다.
 */
function renderSummary(quotes) {
  const rankable = quotes.filter((q) => q.offset_bp != null && !q.is_cp_cd);
  const missing = quotes.filter((q) => q.offset_bp == null);
  const byBasis = missing.reduce((a, q) => { a[q.offset_basis] = (a[q.offset_basis] || 0) + 1; return a; }, {});
  const LABEL = {
    unknown: '레벨 없음', won_unresolved: '원단위(듀레이션 필요)', no_minpyeong: '민평 앵커 없음',
  };
  const pct = (n) => (quotes.length ? Math.round((n / quotes.length) * 100) : 0);
  const reasons = Object.entries(byBasis).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${esc(LABEL[k] || k)} <b>${v}</b>(${pct(v)}%)`).join(' · ');

  return `<div class="stats">
    <div class="stat"><div class="stat-label">랭킹 가능</div>
      <div class="stat-main">${rankable.length}<span class="stat-unit">건</span></div>
      <div class="stat-sub">전체 호가 ${quotes.length}건의 ${pct(rankable.length)}%</div></div>
    <div class="stat"><div class="stat-label">오프셋 미상</div>
      <div class="stat-main">${missing.length}<span class="stat-unit">건</span></div>
      <div class="stat-sub">랭킹 제외 · 사유는 아래</div></div>
    <div class="stat"><div class="stat-label">CP·CD·전단채</div>
      <div class="stat-main">${quotes.filter((q) => q.is_cp_cd).length}<span class="stat-unit">건</span></div>
      <div class="stat-sub">분류만 · 랭킹 제외</div></div>
    <div class="stat"><div class="stat-label">구간 수요</div>
      <div class="stat-main">${SESSION.demand.length}<span class="stat-unit">건</span></div>
      <div class="stat-sub">사자 패널</div></div>
  </div>
  ${missing.length ? `<div class="footnote" style="margin-top:8px">오프셋 미상 사유: ${reasons}</div>` : ''}`;
}

// ── 버킷 드릴다운 랭킹 ───────────────────────────────────────────────────

const fmt = (x, d = 2) => (x == null ? '—' : x.toFixed(d));
const signed = (x, d = 2) => (x == null ? '—' : (x > 0 ? '+' : '') + x.toFixed(d));

const RATING_LABEL = { explicit: '명시', issuer_mapped: '역매핑', unknown: '미상', not_applicable: '비적용' };

/**
 * 버킷별 접이식 랭킹.
 *
 * 버킷 헤더에 **n · 중앙값 · MAD · 미상 카운트 · rating_basis 분해**를 전부 적는다.
 * n 만 보면 그 버킷의 랭킹이 대표성 있는 줄 오해한다 — 미상이 몇 건인지, 등급이 실제
 * 명시된 것인지 역매핑인지가 같이 보여야 사용자가 신뢰 수준을 스스로 판단한다.
 *
 * 정렬은 **조정오프셋 내림차순**(= 싸게 나온 순). 버킷 중앙값을 뺀 뒤라 시장 베타가 빠진 값이다.
 */
function renderRanking(quotes) {
  const rankable = quotes.filter((q) => q.offset_bp != null && !q.is_cp_cd);
  if (!rankable.length) return '<div class="sec-title">랭킹</div><div class="empty">오프셋이 산출된 호가가 없습니다.</div>';

  const { leaves, rows, session } = buildBuckets(rankable, { todayStr: SESSION.dateKey });
  // 랭킹 제외군(CP·CD·유동화)은 rows 에는 있지만 리프가 없다 — 여기서도 뺀다.
  const ranked = rows.filter((r) => r.adjustedOffset != null);

  const byLeaf = new Map();
  for (const r of ranked) {
    if (!byLeaf.has(r.leaf)) byLeaf.set(r.leaf, []);
    byLeaf.get(r.leaf).push(r);
  }

  const head = `<div class="sec-title">버킷별 랭킹
    <span class="cap">조정오프셋 = 오프셋 − 버킷 중앙값 · 내림차순(민평 대비 높은 수익률이 위)</span></div>
    <div class="footnote" style="margin-bottom:10px">세션 전체 n=<b>${session.n}</b> ·
      중앙값 <b>${signed(session.median)}</b>bp · MAD <b>${fmt(session.mad)}</b> ·
      표본 가드 n&lt;${RV2_MIN_BUCKET_SAMPLE} → 상위 롤업 · 이상치 |Δ|&gt;${RV2_MAD_K}×MAD</div>`;

  const blocks = [...byLeaf.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([leaf, list]) => {
      const b = leaves.get(leaf) || { n: 0, median: null, mad: null, missing: 0 };
      const rb = list.reduce((a, r) => { a[r.rating_basis] = (a[r.rating_basis] || 0) + 1; return a; }, {});
      const rbText = Object.entries(rb).sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `${RATING_LABEL[k] || k} ${v}`).join(' · ');
      const thin = b.n < RV2_MIN_BUCKET_SAMPLE;
      const sorted = [...list].sort((x, y) => y.adjustedOffset - x.adjustedOffset);

      return `<details class="bucket"${byLeaf.size <= 3 ? ' open' : ''}>
        <summary>
          <span class="b-name">${esc(leaf)}</span>
          <span class="b-meta${thin ? ' b-warn' : ''}">n=${b.n}${thin ? ` (가드 미달 · ${esc(sorted[0].medianSource)} 중앙값 사용)` : ''}</span>
          <span class="b-meta">중앙값 ${signed(b.median)}bp · MAD ${fmt(b.mad)}</span>
          <span class="b-meta${b.missing ? ' b-warn' : ''}">오프셋 미상 ${b.missing}</span>
          <span class="b-meta">등급 ${esc(rbText)}</span>
        </summary>
        <div class="b-body">${rankTable(sorted)}</div>
      </details>`;
    }).join('');

  return head + blocks;
}

function rankTable(list) {
  const trs = list.map((r) => {
    const q = r.q;
    const side = q.side === 'bid' ? '<span class="side-bid">사자</span>' : '<span class="side-offer">팔자</span>';
    const status = q.status === 'traded' ? '<span class="badge">체결</span>'
      : q.status === 'matched_market' ? '<span class="badge">대치</span>' : '';
    const ratingCell = q.rating ? esc(q.rating)
      : r.rating ? `${esc(r.rating)}<span class="badge" title="발행사 역매핑">역</span>`
        : r.rating_basis === 'not_applicable' ? '<span class="badge">비적용</span>' : '—';
    return `<tr class="${r.outlier ? 'is-outlier' : ''}">
      <td>${side}${status}</td>
      <td>${esc(q.issuer_raw) || '—'}</td>
      <td class="mono">${esc(q.bond_code) || '—'}</td>
      <td class="mono">${esc(q.maturity_date) || '—'}</td>
      <td class="mono">${esc(r.tenor) || '—'}</td>
      <td>${ratingCell}</td>
      <td class="num">${fmt(q.minpyeong_yield, 3)}</td>
      <td class="num">${signed(q.offset_bp, 1)}</td>
      <td class="num off">${signed(r.adjustedOffset, 1)}</td>
      <td class="mono">${esc(q.offset_basis)}</td>
      <td class="mono">${q.volume ? `${q.volume.total_eok}억` : '—'}</td>
      <td class="mono">${esc(q.broker) || '—'}</td>
    </tr>`;
  }).join('');
  return `<table class="q"><thead><tr>
    <th>방향</th><th>발행사</th><th>종목</th><th>만기</th><th>구간</th><th>등급</th>
    <th class="num">민평%</th><th class="num">오프셋</th><th class="num">조정</th>
    <th>산출근거</th><th>수량</th><th>브로커</th>
  </tr></thead><tbody>${trs}</tbody></table>`;
}

// ── 이벤트 ───────────────────────────────────────────────────────────────

function onParse() {
  const ta = $('rv2-text');
  const text = ta.value;
  if (!text.trim()) return;
  const res = parseRv2(text);
  const c = accumulate(SESSION, res.quotes);
  SESSION.demand.push(...res.demand);
  SESSION.unclassified.push(...res.unclassified);
  SESSION.stats = res.stats;
  saveSession();
  ta.value = '';
  render();
  $('rv2-session-info').textContent =
    `방금: 신규 ${c.added} · 레벨변동 ${c.appended} · 반복 ${c.repeated} — ` + $('rv2-session-info').textContent;
}

function wire() {
  $('rv2-parse').addEventListener('click', onParse);
  $('rv2-clear').addEventListener('click', () => {
    SESSION = newSession();
    try { localStorage.removeItem(LS_SESSION); } catch { /* noop */ }
    render();
  });
  const themeBtn = $('rv2-theme');
  const syncTheme = () => {
    const dark = document.documentElement.dataset.cpTheme === 'dark';
    themeBtn.textContent = dark ? '☀️ 라이트' : '🌙 다크';
  };
  themeBtn.addEventListener('click', () => {
    const dark = document.documentElement.dataset.cpTheme === 'dark';
    document.documentElement.dataset.cpTheme = dark ? 'light' : 'dark';
    try { localStorage.setItem(LS_THEME, dark ? 'light' : 'dark'); } catch { /* noop */ }
    syncTheme();
  });
  syncTheme();
}

export function initRv2() {
  loadSession();
  wire();
  render();
}
