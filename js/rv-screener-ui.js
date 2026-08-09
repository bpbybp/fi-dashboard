// rv-screener-ui.js — RV-1 스크리너 페이지 컨트롤러 (Phase 1: 민평 업로드 + 요약).
//   측정만 한다. 판별은 결정론적 계산까지, "잡을 만한가"는 사용자 몫.
//
// 절대 원칙:
//  - 클라이언트 온리. 민평·호가 데이터는 브라우저 밖으로 절대 나가지 않는다(서버·전송·커밋 없음).
//  - no-build. vanilla JS. 외부 리소스는 cdnjs SheetJS(window.XLSX) 하나뿐.
//  - localStorage 만 사용(키 rv-screener-mp). 파일 자체는 저장하지 않고 파싱 결과 구조만 보관.
//
// 민평 파일 스펙(인포맥스 4788, 로컬 샘플로 검증):
//  - Sheet1 사용. 1행 메타, 헤더 행은 '채권그룹'+'발행사' 포함 행을 탐색(행번호 하드코딩 금지).
//  - 좌측 사이드표(B~C열, '채권그룹' 중복 출현)는 무시 → '발행사' 헤더를 E열(4) 이후에서 앵커로 잡음.
//  - E블록 순서: 채권그룹 | 발행사 | 평가사 | 15테너 | 회사코드 | …
//  - 회사코드 '00000' = 그룹 대표커브 행, 그 외 = 발행사 행. 발행사명은 유일키(중복 시 경고).

import { parseKbondQuotes } from './rv-parser.js';
import { matchIssuer } from './rv-matcher.js';
import { KBOND_ABBREVIATIONS } from './rv-abbrev.js';
import { resolveReference, computeStats, buildAliases, quoteYield } from './rv-engine.js';
import { crossSectional, RV_VALIDATION_THRESHOLD_BP, RV_MIN_BUCKET_SAMPLE } from './rv-cross.js';

const LS_KEY = 'rv-screener-mp';
const LS_SESSION = 'rv-screener-session';

let ALIASES = null; // 민평 issuers → matchIssuer용 (MP 로드/복원 시 캐시)
const ensureAliases = () => { if (MP && !ALIASES) ALIASES = buildAliases(MP); return ALIASES; };
// 테너 라벨은 헤더에서 읽되, 기대 순서 검증용 기준.
const EXPECT_TENORS = ['3M', '6M', '9M', '1Y', '1.5Y', '2Y', '2.5Y', '3Y', '4Y', '5Y', '7Y', '10Y', '15Y', '20Y', '30Y'];

let MP = null; // { asOfLabel, asOfSource, issuers, groupCurves, dupes, counts }
let SESSION = { dateKey: null, quotes: [], unparsed: [] }; // 당일 누적 호가

