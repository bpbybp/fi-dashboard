// st1-parser.js — ST-1 단기물 호가 기록 파서 (Phase 1).
//
// 정체: 단기물(CP·예담·전단채·ABSTB) 호가 한 줄 → **기록용 행 1개**.
//       측정도 판단도 하지 않는다. 여기서 하는 일은 토큰을 뽑아 스키마에 담는 것뿐이다.
//
// ── 순수 함수만 ─────────────────────────────────────────────────────────
//   DOM·localStorage·fetch·파일 접근 0. Phase 1 범위는 파서와 스키마뿐이고
//   UI·데이터파일·배치는 건드리지 않는다.
//
// ── 어순 비의존 ─────────────────────────────────────────────────────────
//   호가는 "아이엠증권 A1 CP 27년 3월 만기 3.70%" 로도, "A1 CP 아이엠증권 3.70 27/3" 로도 온다.
//   따라서 위치가 아니라 **토큰 모양**으로 뽑고, 뽑은 자리는 원문 사본에서 지워 다음 단계로 넘긴다.
//   지우지 않으면 "27년 3월"의 3 이 금리로, "100억"의 100 이 만기로 새어든다.
//
// ── 추출 순서가 곧 규칙이다 ─────────────────────────────────────────────
//   ① 만기 → ② 금액 → ③ 금리 → ④ 등급 → ⑤ 종류 → ⑥ 나머지 = 발행사
//   숫자를 먹는 필드(만기·금액)를 먼저 걷어내야 금리가 안전하다. 순서를 바꾸면 오탐이 난다.
//
// ── rv-parser.js / rv2-parser.js 와의 관계 ──────────────────────────────
//   둘 다 **참고만** 한다. import 하지 않고 수정하지도 않는다. 케이본드 채팅 라인 문법과
//   단기물 호가 라인 문법이 다르고, RV 계열을 건드리면 테스트 없는 RV-1 회귀 위험이 붙는다.

// ── 상수 (임계값·패턴은 이 파일 한 곳에만) ──────────────────────────────

/**
 * 2자리 연도의 하한. `26` → 2026 으로 펴되, 이보다 작은 두 자리는 만기로 보지 않는다.
 *
 * 왜 필요한가: `\d{2,4}[./-]\d{1,2}` 는 만기 "27/3" 과 금리 "10.5" 를 구분하지 못한다.
 * 단기물 만기는 정의상 가까운 미래라 과거 연도가 나올 수 없으므로, 하한을 걸면
 * 금리 오탐만 골라 떨어뜨릴 수 있다. (③ 이 ① 뒤에 오는 이상 이 가드가 마지막 방어선이다.)
 */
const MIN_YY = 20;

/** 정확만기 — "26.11.20" · "26/11/20" · "2026-11-20". 연-월 형태보다 **먼저** 시도해야 한다. */
const MATURITY_DATE_RE = /(\d{2,4})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})/;

/** 연-월(한글) — "27년 3월" · "27년3월" · "2027년 03월". */
const MATURITY_YM_KO_RE = /(\d{2,4})\s*년\s*(\d{1,2})\s*월/;

/** 연-월(구분자) — "27/3" · "2027-03" · "26.11". */
const MATURITY_YM_SEP_RE = /(\d{2,4})\s*[.\-/]\s*(\d{1,2})/;

/**
 * 금액 — "100억" · "50억".
 * 스키마상 억 단위 정수지만 패턴은 소수를 허용한다. `(\d+)\s*억` 로 좁히면
 * "1.5억" 에서 뒤쪽 `5억` 만 잡혀 **5** 가 되는 조용한 오독이 생긴다.
 */
const AMOUNT_RE = /(\d+(?:\.\d+)?)\s*억/;

/** 금리 — % 가 붙으면 정수도 인정한다("3%"). */
const RATE_PCT_RE = /(\d+(?:\.\d+)?)\s*%/;

/**
 * 금리 — % 없는 형태. **소수점을 필수로 요구한다.**
 * 정수 단독(`3`, `100`)을 금리로 받으면 종목코드·수량 잔여물이 전부 금리가 된다.
 */
const RATE_BARE_RE = /(\d+\.\d+)/;

/**
 * 등급 — 긴 것 우선(A2+ 가 A2 보다 먼저). 대소문자 무시.
 *
 * 앞뒤 룩어라운드가 핵심이다. 이게 없으면 한 글자 등급(B·C·D)이 **`ABSTB` 의 B**,
 * **`CP` 의 C** 에 걸린다. 한글은 경계로 인정한다 — "예담CP" 의 C 는 앞이 '담' 이라
 * 룩비하인드를 통과하지만 뒤의 'P' 가 룩어헤드에서 막힌다.
 */
const GRADE_RE = /(?<![A-Za-z0-9])(A1|A2\+|A2-|A2|A3\+|A3-|A3|B\+|B-|B|C|D)(?![A-Za-z0-9])/i;

