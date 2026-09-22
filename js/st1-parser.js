// st1-parser.js — ST-1 호가 기록 파서 (Phase 1).
//
// 정체: 단기물(CP·예담·전단채·ABSTB)과 채권(회사채·은행채·공사채·여전채·지방채)
//       호가 한 줄 → **기록용 행 1개**.
//       측정도 판단도 하지 않는다. 여기서 하는 일은 토큰을 뽑아 스키마에 담는 것뿐이다.
//
// ── 등급 체계가 둘이다 ───────────────────────────────────────────────────
//   단기 체계(A1·A2±·A3±)와 장기 체계(AAA·AA±·A±·BBB±…)를 **한 열(grade)에 담고**,
//   어느 체계인지는 `grade_scale`('st'|'lt'|null) 에 따로 남긴다. 열을 둘로 쪼개면
//   기존 원장 행이 전부 한쪽만 채운 반쪽 행이 되고, 필터·차트가 두 열을 매번 합쳐야 한다.
//   `B`·`B+`·`B-`·`C`·`D` 는 **두 체계에 똑같은 글자로 존재한다** — 이 겹침만
//   문맥(종류 토큰)을 봐야 풀리고, 나머지 토큰은 글자만으로 체계가 정해진다.
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
//   ⚠️ **④ 는 ⑤ 를 미리 본다(peek).** 겹치는 등급 글자(B·C·D)의 체계를 가르려면
//   종류 토큰이 필요한데, ⑤ 를 ④ 앞으로 옮기면 `cut` 연쇄가 통째로 바뀐다.
//   그래서 `matchKind` 로 **자르지 않고** 조회만 하고, 실제 절단은 ⑤ 에서 한다.
//   peek 과 ⑤ 의 결과는 항상 같다 — 등급 매치는 룩어라운드 때문에 종류 토큰 안쪽에
//   걸릴 수 없어서, ④ 의 절단이 종류 토큰을 건드리지 못한다.
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
 * 등급 — 장기·단기 두 체계를 한 정규식에 담는다. 대소문자 무시.
 *
 * ⚠️ **교대문 순서가 곧 "긴 것 우선" 규칙이다.** 정규식 교대는 각 위치에서 왼쪽부터
 * 시도하므로 `AA` 를 `AAA`·`AA+`·`AA0`·`AA-` 보다 앞에 두면 "AA+" 가 "AA" 로 잘린다.
 * 길이순이 아니라 **접두 포함순** 정렬이라는 점이 중요하다 — `BBB` 계열이 `BB` 계열보다
 * 먼저 와야 "BBB+" 가 "BB" 로 잘리고 남은 "B+" 가 다시 등급으로 새지 않는다.
 *
 * 앞뒤 룩어라운드가 핵심이다. 이게 없으면 한 글자 등급(B·C·D)이 **`ABSTB` 의 B**,
 * **`CP` 의 C** 에 걸린다. 한글은 경계로 인정한다 — "예담CP" 의 C 는 앞이 '담' 이라
 * 룩비하인드를 통과하지만 뒤의 'P' 가 룩어헤드에서 막힌다.
 *
 * ⚠️ **단독 `A` 는 넣지 않는다.** 장기 체계에 A 등급이 있긴 하지만, 한 글자 A 를
 * 인정하면 영문 상호·약칭의 A 가 전부 등급이 된다. 부호가 붙은 `A+`·`A0`·`A-` 만 받고,
 * 부호 없는 A 는 `BARE_A_RE` 로 따로 감지해 `ambiguous_grade` 플래그만 남긴다.
 */
const GRADE_RE = /(?<![A-Za-z0-9])(AAA|AA\+|AA0|AA-|AA|A\+|A0|A-|BBB\+|BBB0|BBB-|BBB|BB\+|BB0|BB-|BB|A1|A2\+|A2-|A2|A3\+|A3-|A3|B\+|B0|B-|B|CCC|CC|C|D)(?![A-Za-z0-9])/i;

/**
 * 부호 없는 단독 `A`. **등급을 못 잡았을 때만** 본다 — 잡았다면 그 A 는 이미 등급의 일부다.
 * 경계 규약이 GRADE_RE 와 같아서 "A1" 의 A·"AA" 의 A 에는 걸리지 않는다.
 */
const BARE_A_RE = /(?<![A-Za-z0-9])A(?![A-Za-z0-9])/i;

/**
 * 부호 없이 오면 "0"(중간등급)을 붙이는 장기 등급. `AAA` 는 애초에 부호가 없는 등급이라
 * 여기 들어가지 않는다. "AA" 와 "AA0" 는 **같은 등급의 다른 표기**라 한쪽으로 접는다 —
 * 안 접으면 dedupeKey 가 갈려 같은 호가가 두 줄로 남는다.
 */