// ── 민평 xlsx → 구조화 ──
// 반환: { asOfLabel, asOfSource, issuers:{name:{group,code,curve:{tenor:yield}}}, groupCurves:{group:{code,curve}}, dupes:[], counts:{...} }
function parseMinpyeong(arrayBuffer, fileName) {
  if (!window.XLSX) throw new Error('SheetJS(XLSX) 로드 실패 — 네트워크 확인');
  const wb = window.XLSX.read(arrayBuffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]]; // Sheet1
  const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });

  // 헤더 행 탐색: '채권그룹' + '발행사' 동시 포함
  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const j = rows[i].map((c) => String(c)).join('|');
    if (j.includes('채권그룹') && j.includes('발행사')) { h = i; break; }
  }
  if (h < 0) throw new Error('헤더 행(채권그룹·발행사)을 찾지 못함 — 4788 내보내기 형식인지 확인');
  const header = rows[h].map((c) => String(c).trim());

  // 발행사 열 앵커: E열(4) 이후의 '발행사' (좌측 사이드표 배제)
  let issuerCol = -1;
  for (let i = header.length - 1; i >= 4; i--) { if (header[i] === '발행사') { issuerCol = i; break; } }
  if (issuerCol < 0) throw new Error('E열 이후 발행사 열을 찾지 못함');
  const groupCol = issuerCol - 1;
  const evalCol = issuerCol + 1;
  const tenorStart = evalCol + 1;
  const codeCol = header.findIndex((c) => c === '회사코드');

  // 테너 라벨은 헤더에서 직접 읽음(파일 순서 그대로). 없으면 기대 라벨로 폴백.
  const tenors = [];
  for (let t = 0; t < 15; t++) {
    const lbl = header[tenorStart + t];
    tenors.push(lbl && lbl !== '' ? lbl : EXPECT_TENORS[t]);
  }

  const issuers = {};
  const groupCurves = {};
  const dupes = new Set();
  let issuerRows = 0, repRows = 0;
  for (const r of rows.slice(h + 1)) {
    const name = String(r[issuerCol] ?? '').trim();
    if (!name) continue;
    const group = String(r[groupCol] ?? '').trim();
    const codeStr = codeCol >= 0 ? String(r[codeCol] ?? '').trim() : '';
    // 그룹 대표커브 판별: 회사코드가 문자열 '00000'/'0' 또는 숫자 0 (엑셀이 앞자리 0을 숫자로 떨굼) 모두 그룹행.
    // 빈 셀(Number('')===0)은 제외하기 위해 비어있지 않음 + 수치 0 을 함께 요구.
    const isRep = codeStr !== '' && Number(codeStr) === 0;
    const code = codeStr;
    const curve = {};
    for (let t = 0; t < 15; t++) {
      const v = r[tenorStart + t];
      const num = typeof v === 'number' ? v : (v === '' || v == null ? NaN : Number(v));
      if (Number.isFinite(num)) curve[tenors[t]] = num;
    }
    if (isRep) {
      groupCurves[group] = { code, curve };
      repRows++;
    } else {
      if (Object.prototype.hasOwnProperty.call(issuers, name)) dupes.add(name);
      issuers[name] = { group, code, curve };
      issuerRows++;
    }
  }

  // 기준일: 파일명 4788(YYMMDD) 또는 4788_YYMMDD_ 등에서 추출, 실패 시 업로드 시각
  const dateMatch = String(fileName || '').match(/4788[^0-9]*(\d{2})(\d{2})(\d{2})/);
  let asOfLabel, asOfSource;
  if (dateMatch) {
    asOfLabel = `20${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    asOfSource = '파일명';
  } else {
    asOfLabel = new Date().toISOString().slice(0, 16).replace('T', ' ');
    asOfSource = '업로드 시각(파일명 미상)';
  }

  const groups = new Set([...Object.values(issuers).map((x) => x.group), ...Object.keys(groupCurves)]);
  return {
    asOfLabel, asOfSource, issuers, groupCurves, dupes: [...dupes],
    counts: { issuers: issuerRows, reps: repRows, groups: groups.size, groupCurves: Object.keys(groupCurves).length },
  };
}

// ── 저장/복원 ──
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ kind: LS_KEY, version: 1, mp: MP })); } catch (e) { /* 용량초과 등 무시 */ }
}
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (s && s.mp && s.mp.issuers) MP = s.mp;
  } catch { MP = null; }
}

// ── 렌더 ──
function renderSummary() {
  const warn = document.getElementById('mp-warn');
  const sum = document.getElementById('mp-summary');
  const clr = document.getElementById('mp-clear');
  const hint = document.getElementById('mp-hint');
  if (!MP) {
    warn.style.display = 'none';
    clr.style.display = 'none';
    sum.innerHTML = `<div class="empty">아직 민평이 없습니다. 위에서 <code>4788</code> 내보내기 <code>.xlsx</code>를 올리세요.<br>`
      + `업로드하면 발행사·그룹 커브가 브라우저에 구조화되어 이후 호가 판별에 쓰입니다.</div>`;
    return;
  }
  clr.style.display = '';
  hint.textContent = '다른 날짜 파일을 올리면 교체됩니다.';
  const c = MP.counts;
  if (MP.dupes.length) {
    warn.style.display = '';
    warn.innerHTML = `⚠️ 발행사명 중복 ${MP.dupes.length}종 — 유일키 가정 위반. 마지막 행 기준으로 덮어씀: `
      + `<span style="font-family:var(--mono)">${MP.dupes.slice(0, 12).join(', ')}${MP.dupes.length > 12 ? ' …' : ''}</span>`;
  } else {
    warn.style.display = 'none';
  }
  sum.innerHTML = `<div class="stats">
    <div class="stat"><div class="stat-label">발행사</div>
      <div class="stat-main">${c.issuers}<span class="stat-unit">종</span></div>
      <div class="stat-sub">회사코드 ≠ 00000</div></div>
    <div class="stat"><div class="stat-label">채권그룹(등급 버킷)</div>
      <div class="stat-main">${c.groups}<span class="stat-unit">그룹</span></div>
      <div class="stat-sub">대표커브 ${c.groupCurves}개(00000)</div></div>
    <div class="stat"><div class="stat-label">민평 기준일</div>
      <div class="stat-main" style="font-size:19px">${MP.asOfLabel}</div>
      <div class="stat-sub">${MP.asOfSource}</div></div>
    <div class="stat"><div class="stat-label">발행사명 중복</div>
      <div class="stat-main" style="color:${MP.dupes.length ? 'var(--red)' : 'var(--ok)'}">${MP.dupes.length}<span class="stat-unit">종</span></div>
      <div class="stat-sub">${MP.dupes.length ? '경고 배너 참조' : '유일키 정상'}</div></div>
  </div>`;
}

function renderFootnote() {
  document.getElementById('footnote').innerHTML =
    `<div>민평 그리드 = 인포맥스 4788 화면 내보내기. 헤더 행은 <span class="k">채권그룹·발행사</span> 포함 행을 자동 탐색(행번호 비의존). `
    + `실데이터는 E열부터(채권그룹·발행사·평가사·15테너·회사코드), 좌측 사이드표는 무시.</div>`
    + `<div>회사코드 <span class="k">00000</span>=그룹 대표커브, 그 외=발행사 커브. 등급은 채권그룹명에 내장 → 별도 매핑 없이 횡단면 버킷 키로 사용.</div>`
    + `<div>데이터는 <span class="k">localStorage</span>(브라우저 로컬)에만 저장 — 서버 전송·리포 커밋 없음.</div>`;
}

async function onFile(file) {
  const hint = document.getElementById('mp-hint');
  try {
    hint.textContent = `${file.name} 파싱 중…`;
    const buf = await file.arrayBuffer();
    const parsed = parseMinpyeong(buf, file.name);
    if (!parsed.counts.issuers) throw new Error('발행사 행 0 — 형식 확인');
    MP = parsed;
    ALIASES = null; // 새 민평 → aliases 재빌드
    save();
    renderSummary();
    renderQuotes(); // 매칭·기준수익률 재계산
  } catch (e) {
    hint.textContent = '';
    const warn = document.getElementById('mp-warn');
    warn.style.display = '';
    warn.innerHTML = `❌ 파싱 실패: ${e.message}`;
  }
}

// ── 호가 세션 (당일 누적, 날짜 바뀌면 초기화, 중복은 최신 갱신) ──
const todayKey = () => new Date().toISOString().slice(0, 10);
// 중복 판별 키: 발행사·종목·만기·방향
const quoteKey = (q) => [q.issuer_raw, q.bond_code, q.maturity_date, q.side].join('|');

function saveSession() {
  try { localStorage.setItem(LS_SESSION, JSON.stringify({ kind: LS_SESSION, version: 1, session: SESSION })); } catch { /* noop */ }
}
function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SESSION) || 'null');
    if (s && s.session && s.session.dateKey === todayKey()) SESSION = s.session;
    else SESSION = { dateKey: todayKey(), quotes: [], unparsed: [] }; // 날짜 바뀌면 자동 초기화
  } catch { SESSION = { dateKey: todayKey(), quotes: [], unparsed: [] }; }
}

// 새 파싱분을 세션에 누적. 중복 호가는 위치 유지하며 최신으로 갱신.
function accumulate(newQuotes, newUnparsed) {
  if (SESSION.dateKey !== todayKey()) SESSION = { dateKey: todayKey(), quotes: [], unparsed: [] };
  const idx = new Map(SESSION.quotes.map((q, i) => [quoteKey(q), i]));
  let added = 0, updated = 0;
  for (const q of newQuotes) {
    const k = quoteKey(q);
    if (idx.has(k)) { SESSION.quotes[idx.get(k)] = q; updated++; }
    else { idx.set(k, SESSION.quotes.length); SESSION.quotes.push(q); added++; }
  }
  const seen = new Set(SESSION.unparsed.map((u) => u.raw));
  for (const u of newUnparsed) { if (!seen.has(u.raw)) { seen.add(u.raw); SESSION.unparsed.push(u); } }
  saveSession();
  return { added, updated };
}

const SIDE = { offer: { t: '매도(팔)', c: 'side-offer' }, bid: { t: '매수(사)', c: 'side-bid' }, interest: { t: '관심', c: 'side-interest' } };
// 잔존연수 = (만기일 − 오늘)/365.25 (Phase 3 확정 규칙, 기준일=오늘 단순화)
function residualYears(dateStr) {
  if (!dateStr) return null;
  const ms = new Date(dateStr + 'T00:00:00') - new Date(todayKey() + 'T00:00:00');
  const y = ms / (365.25 * 864e5);
  return Number.isFinite(y) ? Math.round(y * 10) / 10 : null;
}
const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const bp = (x) => (x == null ? null : Math.round(x * 10) / 10);
const gapColor = (b) => (b == null ? '' : (b >= 15 ? 'var(--red)' : b <= -15 ? 'var(--ok)' : 'var(--muted)'));
const METHOD_BADGE = {
  issuer: '<span class="conf conf-high">발행사</span>',
  group_fallback: '<span class="conf conf-medium">그룹폴백</span>',
  unmatched: '<span class="conf conf-low">실패</span>',
};

function renderQuotes() {
  const res = document.getElementById('q-result');
  const exc = document.getElementById('q-excluded');
  const st = document.getElementById('q-stats');
  const qs = SESSION.quotes;
  const today = SESSION.dateKey || todayKey();
  const hasMP = !!MP;
  const aliases = hasMP ? ensureAliases() : null;

  st.textContent = `당일 세션: 호가 ${qs.length}건 · 제외/미파싱 ${SESSION.unparsed.length}건 · ${today}`
    + (hasMP ? ` · 민평 ${MP.asOfLabel}` : ' · 민평 없음(매칭 대기)');

  // 각 호가 → 기준수익률 해석(민평 있을 때만)
  const rows = qs.map((q) => ({ q, ref: hasMP ? resolveReference(q, MP, aliases, KBOND_ABBREVIATIONS, matchIssuer, today) : null }));
  const stats = hasMP ? computeStats(rows) : null;

  // ── 오프셋 미상 사유 (B-6 이후 신설) ──────────────────────────────────
  // B-6 수정 전에는 레벨 없는 호가에 0bp 가 붙어 전부 랭킹에 올라갔다. 이제 미상으로 빠지는데,
  // 그 규모가 크다(2026-08-05 샘플에서 전체 호가의 55%). **빼되 숨기지 않는다** —
  // RV-2 §6.2와 같은 규약으로 사유별 카운트를 노출한다.
  const missReason = (g) => {
    if (g.quoteYieldBasis === '원(듀레이션 필요)') return '원단위(듀레이션 필요)';
    if (g.quoteYieldBasis === '미상(레벨없음)') return '레벨 없음';
    if (g.reference == null) return '기준없음(외삽/결측)';
    return '미상';
  };
  const countBy = (list, fn) => list.reduce((acc, x) => { const k = fn(x); acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  const reasonLine = (obj, total) => Object.entries(obj).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${esc(k)} <b>${v}</b>${total ? `(${Math.round((v / total) * 100)}%)` : ''}`).join(' · ');

  if (!qs.length) {
    res.innerHTML = SESSION.unparsed.length ? '' : '<div class="empty">아직 파싱된 호가가 없습니다. 위 입력창에 붙여넣고 [파싱]을 누르세요.</div>';
  } else if (!hasMP) {
    // 민평 미업로드 → 내장민평 기반 원괴리는 계산(그리드 불요), 보간폴백·검증·버킷 조정은 업로드 후 활성.
    const trs = [...qs].reverse().map((q) => {
      const sd = SIDE[q.side] || { t: q.side, c: '' };
      const ry = bp(residualYears(q.maturity_date, today));
      const sp = q.spread_type == null ? '—' : (q.spread_type === 'flat' ? 'flat' : `${q.spread_type} ${q.spread_value}`);
      const qy = quoteYield(q).y;
      const rawGap = (qy != null && q.minpyeong_yield != null) ? bp((qy - q.minpyeong_yield) * 100) : null;
      return `<tr><td class="${sd.c}">${sd.t}</td><td>${esc(q.issuer_raw) || '<span style="color:var(--red)">(추출실패)</span>'}</td>
        <td class="mono">${esc(q.bond_code) || '—'}</td><td class="mono">${esc(q.rating) || '—'}</td>
        <td class="num">${q.minpyeong_yield ?? '—'}</td><td class="num">${qy == null ? '—' : qy.toFixed(3)}</td>
        <td class="num" style="color:${gapColor(rawGap)}">${rawGap == null ? '—' : (rawGap > 0 ? '+' : '') + rawGap}</td>
        <td class="mono">${sp}</td><td class="mono">${q.maturity_date ? `${q.maturity_date}${ry != null ? ` (${ry}y)` : ''}` : '—'}</td>
        <td><span class="conf conf-${q.parse_confidence}">${q.parse_confidence}</span></td></tr>`;
    }).join('');
    // 업로드 전에도 미상 규모는 보여준다 — 여기서도 숨기지 않는다.
    const preMiss = qs.filter((q) => quoteYield(q).y == null || q.minpyeong_yield == null);
    const preSummary = preMiss.length ? `<div class="footnote" style="margin:0 0 10px"><div>원괴리 산출 불가 ${preMiss.length}/${qs.length}(${Math.round((preMiss.length / qs.length) * 100)}%) — ${reasonLine(countBy(preMiss, (q) => {
      const b = quoteYield(q).basis;
      if (b === '원(듀레이션 필요)') return '원단위(듀레이션 필요)';
      if (b === '미상(레벨없음)') return '레벨 없음';
      return q.minpyeong_yield == null ? '내장민평 없음' : '미상';
    }), preMiss.length)}</div></div>` : '';

    res.innerHTML = `<div class="notice" style="margin:0 0 10px">민평 미업로드 — <b>내장민평 기반 괴리는 계산되나 보간 폴백·검증 플래그는 민평 업로드 후 활성화</b>됩니다. (횡단면 버킷 조정괴리·발행사 매칭도 업로드 후)</div>
      ${preSummary}
      <div class="sec-title">파싱된 호가 <span class="cap">최신순 · 원괴리(내장민평) = 호가수익률 − 내장민평 · 수량 컬럼 제외</span></div>
      <table class="q"><thead><tr><th>방향</th><th>발행사(raw)</th><th>종목</th><th>등급</th>
      <th class="num">내장민평%</th><th class="num">호가%</th><th class="num">원괴리bp</th><th>스프레드</th><th>잔존만기</th><th>신뢰도</th></tr></thead><tbody>${trs}</tbody></table>`;
  } else {
    // 민평 있음 → 횡단면 판별. 괴리=호가수익률−(내장민평 ?? 보간). 버킷 중앙값 차감→조정괴리.
    const { gaps, bm, offers, bids, unrankable } = crossSectional(rows, quoteYield);
    const failed = gaps.filter((g) => g.method === 'unmatched');
    const missing = gaps.filter((g) => g.rawGap == null);
    const missTotal = missing.length;
    const missByReason = countBy(missing, missReason);
    const missByBucket = countBy(missing.filter((g) => g.bucket != null), (g) => g.bucket);

    // 통계 패널
    const statsPanel = `<div class="stats" style="margin-bottom:12px">
      <div class="stat"><div class="stat-label">매칭률</div>
        <div class="stat-main" style="font-size:17px">${stats.n ? Math.round((stats.by.issuer + stats.by.group_fallback) / stats.n * 100) : 0}<span class="stat-unit">%</span></div>
        <div class="stat-sub">발행사 ${stats.by.issuer} · 그룹폴백 ${stats.by.group_fallback} · 실패 ${stats.by.unmatched}</div></div>
      <div class="stat"><div class="stat-label">내장민평 보유</div>
        <div class="stat-main" style="font-size:17px">${Math.round(stats.embeddedPct)}<span class="stat-unit">%</span></div>
        <div class="stat-sub">${stats.embeddedCount}/${stats.n} · 기준 1순위</div></div>
      <div class="stat"><div class="stat-label">내장민평 − 보간 (bp)</div>
        <div class="stat-main" style="font-size:17px">${stats.diffMedian == null ? '—' : bp(stats.diffMedian)}<span class="stat-unit">중앙값</span></div>
        <div class="stat-sub">최대 ${stats.diffMaxAbs == null ? '—' : bp(stats.diffMaxAbs)}bp · ±${RV_VALIDATION_THRESHOLD_BP}↑ ${stats.diffOver15}건 검증</div></div>
      <div class="stat"><div class="stat-label">세션 중앙값(베타)</div>
        <div class="stat-main" style="font-size:17px">${bm.sessionMedian == null ? '—' : (bm.sessionMedian > 0 ? '+' : '') + bp(bm.sessionMedian)}<span class="stat-unit">bp</span></div>
        <div class="stat-sub">내장민평 기반 N=${bm.sessionCount} · 버킷&lt;${RV_MIN_BUCKET_SAMPLE} 폴백</div></div>
      <div class="stat"><div class="stat-label">오프셋 미상</div>
        <div class="stat-main" style="font-size:17px">${gaps.length ? Math.round((missTotal / gaps.length) * 100) : 0}<span class="stat-unit">%</span></div>
        <div class="stat-sub">${missTotal}/${gaps.length} · 랭킹 제외(사유는 아래)</div></div>
    </div>`;

    // 사유별 카운트 — RV-2 §6.2 규약. 미상 건수가 크면 그 세션의 랭킹 자체가 대표성이
    // 없다는 신호이므로 사용자가 알아야 한다.
    const missSummary = missTotal ? `<div class="footnote" style="margin:0 0 12px">
      <div>오프셋 미상 사유: ${reasonLine(missByReason, missTotal)}</div></div>` : '';

    // 버킷 중앙값 요약(당일 시장 베타 근사) — 표본 많은 순 상위
    // 버킷 헤더에 미상 건수를 함께 적는다(`n=12 · 미상 3`) — RV-2 §6.2.
    // 표본 n 만 보면 그 버킷의 랭킹이 대표성 있는 줄 오해한다.
    const bucketSummary = Object.keys(bm.bucketMedian)
      .map((b) => ({ b, m: bm.bucketMedian[b], n: bm.bucketCount[b], miss: missByBucket[b] || 0 }))
      .sort((a, b) => b.n - a.n).slice(0, 8)
      .map((x) => `${esc(x.b)} <span class="mono">${x.m > 0 ? '+' : ''}${bp(x.m)}bp</span>(n=${x.n}${x.miss ? ` · 미상 ${x.miss}` : ''})`).join(' · ');
    // 유효 표본이 하나도 없어 중앙값 자체가 없는 버킷 — 위 목록에 아예 안 나온다.
    const bucketsAllMissing = Object.keys(missByBucket).filter((b) => !(b in bm.bucketMedian));
    const sessionHeader = `<div class="footnote" style="margin:0 0 12px">
      <div>당일 버킷 중앙값(내장민평 기반 = 시장 베타 근사): ${bucketSummary || '—'}</div>
      ${bucketsAllMissing.length ? `<div>유효 표본 0인 버킷 ${bucketsAllMissing.length}개(전건 미상): ${bucketsAllMissing.slice(0, 6).map(esc).join(' · ')}${bucketsAllMissing.length > 6 ? ' …' : ''}</div>` : ''}
      <div>매도 ${offers.length} · 매수 ${bids.length} · 괴리계산불가 ${unrankable.length} · 매칭실패 ${failed.length}</div></div>`;

    // RV 행: 발행사·종목·매칭·잔존·기준(값+출처)·호가%·원괴리·버킷중앙·조정괴리(강조)·검증
    const rvRow = (g) => {
      const q = g.q;
      const srcBadge = g.refSource === '내장민평' ? '<span class="conf conf-high">내장민평</span>'
        : g.refSource === '보간폴백' ? '<span class="conf conf-medium">보간폴백</span>' : '';
      const medBadge = g.medianSource === '세션폴백' ? ' <span class="conf conf-medium">세션</span>' : '';
      const adj = g.adjustedGap;
      const adjHi = (adj != null && Math.abs(adj) >= RV_VALIDATION_THRESHOLD_BP) ? 'var(--accent)' : 'var(--text)';
      const val = g.validationFlag
        ? `<span title="내장민평−보간 ${bp(g.validationDiff)}bp (>${RV_VALIDATION_THRESHOLD_BP}bp): 내장민평 낡음/오기 가능" style="color:var(--amber)">⚠</span>` : '';
      return `<tr>
        <td>${esc(q.issuer_raw)}</td>
        <td class="mono">${esc(q.bond_code) || '—'}</td>
        <td>${METHOD_BADGE[g.method] || ''}</td>
        <td class="mono">${g.ref && g.ref.ry != null ? bp(g.ref.ry) + 'y' : '—'}</td>
        <td class="num">${g.reference != null ? g.reference.toFixed(3) : '—'} ${srcBadge}</td>
        <td class="num">${g.quoteYield != null ? g.quoteYield.toFixed(3) : '—'}</td>
        <td class="num">${g.rawGap == null ? '—' : (g.rawGap > 0 ? '+' : '') + bp(g.rawGap)}</td>
        <td class="num">${g.medianUsed == null ? '—' : (g.medianUsed > 0 ? '+' : '') + bp(g.medianUsed)}${medBadge}</td>
        <td class="num" style="color:${adjHi};font-weight:700">${adj == null ? '—' : (adj > 0 ? '+' : '') + bp(adj)}</td>
        <td>${val}</td>
      </tr>`;
    };
    const rvHead = `<thead><tr><th>발행사</th><th>종목</th><th>매칭</th><th>잔존</th>
      <th class="num">기준%</th><th class="num">호가%</th><th class="num">원괴리</th><th class="num">버킷중앙</th><th class="num">조정괴리</th><th>검증</th></tr></thead>`;
    const rvTable = (list) => `<table class="q">${rvHead}<tbody>${list.map(rvRow).join('')}</tbody></table>`;

    // 목록은 접어 둔다. 사유별 카운트가 1차 표시이고, 원문은 여전히 버리지 않는다.
    // (2026-08-05 샘플 기준 이 목록이 1,900건을 넘어 펼친 채로는 스크롤이 무의미했다.)
    const unrankableBlock = unrankable.length
      ? `<div class="sec-title">괴리 계산 불가 <span class="cap">사유별 카운트 우선 · 원문은 접어서 보존</span></div>`
        + `<div class="footnote" style="margin:0 0 8px"><div>${reasonLine(countBy(unrankable, missReason), unrankable.length)}</div></div>`
        + `<details style="margin:0 0 12px"><summary style="cursor:pointer;color:var(--muted);font-size:12px">원문 ${unrankable.length}건 펼치기</summary>`
        + unrankable.map((g) => `<div class="excluded-line"><span class="why">[${esc(missReason(g))}]</span>${esc(g.q.issuer_raw)} · ${esc(g.q.raw_line).slice(0, 60)}</div>`).join('')
        + '</details>'
      : '';

    res.innerHTML = statsPanel + missSummary + sessionHeader
      + `<div class="sec-title">매도호가 — 싸게 나온 순 <span class="cap">조정괴리 큰 순 · 민평보다 높은 수익률</span></div>`
      + (offers.length ? rvTable(offers) : '<div class="cap" style="padding:6px">해당 없음</div>')
      + `<div class="sec-title">매수호가 — 비싸게 사려는 순 <span class="cap">조정괴리 작은(음수) 순 · 보유물 매도 기회</span></div>`
      + (bids.length ? rvTable(bids) : '<div class="cap" style="padding:6px">해당 없음</div>')
      + unrankableBlock
      + (failed.length ? `<div class="sec-title">매칭 실패 <span class="cap">발행사·그룹 모두 매칭 실패 — 버리지 않고 표시</span></div>`
        + [...failed].reverse().map((g) => `<div class="excluded-line"><span class="why">[매칭실패]</span>${esc(g.q.issuer_raw)} · ${esc(g.q.raw_line).slice(0, 60)}</div>`).join('') : '');
  }

  if (!SESSION.unparsed.length) { exc.innerHTML = ''; return; }
  const ex = SESSION.unparsed.map((u) =>
    `<div class="excluded-line"><span class="why">[${esc(u.reason)}]</span>${esc(u.raw)}</div>`).join('');
  exc.innerHTML = `<div class="sec-title">제외·미파싱 라인 <span class="cap">버리지 않고 원문 보존 · CP/CD·일반관심·방향없음</span></div>${ex}`;
}