/**
 * 종류 — **우선순위 배열 순서대로 탐색**한다. 정규식 하나에 `|` 로 묶으면 문자열에서
 * 먼저 나오는 쪽이 이겨서 "예담CP" 가 위치에 따라 CP 로 갈릴 수 있다. 목록 순서가
 * 곧 "긴 것 우선" 이므로 배열로 둔다.
 */
const KIND_PATTERNS = [
  { re: /예\s*담\s*CP/i, kind: '예담' },
  { re: /전단채/, kind: '전단채' },
  { re: /(?<![A-Za-z])ABSTB(?![A-Za-z])/i, kind: 'ABSTB' },
  { re: /예\s*담/, kind: '예담' },
  { re: /전단/, kind: '전단채' },
  { re: /(?<![A-Za-z])STB(?![A-Za-z])/i, kind: 'ABSTB' },
  { re: /(?<![A-Za-z])CP(?![A-Za-z])/i, kind: 'CP' },
];

/**
 * 발행사 잔여물에서 걷어낼 불용어.
 *
 * ⚠️ **조사를 글자 단위로 떼지 않는다.** "국민은행" 에서 '은' 을 조사로 보고 지우면
 * "국민행" 이 된다 — `js/rv2-parser.js:252` 가 겪은 것과 같은 종류의 함정이다.
 * 지우는 것은 통째로 등장하는 명시적 불용어뿐이다.
 */
const STOPWORD_RE = /(?:만기|호가|금리)/g;

/** 법인격 꼬리 — 정규화에서만 제거한다(issuer_raw 에는 남는다). */
const CORP_SUFFIX_RE = /\(\s*주\s*\)|㈜|주식회사/g;

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * 로컬 날짜 키. **UTC 로 자르면 안 된다** — 한국 시간 오전 9시 이전이 전날로 잡혀
 * 장 시작 직후 기록이 하루 밀린다.
 */
export function todayLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 2자리 연도 → 4자리. MIN_YY 미만이거나 범위를 벗어나면 null(= 만기 아님). */
function expandYear(raw) {
  const y = parseInt(raw, 10);
  if (!Number.isFinite(y)) return null;
  if (raw.length <= 2) return y >= MIN_YY ? 2000 + y : null;
  return y >= 2000 && y <= 2099 ? y : null;
}

/** 매칭된 구간을 공백으로 치환. 원문(raw)은 건드리지 않고 작업 사본만 깎는다. */
function cut(text, m) {
  return m ? text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length) : text;
}

// ── ① 만기 ───────────────────────────────────────────────────────────────

/**
 * 만기 추출. 정확만기를 먼저 본다 — 연-월 패턴이 "26.11.20" 의 앞 두 토막만 먹어
 * ".20" 을 남기는 것을 막기 위함이다.
 * @returns {{ ym: string|null, date: string|null, rest: string }}
 */
function takeMaturity(text) {
  const md = text.match(MATURITY_DATE_RE);
  if (md) {
    const y = expandYear(md[1]);
    const mo = parseInt(md[2], 10);
    const d = parseInt(md[3], 10);
    if (y && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return { ym: `${y}-${pad2(mo)}`, date: `${y}-${pad2(mo)}-${pad2(d)}`, rest: cut(text, md) };
    }
  }
  for (const re of [MATURITY_YM_KO_RE, MATURITY_YM_SEP_RE]) {
    const m = text.match(re);
    if (!m) continue;
    const y = expandYear(m[1]);
    const mo = parseInt(m[2], 10);
    if (y && mo >= 1 && mo <= 12) return { ym: `${y}-${pad2(mo)}`, date: null, rest: cut(text, m) };
  }
  return { ym: null, date: null, rest: text };
}

// ── ②③④⑤ 나머지 필드 ──────────────────────────────────────────────────

/** 금액 → { amount, rest } */
function takeAmount(text) {
  const m = text.match(AMOUNT_RE);
  if (!m) return { amount: null, rest: text };
  const v = parseFloat(m[1]);
  return Number.isFinite(v) ? { amount: v, rest: cut(text, m) } : { amount: null, rest: text };
}

/** 금리 → { rate, rest }. ①② 가 지나간 뒤에만 호출해야 한다. */
function takeRate(text) {
  for (const re of [RATE_PCT_RE, RATE_BARE_RE]) {
    const m = text.match(re);
    if (!m) continue;
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) return { rate: v, rest: cut(text, m) };
  }
  return { rate: null, rest: text };
}

/** 등급 → { grade, rest }. 표기는 대문자로 정규화한다. */
function takeGrade(text) {
  const m = text.match(GRADE_RE);
  return m ? { grade: m[1].toUpperCase(), rest: cut(text, m) } : { grade: null, rest: text };
}

