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
import {
  buildBuckets, RV2_MIN_BUCKET_SAMPLE, RV2_MAD_K, RV2_TENOR_GRID,
  RV2_STAT_TENOR_KEYS, statTenorOf,
} from './rv2-buckets.js';

const LS_SESSION = 'rv2-session';
const LS_THEME = 'rv2-theme';
const LS_VIEW = 'rv2-view'; // 표시 옵션(만기 필터 등). 세션 데이터와 분리한다.

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
 *
 * ── 중복 판정 (2026-08-05 개정) ──────────────────────────────────────────
 * 판정 대상은 **관측 이력 전체**의 `timestamp + levelKey` 쌍이다.
 *   같은 시각 · 같은 레벨 → **재붙여넣기**. 스킵한다.
 *   다른 시각 · 같은 레벨 → **레벨 회귀**(A→B→A). 관측을 쌓는다.
 *
 * 이전 구현은 **마지막 관측 하나만** 비교했다. 그래서 A→B 로 변한 호가에 A 가 다시
 * 들어오면 중복 판정에 걸리지 않고 append 돼, 겹치는 창을 재복사할 때마다 관측이
 * 이중 계상됐다(Phase 4 실측: 1,208 → 1,608). 장중 수시 복사가 기본 워크플로이므로
 * **시각을 메시지 식별자로 삼아야** 멱등이 성립한다.
 *
 * 부수 효과: 같은 레벨을 다른 시각에 재게시하는 "광고 반복"도 이제 관측으로 쌓인다.
 * 그것이 곧 호가가 살아 있다는 관측이므로 수명주기 데이터로서 옳다.
 *
 * @returns {{ added:number, appended:number, repeated:number }}
 *   added    새 호가(instrument 신규)
 *   appended 관측 추가(레벨 변동·회귀·재게시)
 *   repeated 같은 시각·같은 레벨 → 재붙여넣기로 보고 스킵
 */
export function accumulate(session, quotes) {
  const counts = { added: 0, appended: 0, repeated: 0 };
  const obsKey = (ts, lk) => `${ts} ${lk}`;
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
    // 이력 전체 조회. 복원된 세션에는 Set 이 없으므로 매번 만든다(호가당 관측 수가 작다).
    const seen = new Set(inst.observations.map((o) => obsKey(o.timestamp, o.levelKey)));
    if (seen.has(obsKey(q.timestamp, lk))) { counts.repeated++; continue; }
    inst.last_seen = q.timestamp;
    inst.latest = q;
    inst.observations.push({ levelKey: lk, timestamp: q.timestamp, last_seen: q.timestamp, q });
    counts.appended++;
  }
  return counts;
}

/** 수요 중복 키 — 딜러 + 시각 + 정규화 원문. 같은 딜러의 시각 다른 동일 수요는 남긴다(수요 지속의 실측). */
export const demandKey = (d) => [
  d.dealer_phone || d.broker || d.trader_name || '',
  d.timestamp || '',
  String(d.raw_line ?? '').replace(/\s+/g, ' ').trim(),
].join(' ');

/** 미분류 중복 키 — 발화자 + 시각 + 원문. */
export const unclassifiedKey = (u) => [
  u.trader_name || '', u.timestamp || '', String(u.raw ?? '').replace(/\s+/g, ' ').trim(),
].join(' ');

/** 키 기준 append. 이미 있는 항목은 버린다 — 재붙여넣기로 카운트가 부풀지 않게. */
export function mergeKeyed(existing, incoming, keyFn) {
  const seen = new Set(existing.map(keyFn));
  let added = 0;
  for (const x of incoming || []) {
    const k = keyFn(x);
    if (seen.has(k)) continue;
    seen.add(k);
    existing.push(x);
    added++;
  }
  return added;
}

/** 세션의 현재 유효 호가 = instrument 별 최신 관측. */
export function currentQuotes(session) {
  return Object.values(session.instruments).map((i) => i.latest);
}

// ── 렌더 ─────────────────────────────────────────────────────────────────

/**
 * 관측 수와 **레벨 변동 수는 다르다.** 관측은 메시지 단위(재게시 포함)이고,
 * 레벨 변동은 서로 다른 levelKey 가 2개 이상인 호가만 센다. 섞어 적으면
 * "레벨이 2,639번 바뀌었다"처럼 읽혀 수명주기를 오해한다.
 */