const ZERO_SUFFIX_GRADES = new Set(['AA', 'BBB', 'BB']);

/** 단기 체계에만 있는 등급. 글자만으로 체계가 정해진다. */
const ST_ONLY_GRADES = new Set(['A1', 'A2+', 'A2', 'A2-', 'A3+', 'A3', 'A3-']);

/**
 * **두 체계에 같은 글자로 존재하는 등급.** 이것들만 문맥(종류 토큰)을 봐야 풀린다.
 * 나머지(AAA·AA±·A±·BBB±·BB±·B0·CCC·CC)는 장기 체계에만 있다.
 */
const SHARED_GRADES = new Set(['B+', 'B', 'B-', 'C', 'D']);

/** 단기 체계로 확정짓는 종류. */
const ST_KINDS = new Set(['CP', '예담', '전단채', 'ABSTB']);

/** 채권 종류의 단일 이름. 세부는 `sector` 열이 진다. */
const BOND_KIND = '채권';

/**
 * 종류 — **우선순위 배열 순서대로 탐색**한다. 정규식 하나에 `|` 로 묶으면 문자열에서
 * 먼저 나오는 쪽이 이겨서 "예담CP" 가 위치에 따라 CP 로 갈릴 수 있다. 목록 순서가
 * 곧 "긴 것 우선" 이므로 배열로 둔다.
 *
 * 채권 계열은 단기물 뒤에 붙는다. 종류는 `'채권'` 하나로 접고 세부는 `sector` 로 가른다 —
 * 발행 형식(채권이냐 CP냐)과 크레딧 성격(은행이냐 여전이냐)은 다른 축이고, 한 열에 섞으면
 * "은행채" 와 "예담"(실질 은행 크레딧)을 나란히 놓을 수 없다.
 * 배열 안에서도 "카드채" 가 "채권" 보다 먼저다 — 같은 긴 것 우선 규칙이다.
 */