/** 종류 → { kind, rest }. KIND_PATTERNS 배열 순서가 우선순위다. */
function takeKind(text) {
  for (const { re, kind } of KIND_PATTERNS) {
    const m = text.match(re);
    if (m) return { kind, rest: cut(text, m) };
  }
  return { kind: null, rest: text };
}

/**
 * ⑥ 잔여물 정리 → 발행사 원형. 비면 null.
 *
 * ⚠️ **괄호는 지우지 않는다.** 구두점 목록에 `(` `)` 를 넣으면 "(주)국민은행" 이
 * "주 국민은행" 이 되어 `normalizeIssuer` 의 법인격 꼬리 제거가 통째로 무력화된다.
 * 앞 단계에서 내용물이 빠져나가 빈 껍데기만 남은 괄호쌍만 따로 접는다.
 */
function takeIssuer(text) {
  const t = String(text)
    .replace(STOPWORD_RE, ' ')
    .replace(/[,·|/\\[\]<>~＊*"']/g, ' ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t || null;
}

// ── 공개 API ─────────────────────────────────────────────────────────────

/**
 * 발행사명 정규화.
 *
 * ⚠️ **숫자를 제거하지 않는다.** `js/rv2-parser.js:252` 의 민평 잔여물 제거는
 * "숫자를 반드시 요구" 하는 형태여야 했고, 느슨하게 쓰면 "국민은행" 의 '민' 까지
 * 지워 "국 은행" 이 되는 함정이 있었다. ST-1 의 발행사명에는 숫자가 정보로 들어갈 수
 * 있고(예: `SK증권3`) 민평 표기가 섞이지도 않으므로, 여기서는 **법인격 꼬리와 공백만**
 * 정리한다. 약칭 사전은 Phase 1 범위가 아니다.
 */
export function normalizeIssuer(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const t = raw.replace(CORP_SUFFIX_RE, ' ').replace(/\s+/g, ' ').trim();
  return t || null;
}

/**
 * 호가 한 줄 → 기록 행 1개.
 *
 * **행은 반드시 반환한다.** 파싱에 실패한 필드는 null 로 두고 flags 에 남긴다 —
 * 버리면 무엇을 못 읽었는지 알 수 없고, 사전 확장의 피드백 루프가 끊긴다.
 * `raw` 는 어떤 경우에도 원문 그대로 보존한다.
 *
 * @param {string} line 호가 원문 한 줄
 * @param {{ date?: string, source?: string }} [opts] date 미지정 시 로컬 오늘
 * @returns {object} 행 스키마 (파일 상단 주석 참조)
 */
export function parseQuoteLine(line, opts = {}) {
  const raw = typeof line === 'string' ? line : '';
  const flags = [];

  const maturity = takeMaturity(raw);
  const amount = takeAmount(maturity.rest);
  const rate = takeRate(amount.rest);
  const grade = takeGrade(rate.rest);
  const kind = takeKind(grade.rest);
  const issuerRaw = takeIssuer(kind.rest);

  if (rate.rate == null) flags.push('no_rate');
  if (maturity.ym == null) flags.push('no_maturity');
  if (issuerRaw == null) flags.push('no_issuer');

  return {
    date: opts.date || todayLocal(),
    issuer: normalizeIssuer(issuerRaw),
    issuer_raw: issuerRaw,
    kind: kind.kind,
    grade: grade.grade,
    maturity_ym: maturity.ym,
    maturity_date: maturity.date,
    rate: rate.rate,
    amount: amount.amount,
    source: opts.source ?? null,
    raw,
    flags,
  };
}

/**
 * 중복 판정 키. 금리를 포함한다 — 같은 종목이라도 **레벨이 바뀌면 다른 기록**이다.
 * null 필드는 빈 문자열로 접어 키 자릿수를 고정한다.
 */
export function dedupeKey(row) {
  const f = (v) => (v == null ? '' : String(v));
  return [f(row.date), f(row.issuer), f(row.kind), f(row.grade), f(row.maturity_ym), f(row.rate)].join('|');
}

/**
 * dedupeKey 기준 병합. **멱등이다** — 같은 입력을 두 번 병합해도 added=0.
 * existing 을 변형하지 않고 새 배열을 돌려준다(순수 함수 원칙).
 *
 * incoming 내부의 중복도 함께 걷는다. 겹치는 구간을 재붙여넣기하는 것이 기본
 * 워크플로라, 여기서 안 걸면 붙여넣을 때마다 행이 이중 계상된다.
 *
 * @returns {{ rows: object[], added: number, skipped: number }}
 */
export function mergeRows(existing, incoming) {
  const base = Array.isArray(existing) ? existing : [];
  const seen = new Set(base.map(dedupeKey));
  const rows = [...base];
  let added = 0;
  let skipped = 0;
  for (const r of Array.isArray(incoming) ? incoming : []) {
    const k = dedupeKey(r);
    if (seen.has(k)) { skipped++; continue; }
    seen.add(k);
    rows.push(r);
    added++;
  }
  return { rows, added, skipped };
}