export function sessionCounts(session) {
  const inst = Object.values(session.instruments || {});
  return {
    quotes: inst.length,
    observations: inst.reduce((s, i) => s + i.observations.length, 0),
    levelChanged: inst.filter((i) => new Set(i.observations.map((o) => o.levelKey)).size > 1).length,
  };
}

function renderSessionInfo() {
  const c = sessionCounts(SESSION);
  $('rv2-session-info').textContent = c.quotes
    ? `${SESSION.dateKey} · 호가 ${c.quotes}건 · 관측 ${c.observations}건 · 레벨 변동 ${c.levelChanged}건`
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
  $('rv2-demand').innerHTML = renderDemand(SESSION.demand);
  $('rv2-unclassified').innerHTML = renderUnclassified(SESSION.unclassified);
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

// ── 만기구간 표시 계층 (v1.1) ────────────────────────────────────────────
//
// **표시만 거른다.** 버킷 중앙값·MAD·이상치 판정·n 은 섹터 리프 **전체** 기준으로 산출되고
// 필터와 무관하게 불변이다. Phase 2 결정("만기는 통계 축이 아니다")을 그대로 유지한다.
// 필터가 켜지면 헤더에 `표시 N / 전체 n` 을 적어 **모집단과 표시 건수를 구분**한다.

/** 만기 미상(B-9 잔여) 그룹 라벨. 격자에 올릴 수 없는 관측을 숨기지 않고 별도 칸으로 둔다. */
export const TENOR_UNKNOWN = '미상';

/** 격자 정의는 rv2-buckets 단일 소스를 재사용한다 — UI 에서 재정의하지 않는다. */
export const TENOR_KEYS = [...RV2_TENOR_GRID.map((g) => g.key), TENOR_UNKNOWN];

/** 관측의 표시용 만기 키. rv2-buckets 가 붙인 tenor 를 그대로 쓰고, 없으면 '미상'. */
export const tenorKeyOf = (r) => r.tenor || TENOR_UNKNOWN;

/** 만기구간별 건수. 0인 구간은 담지 않는다(헤더 미니 카운트가 0을 생략하기 위함). */
export function tenorCounts(rows) {
  const out = {};
  for (const r of rows) {
    const k = tenorKeyOf(r);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** 필터 적용. 빈 집합 = 전체 표시(필터 없음)로 본다. */
export function applyTenorFilter(rows, active) {
  if (!active || !active.size) return rows;
  return rows.filter((r) => active.has(tenorKeyOf(r)));
}

/**
 * 만기구간별 소그룹. **격자 순서**로 돌려주고 '미상'은 항상 마지막이다.
 * 그룹 내 정렬은 조정오프셋 내림차순 — 같은 리프 안에서는 중앙값이 상수라
 * offset_bp 내림차순과 결과가 동일하다(순위 의미론 불변).
 */
export function tenorGroupsOf(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const k = tenorKeyOf(r);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  return TENOR_KEYS
    .filter((k) => byKey.has(k))
    .map((k) => ({ key: k, rows: byKey.get(k).sort((a, b) => b.adjustedOffset - a.adjustedOffset) }));
}

let TENOR_FILTER = new Set();

function loadView() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_VIEW) || 'null');
    if (v && Array.isArray(v.tenors)) TENOR_FILTER = new Set(v.tenors.filter((k) => TENOR_KEYS.includes(k)));
  } catch { TENOR_FILTER = new Set(); }
}
function saveView() {
  try { localStorage.setItem(LS_VIEW, JSON.stringify({ kind: LS_VIEW, version: 1, tenors: [...TENOR_FILTER] })); }
  catch { /* noop */ }
}