function onParse() {
  const ta = document.getElementById('q-text');
  const text = ta.value;
  if (!text.trim()) return;
  // Phase 2: 매처 미주입(발행사 canonical은 Phase 3). 파싱만.
  const { quotes, unparsed } = parseKbondQuotes(text);
  const { added, updated } = accumulate(quotes, unparsed);
  ta.value = '';
  renderQuotes();
  const st = document.getElementById('q-stats');
  st.textContent = `방금: +${added}건 신규, ${updated}건 갱신 · ` + st.textContent;
}

function wire() {
  document.getElementById('mp-file').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) onFile(f);
    e.target.value = ''; // 같은 파일 재선택 허용
  });
  document.getElementById('mp-clear').addEventListener('click', () => {
    MP = null; ALIASES = null;
    try { localStorage.removeItem(LS_KEY); } catch { /* noop */ }
    document.getElementById('mp-hint').textContent = '인포맥스 4788 화면 내보내기(.xlsx). 브라우저 안에서만 처리 — 서버 전송·저장 없음.';
    renderSummary();
    renderQuotes(); // 매칭 컬럼 제거
  });
  document.getElementById('q-parse').addEventListener('click', onParse);
  document.getElementById('q-clear-session').addEventListener('click', () => {
    SESSION = { dateKey: todayKey(), quotes: [], unparsed: [] };
    try { localStorage.removeItem(LS_SESSION); } catch { /* noop */ }
    renderQuotes();
  });
}

export function initRvScreener() {
  load();
  loadSession();
  wire();
  renderSummary();
  renderQuotes();
  renderFootnote();
}