const KIND_PATTERNS = [
  { re: /예\s*담\s*CP/i, kind: '예담' },
  { re: /전단채/, kind: '전단채' },
  { re: /(?<![A-Za-z])ABSTB(?![A-Za-z])/i, kind: 'ABSTB' },
  { re: /예\s*담/, kind: '예담' },
  { re: /전단/, kind: '전단채' },
  { re: /(?<![A-Za-z])STB(?![A-Za-z])/i, kind: 'ABSTB' },
  { re: /(?<![A-Za-z])CP(?![A-Za-z])/i, kind: 'CP' },
  { re: /회사채/, kind: BOND_KIND, sector: '회사채' },
  { re: /은행채/, kind: BOND_KIND, sector: '은행채' },
  { re: /공사채/, kind: BOND_KIND, sector: '공사채' },
  { re: /특수채/, kind: BOND_KIND, sector: '공사채' },
  { re: /여전채/, kind: BOND_KIND, sector: '여전채' },
  { re: /카드채/, kind: BOND_KIND, sector: '여전채' },
  { re: /캐피탈채/, kind: BOND_KIND, sector: '여전채' },
  { re: /지방채/, kind: BOND_KIND, sector: '지방채' },
  { re: /채권/, kind: BOND_KIND, sector: null },
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

/**
 * 등급 표기 정규화. 대문자로 접고, 부호 없는 장기 등급에 "0" 을 붙인다.
 * `AA` → `AA0`, `BBB` → `BBB0`. `AAA`·`A+`·`A1` 은 그대로.
 *
 * 화면 입력 경로(`js/st1-ui.js` 의 rowFromPreview)도 이 함수를 쓴다 — 표기 규약의
 * 단일 근원이다. 손으로 "AA" 를 치고 파서가 "AA0" 을 내면 dedupeKey 가 갈린다.
 */
export function normalizeGrade(token) {
  const g = String(token).toUpperCase();
  return ZERO_SUFFIX_GRADES.has(g) ? `${g}0` : g;
}

/** 등급 → { grade, rest }. 표기는 `normalizeGrade` 로 접는다. */
function takeGrade(text) {
  const m = text.match(GRADE_RE);
  return m ? { grade: normalizeGrade(m[1]), rest: cut(text, m) } : { grade: null, rest: text };
}

/**
 * 종류 조회 — **자르지 않는다.** takeKind 와 peek 가 공유하는 단일 근원이다.
 * @returns {{ kind: string|null, sector: string|null, m: RegExpMatchArray|null }}
 */
function matchKind(text) {
  for (const { re, kind, sector } of KIND_PATTERNS) {
    const m = text.match(re);
    if (m) return { kind, sector: sector ?? null, m };
  }
  return { kind: null, sector: null, m: null };
}

/** 종류 → { kind, sector, rest }. KIND_PATTERNS 배열 순서가 우선순위다. */
function takeKind(text) {
  const { kind, sector, m } = matchKind(text);
  return { kind, sector, rest: m ? cut(text, m) : text };
}

/**
 * 등급 체계 판정 — `grade_scale`.
 *
 * 글자만으로 갈리는 등급이 대부분이고, 겹치는 다섯 글자(B±·B·C·D)만 종류를 본다.
 * 종류도 없으면 **장기로 둔다**: ST-1 원장에서 B 이하 단기등급은 사실상 거래되지 않아
 * 그 글자가 나왔다면 장기 채권일 확률이 압도적이다. 다만 추측이라는 사실은 남긴다.
 *
 * @param {string|null} grade  normalizeGrade 를 거친 등급
 * @param {string|null} kind   같은 줄에서 **미리 본(peek)** 종류
 * @returns {{ scale: 'st'|'lt'|null, guessed: boolean }}
 */
function resolveGradeScale(grade, kind) {
  if (grade == null) return { scale: null, guessed: false };
  if (ST_ONLY_GRADES.has(grade)) return { scale: 'st', guessed: false };
  if (!SHARED_GRADES.has(grade)) return { scale: 'lt', guessed: false };
  if (ST_KINDS.has(kind)) return { scale: 'st', guessed: false };
  if (kind === BOND_KIND) return { scale: 'lt', guessed: false };
  return { scale: 'lt', guessed: true };
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
 * flags 어휘(이 순서로 쌓인다):
 *   ambiguous_grade      부호 없는 단독 A 가 잔여물에 남았다. 등급인지 상호인지 못 가른다.
 *   grade_scale_guessed  겹치는 등급 글자인데 종류 토큰이 없어 체계를 추측했다.
 *   kind_inferred        장기 등급만 보고 종류를 '채권' 으로 지었다. 섹터는 짓지 않는다.
 *   no_rate · no_maturity · no_issuer   해당 필드를 못 읽었다.
 *
 * ⚠️ **기존 원장 행 호환**: Phase 1 이전에 적힌 행에는 `sector`·`grade_scale` 이 아예 없다.
 * 파일 마이그레이션은 하지 않는다 — 두 필드를 읽는 쪽이 `?? null` 로 접는 것이 규약이고,
 * `dedupeKey` 는 없는 필드를 빈 문자열로 접어 키가 바뀌지 않는다.
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

  // ④ 가 ⑤ 를 미리 본다 — 조회만 하고 자르지 않는다(파일 상단 "추출 순서" 참조).
  const peeked = matchKind(rate.rest);
  const grade = takeGrade(rate.rest);
  const scale = resolveGradeScale(grade.grade, peeked.kind);

  const kind = takeKind(grade.rest);
  const issuerRaw = takeIssuer(kind.rest);

  // 장기 등급만 있고 종류 토큰이 없으면 채권으로 본다. 섹터까지 지어내지는 않는다.
  const inferKind = scale.scale === 'lt' && kind.kind == null;
  // 등급을 못 잡았는데 잔여물에 홀로 남은 A — 등급인지 상호의 일부인지 여기서는 못 가른다.
  const ambiguousA = grade.grade == null && issuerRaw != null && BARE_A_RE.test(issuerRaw);

  if (ambiguousA) flags.push('ambiguous_grade');
  if (scale.guessed) flags.push('grade_scale_guessed');
  if (inferKind) flags.push('kind_inferred');
  if (rate.rate == null) flags.push('no_rate');
  if (maturity.ym == null) flags.push('no_maturity');
  if (issuerRaw == null) flags.push('no_issuer');

  return {
    date: opts.date || todayLocal(),
    issuer: normalizeIssuer(issuerRaw),
    issuer_raw: issuerRaw,
    kind: inferKind ? BOND_KIND : kind.kind,
    sector: inferKind ? null : kind.sector,
    grade: grade.grade,
    grade_scale: scale.scale,
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
 *
 * `sector` 는 **맨 뒤에 붙인다.** 필드가 아예 없는 기존 원장 행은 `undefined` 라
 * 같은 규칙으로 빈 문자열이 되고, sector=null 인 신규 행과 키가 정확히 일치한다.
 * 중간에 끼워 넣으면 자릿수가 밀려 기존 행이 전부 새 행으로 계상된다.
 *
 * `grade_scale` 은 **넣지 않는다.** 체계는 등급 글자에서 유도되는 값이라 키에 넣어봐야
 * 같은 호가를 가르기만 한다 — 겹치는 글자(B·C·D)의 체계 추정이 흔들리면 그때마다
 * 같은 행이 새 행으로 들어온다.
 */
export function dedupeKey(row) {
  const f = (v) => (v == null ? '' : String(v));
  return [
    f(row.date), f(row.issuer), f(row.kind), f(row.grade),
    f(row.maturity_ym), f(row.rate), f(row.sector),
  ].join('|');
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