function renderTenorChips(allRows) {
  const counts = tenorCounts(allRows);
  const chips = TENOR_KEYS.map((k) => {
    const n = counts[k] || 0;
    const on = TENOR_FILTER.has(k);
    return `<button class="chip${on ? ' on' : ''}${n ? '' : ' zero'}" data-tenor="${esc(k)}" type="button">${esc(k)}<span class="c-n">${n}</span></button>`;
  }).join('');
  const active = TENOR_FILTER.size;
  return `<div class="chips">
    <span class="chips-label">만기구간</span>${chips}
    <button class="chip chip-reset${active ? '' : ' zero'}" data-tenor="__all" type="button">전체</button>
    <span class="chips-note">${active ? '표시만 거릅니다 — 중앙값·MAD·이상치·n 은 리프 전체 기준 불변' : ''}</span>
  </div>`;
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
/**
 * 섹터 → 색상 토큰 (v1.3). 실제 색 값은 rv2-quote-rank.html 의 --sc-* 변수가
 * 라이트/다크 테마별로 갖는다 — JS 는 토큰만 알고 색은 CSS 가 결정한다.
 * 카테고리 구분용 색상일 뿐 판단·시그널이 아니다(측정만 한다).
 * 키 순서 = 범례 표시 순서(정부계 → 은행계 → 여전 → 증권 → 회사채 → 미상).
 */
const SECTOR_COLOR_TOKEN = {
  '국고·통안': 'govt', '지방채': 'muni', '공사·공단': 'agency',
  '특은': 'sbank', '시은-시중계': 'cbank', '시은-비시중계': 'ibank',
  '지방은행': 'rbank', '은행지주': 'bhold',
  '여전-카드': 'card', '여전-캐피탈': 'capital',
  '증권채': 'sec', '회사채': 'corp', '분류미상': 'unk',
};
const SECTOR_LEGEND_ORDER = Object.keys(SECTOR_COLOR_TOKEN);
const sectorVar = (sector) => `var(--sc-${SECTOR_COLOR_TOKEN[sector] || 'unk'})`;

function renderRanking(quotes) {
  const rankable = quotes.filter((q) => q.offset_bp != null && !q.is_cp_cd);
  if (!rankable.length) return '<div class="sec-title">랭킹</div><div class="empty">오프셋이 산출된 호가가 없습니다.</div>';

  const { cells, leaves, rows, session } = buildBuckets(rankable, { todayStr: SESSION.dateKey });
  // 랭킹 제외군(CP·CD·유동화)은 rows 에는 있지만 리프가 없다 — 여기서도 뺀다.
  const ranked = rows.filter((r) => r.adjustedOffset != null);

  // v1.2: 버킷 = **통계 칸**(섹터 리프 × 통계 만기). 만기 미상은 칸이 없어 섹터 리프로 묶는다.
  const byLeaf = new Map();
  for (const r of ranked) {
    const key = r.cell || `${r.leaf} · 만기미상`;
    if (!byLeaf.has(key)) byLeaf.set(key, []);
    byLeaf.get(key).push(r);
  }

  // RV2-b: 중앙값 강조 — bold + 부호색(+빨강/−파랑, 국내 시세 관례).
  //   색은 부호 방향 표시일 뿐 좋다/나쁘다 판단이 아니다(측정만 한다).
  const medianVal = (v) => {
    const cls = v > 0 ? ' pos' : v < 0 ? ' neg' : '';
    return `<b class="mv${cls}">${signed(v)}bp</b>`;
  };

  const head = `<div class="sec-title">버킷별 랭킹
    <span class="cap">조정오프셋 = 오프셋 − 버킷 중앙값 · 내림차순(민평 대비 높은 수익률이 위)</span></div>
    <div class="footnote" style="margin-bottom:4px">오프셋 = 호가 수익률 − 민평(bp, +는 민평보다 높은 금리 = 싸게 나온 물건) ·
      조정 = 오프셋 − 버킷 중앙값(무리의 공통 수준을 뺀 뒤 무리 안에서의 상대 순위) ·
      산출근거 = 오프셋 산출 방식(표 머리글에 마우스를 올리면 상세)</div>
    <div class="footnote" style="margin-bottom:10px">세션 전체 n=<b>${session.n}</b> ·
      중앙값 ${medianVal(session.median)} · MAD <b>${fmt(session.mad)}</b> ·
      표본 가드 n&lt;${RV2_MIN_BUCKET_SAMPLE} → 섹터 롤업 · 통계 격자 ${RV2_STAT_TENOR_KEYS.join("/")} · 이상치 |Δ|&gt;${RV2_MAD_K}×MAD</div>`;

  // v1.3: 섹터 → 버킷 2단 구조. 이전엔 셀 버킷을 크기순으로 평면 나열해 섹터가 뒤섞였다.
  // 섹터 순서는 분류 규칙 순(SECTOR_LEGEND_ORDER)으로 **고정**한다 — 날마다 같은 자리에
  // 있어야 눈이 바로 간다. 섹터 안에서는 리프 → 통계 만기(~1y/1-2/2y+/미상) 순.
  const bySector = new Map();
  for (const entry of byLeaf.entries()) {
    const s = entry[1][0].sector;
    if (!bySector.has(s)) bySector.set(s, []);
    bySector.get(s).push(entry);
  }
  const sectorOrder = [
    ...SECTOR_LEGEND_ORDER.filter((s) => bySector.has(s)),
    ...[...bySector.keys()].filter((s) => !SECTOR_LEGEND_ORDER.includes(s)),
  ];
  const tenorIdx = (r) => {
    const i = RV2_STAT_TENOR_KEYS.indexOf(r.statTenor);
    return i === -1 ? 99 : i; // 만기미상(statTenor=null)은 맨 뒤
  };

  let hiddenBuckets = 0;
  const renderBucketBlock = ([cellKey, list]) => {
      const sample = list[0];
      // 통계는 **적용된 기준 풀**의 것을 보여준다 — 칸이 가드를 넘으면 칸, 아니면 롤업 대상.
      const cellStat = sample.cell ? cells.get(sample.cell) : null;
      const leafStat = leaves.get(sample.leaf) || { n: 0, median: null, mad: null, missing: 0 };
      const usedCell = !!(cellStat && cellStat.n >= RV2_MIN_BUCKET_SAMPLE);
      const b = usedCell ? cellStat : leafStat;

      // 등급 분해·미니 카운트는 **필터 전** 기준이다 — 모집단을 말하는 값이므로.
      const rb = list.reduce((a, r) => { a[r.rating_basis] = (a[r.rating_basis] || 0) + 1; return a; }, {});
      const rbText = Object.entries(rb).sort((x, y) => y[1] - x[1])
        .map(([k, v]) => `${RATING_LABEL[k] || k} ${v}`).join(' · ');
      const counts = tenorCounts(list);
      const miniText = TENOR_KEYS.filter((k) => counts[k]).map((k) => `${k} ${counts[k]}`).join(' · ');

      const shown = applyTenorFilter(list, TENOR_FILTER);
      if (!shown.length) { hiddenBuckets++; return ''; }
      const groups = tenorGroupsOf(shown);

      // 필터가 켜지면 표시 건수와 통계 모집단을 나란히 적는다. 섞이면 n 을 오해한다.
      const cellN = cellStat ? cellStat.n : 0;
      const nText = TENOR_FILTER.size
        ? `표시 ${shown.length} / 칸 n=${cellN}`
        : `칸 n=${cellN}`;
      // 롤업했으면 어떤 풀의 통계인지 못 박는다. 안 적으면 칸 통계로 오해한다.
      const rollup = usedCell ? ''
        : `<span class="b-meta b-warn">가드 미달 → <b>${esc(sample.medianSource)}</b> 기준 (${esc(sample.leaf)} n=${leafStat.n})</span>`;

      return `<details class="bucket" style="--sec:${sectorVar(sample.sector)}"${byLeaf.size <= 3 ? ' open' : ''}>
        <summary>
          <span class="b-dot"></span>
          <span class="b-name">${esc(cellKey)}</span>
          <span class="b-meta${usedCell ? '' : ' b-warn'}">${nText}</span>
          <span class="b-meta">중앙값 ${medianVal(b.median)} · MAD ${fmt(b.mad)}</span>
          ${rollup}
          <span class="b-meta${b.missing ? ' b-warn' : ''}">오프셋 미상 ${b.missing}</span>
          <span class="b-meta">등급 ${esc(rbText)}</span>
          <span class="b-meta b-tenor">표시구간 ${esc(miniText)}</span>
        </summary>
        <div class="b-body">${groups.map((g) => rankTable(g.rows, g.key)).join('')}</div>
      </details>`;
  };

  const sections = sectorOrder.map((s) => {
    const entries = bySector.get(s).sort((a, b) => {
      const A = a[1][0], B = b[1][0];
      return A.leaf === B.leaf ? tenorIdx(A) - tenorIdx(B) : A.leaf.localeCompare(B.leaf, 'ko');
    });
    const blocks = entries.map(renderBucketBlock).join('');
    if (!blocks) return ''; // 필터로 섹터 전체가 비면 헤더도 뺀다
    const total = entries.reduce((n, [, l]) => n + l.length, 0);
    return `<div class="sec-head" style="--sec:${sectorVar(s)}">
      <span class="sh-dot"></span><span class="sh-name">${esc(s)}</span>
      <span class="sh-meta">버킷 ${entries.length} · n ${total}</span>
    </div>${blocks}`;
  }).join('');

  const hiddenNote = hiddenBuckets
    ? `<div class="footnote" style="margin-bottom:10px">선택한 구간에 관측이 없는 버킷 <b>${hiddenBuckets}</b>개는 표시하지 않았습니다.</div>`
    : '';

  return head + renderTenorChips(ranked) + hiddenNote + sections;
}

function rankTable(list, tenorLabel) {
  // 표시 구간(6칸)과 통계 칸(3칸)이 다르므로 매핑을 라벨에 적는다 —
  // `2-3` 소그룹이 `2y+` 통계를 쓴다는 사실이 안 보이면 중앙값 출처를 오해한다.
  const stat = statTenorOf(tenorLabel);
  const mapNote = stat && stat !== tenorLabel ? `<span class="t-map">통계 ${esc(stat)}</span>`
    : stat ? '' : '<span class="t-map">통계 칸 없음 · 섹터 기준</span>';
  const groupHead = tenorLabel
    ? `<div class="t-group"><span class="t-key">${esc(tenorLabel)}</span><span class="t-n">${list.length}건</span>${mapNote}</div>`
    : '';
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
  return `${groupHead}<table class="q"><thead><tr>
    <th>방향</th><th>발행사</th><th>종목</th><th>만기</th><th>구간</th><th>등급</th>
    <th class="num">민평%</th><th class="num" title="호가 수익률 − 민평 수익률 (bp). +는 민평보다 높은 금리 = 싸게 나온 물건, −는 민평보다 낮은 금리 = 비싸게 나온 물건">오프셋</th><th class="num" title="오프셋 − 버킷 중앙값. 버킷(섹터×만기 무리)의 공통 수준을 뺀 값 — 같은 무리 안에서 상대적으로 싼 순서. 정렬 기준">조정</th>
    <th title="오프셋 산출 방식 — explicit: 호가 수익률과 민평이 모두 명시됨 / under·over: 언더N·오버N 표기 / bp: ±Nbp 표기 / flat: 민평팔자(=0)">산출근거</th><th>수량</th><th>브로커</th>
  </tr></thead><tbody>${trs}</tbody></table>`;
}

// ── 사자 수요 패널 (§3.3) ────────────────────────────────────────────────

/**
 * 구간 수요를 **연 단위 격자**로 집계한다.
 *
 * 이 레인이 따로 있는 이유: 기저 파서의 `NON_INDIVIDUAL_RE` 가 "1.5년 특은 사자" 류를
 * 일반관심으로 버리는데, RV-2 에선 **버리는 대상이 곧 수요 신호**다(§2.2-A).
 * 실측에서도 개별 호가는 offer 3,553 : bid 43 으로 사실상 전부 매도라, 매수 측 정보는
 * 여기 말고는 없다.
 *
 * 격자 배정은 구간이 겹치는 칸 **전부**에 센다 — "2~3년 사자"는 2-3 한 칸이지만
 * "1~5년 사자"는 1-2·2-3·3-5 세 칸에 수요가 있다. 한 칸으로 접으면 정보가 준다.
 */
export function bucketDemand(demand) {
  const grid = RV2_TENOR_GRID.map((g) => ({ ...g, bid: 0, offer: 0, other: 0 }));
  let unplaced = 0;
  for (const d of demand || []) {
    if (d.tenor_lo == null && d.tenor_hi == null) { unplaced++; continue; }
    // 격자는 반열린 구간 [lo, hi) 다. 수요 구간도 같은 규약으로 본다:
    //   tenor_hi === null 은 **상한 개방**("3년 이후")이지 점이 아니다.
    //   tenor_lo === null 은 하한 개방("1년 이내" → parseTenorSpan 이 0 을 준다).
    const a = d.tenor_lo == null ? 0 : d.tenor_lo;
    const b = d.tenor_hi == null ? Infinity : d.tenor_hi;
    let hit = false;
    for (const g of grid) {
      // 겹침 판정은 `b > g.lo` (등호 없음). "1~5년" 의 상한 5 가 5-10 칸으로 넘치면 안 된다.
      if (a < g.hi && b > g.lo) {
        hit = true;
        if (d.side === 'bid') g.bid++; else if (d.side === 'offer') g.offer++; else g.other++;
      }
    }
    if (!hit) unplaced++;
  }
  return { grid, unplaced };
}

function renderDemand(demand) {
  if (!demand || !demand.length) return '';
  const { grid, unplaced } = bucketDemand(demand);
  const max = Math.max(1, ...grid.map((g) => g.bid + g.offer + g.other));
  const cells = grid.map((g) => {
    const n = g.bid + g.offer + g.other;
    const w = Math.round((n / max) * 100);
    return `<tr>
      <td class="mono">${g.key}</td>
      <td class="num">${g.bid || '—'}</td>
      <td class="num">${g.offer || '—'}</td>
      <td style="width:55%"><div style="background:var(--accent);height:9px;border-radius:3px;width:${w}%"></div></td>
    </tr>`;
  }).join('');

  const lines = demand.slice(-40).reverse().map((d) => {
    const span = d.tenor_lo == null && d.tenor_hi == null ? (d.tenor_note || '구간미상')
      : d.tenor_lo === d.tenor_hi ? `${d.tenor_lo}y` : `${d.tenor_lo ?? '~'}–${d.tenor_hi ?? '+'}y`;
    return `<div class="excluded-line"><span class="why">[${esc(span)}]</span>${esc(d.raw_line).slice(0, 90)}</div>`;
  }).join('');

  return `<div class="sec-title">사자 수요 <span class="cap">구간 수요 ${demand.length}건 · 연 단위 격자 ·
    구간이 걸치는 칸에 모두 집계(합계 ≠ 건수)</span></div>
    <div class="panel">
      <table class="q"><thead><tr><th>구간</th><th class="num">사자</th><th class="num">팔자</th><th></th></tr></thead>
      <tbody>${cells}</tbody></table>
      ${unplaced ? `<div class="footnote" style="margin-top:8px">구간 미배정 <b>${unplaced}</b>건 —
        "7영업일 이내"·"국전전 사자관심" 처럼 연 단위 표현이 없는 라인</div>` : ''}
      <details style="margin-top:10px"><summary style="cursor:pointer;color:var(--muted);font-size:12px">원문 최근 ${Math.min(40, demand.length)}건 펼치기</summary>${lines}</details>
    </div>`;
}

// ── 미분류 패널 ──────────────────────────────────────────────────────────

/**
 * 미분류는 **버리지 않고 원문 그대로 남긴다** — 사전 확장 피드백 루프의 입력이다.
 * 다만 기본은 접어 둔다. 사유별 카운트가 1차 표시이고 원문은 펼쳐야 나온다.
 */
function renderUnclassified(list) {
  if (!list || !list.length) return '';
  const byReason = list.reduce((a, u) => { a[u.reason] = (a[u.reason] || 0) + 1; return a; }, {});
  const summary = Object.entries(byReason).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${esc(k)} <b>${v}</b>`).join(' · ');
  const lines = list.slice(-60).reverse().map((u) =>
    `<div class="excluded-line"><span class="why">[${esc(u.reason)}]</span>${esc(u.raw).slice(0, 110)}</div>`).join('');
  return `<div class="sec-title">미분류 <span class="cap">버리지 않고 원문 보존 · 사전 확장 피드백 루프</span></div>
    <div class="panel">
      <div class="footnote">${summary}</div>
      <details style="margin-top:8px"><summary style="cursor:pointer;color:var(--muted);font-size:12px">원문 최근 ${Math.min(60, list.length)}건 펼치기</summary>${lines}</details>
    </div>`;
}

// ── 이벤트 ───────────────────────────────────────────────────────────────

function onParse() {
  const ta = $('rv2-text');
  const text = ta.value;
  if (!text.trim()) return;
  const res = parseRv2(text);
  const c = accumulate(SESSION, res.quotes);
  // 수요·미분류도 키 기준으로 합친다. 그냥 push 하면 재붙여넣기마다 카운트가 배로 뛴다.
  mergeKeyed(SESSION.demand, res.demand, demandKey);
  mergeKeyed(SESSION.unclassified, res.unclassified, unclassifiedKey);
  SESSION.stats = res.stats;
  saveSession();
  ta.value = '';
  render();
  $('rv2-session-info').textContent =
    `방금: 신규 ${c.added} · 관측추가 ${c.appended} · 재붙여넣기 스킵 ${c.repeated} — ` + $('rv2-session-info').textContent;
}

function wire() {
  $('rv2-parse').addEventListener('click', onParse);
  // 칩은 렌더될 때마다 새로 만들어지므로 컨테이너에 위임한다.
  $('rv2-ranking').addEventListener('click', (e) => {
    const chip = e.target && e.target.closest && e.target.closest('[data-tenor]');
    if (!chip) return;
    const k = chip.dataset.tenor;
    if (k === '__all') TENOR_FILTER.clear();
    else if (TENOR_FILTER.has(k)) TENOR_FILTER.delete(k);
    else TENOR_FILTER.add(k);
    saveView();
    render();
  });
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
  loadView();
  wire();
  render();
}
