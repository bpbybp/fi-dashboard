// rv2-buckets.js — RV-2 분류 계층 (Phase 2). 순수 함수, Node 테스트 가능.
//
// 정체: 오프셋(bp) 관측을 **비교 가능한 모집단으로 묶는다.** 랭킹 자체는 하지 않는다.
//       측정만 한다 — 표본이 부족하면 부족하다고 말하고 롤업할 뿐, 숨기지 않는다.
//
// ── 축 구성 (2026-08-05 승인) ────────────────────────────────────────────
//   1축(리프)   섹터. 아래 SECTOR_RULES 순서대로 첫 매칭. 공사·공단은 RWA 하위축을 갖는다.
//   2축(보조)   등급. 원문 명시 우선 → 발행사 역매핑 → 미상. 경로를 rating_basis 로 관측별 기록.
//   만기구간    연 단위 6격자. **리프 축이 아니다** — 사자 수요 패널과 분포 표시용.
//
// ── 왜 등급이 리프가 아닌가 ──────────────────────────────────────────────
//   2026-08-05 샘플에서 rankable 의 75.4%가 등급 미상이었다. 등급을 리프에 두면 리프의
//   71%가 `(등급미상)` 한 칸에 몰려 섹터 분해가 무의미해진다. Phase 0 보고 §6 결정 7.
//
// ── 사전을 채우는 원칙 (등급·RWA 공통) ───────────────────────────────────
//   **확신 없는 발행사는 넣지 않는다.** 미상 버킷은 정직한 측정이고, 틀린 값은 오염이다.
//   등급 미상이 많다는 사실 자체가 사용자가 알아야 할 신호다.

// ══════════════════════════════════════════════════════════════════════════
// 상수 — 임계값은 이 파일 한 곳에만 둔다
// ══════════════════════════════════════════════════════════════════════════

/** 표본 가드. 리프의 유효 관측(offset_bp 有)이 이 값 미만이면 상위로 롤업한다. */
export const RV2_MIN_BUCKET_SAMPLE = 8;

/** MAD 계수. 평균±표준편차 금지 — 소표본 강건성 때문이다. */
export const RV2_MAD_K = 2.5;

/** 만기 격자(연 단위). 채팅 원문이 "1.5년", "2~3년" 처럼 연 단위로 말한다. */
export const RV2_TENOR_GRID = [
  { key: '~1y', lo: 0, hi: 1 },
  { key: '1-2', lo: 1, hi: 2 },
  { key: '2-3', lo: 2, hi: 3 },
  { key: '3-5', lo: 3, hi: 5 },
  { key: '5-10', lo: 5, hi: 10 },
  { key: '10y+', lo: 10, hi: Infinity },
];

/**
 * 공사·공단 RWA 하위축 — 명령서 §2.2 확정 리스트 (2026-08-05 반영).
 *
 * **키는 정규화된 발행사명에 대한 부분 문자열이다.** 원문에 회차가 붙어 오기 때문에
 * (`도로공사978`, `한국전력1477`, `토지주택채권155`) 정확일치로는 하나도 못 잡는다.
 *
 * **분기는 섹터 우선이다.** RWA 세분화는 공사·공단 리프 안에서만 작동한다.
 * RWA0 의 산업은행·중소기업은행·수출입은행은 섹터상 **특은** 이라 여기 적혀 있어도
 * 공사 세분화에는 쓰이지 않는다 — 발행사 성격 기록용으로 남긴다(§2.2 주의사항).
 * 공사·공단 내 RWA0 실효 대상: 토지주택 · 장학재단 · 중벤공 · 주금공 · 자산관리공사 · 신보 · 기보.
 */
export const RWA0_ISSUERS = [
  '토지주택', '장학재단', '중벤공', '중소벤처기업진흥', '주택금융공사', '주금공',
  '자산관리공사', '신용보증기금', '기술보증기금',
  // ↓ 섹터상 특은. 공사 세분화에는 쓰이지 않는다(섹터 우선).
  '산업은행', '중소기업은행', '수출입',
];
export const RWA20_ISSUERS = [
  '한국전력', '한전', // rv-abbrev 가 "한전"→한국전력공사 로 확정한 동일 발행사
  '도로공사', '가스공사', '철도공사', '수자원공사',
  // 철도공사(코레일)와 **별개 발행사**다. 둘 다 RWA20 (2026-08-05 확인 회신).
  '국가철도공단', '철도공단',
];

/** 부분 문자열 매칭. `국가철도공단410`.includes('철도공사') 는 false — 다른 발행사다. */
const hasKey = (list, norm) => list.some((k) => norm.includes(k));

// ══════════════════════════════════════════════════════════════════════════
// 발행사 정규화 — 섹터 판정 전에 반드시 거친다
// ══════════════════════════════════════════════════════════════════════════

/**
 * `parseIssuerRaw` 결과에는 레벨·민평 잔여물이 붙어 온다.
 * 실측 예: `중금 언더4` / `SBS14-2 민평.964` / `아이비케이캐피탈355-5 민` /
 *          `27.1.5( 산금채 민평 3.169 100` / `수금은행 [만 3.127]`
 * 섹터 키워드 매칭 전에 이 꼬리를 걷어낸다. 완벽한 발행사명 복원이 목적이 아니라,
 * **키워드가 잔여물에 가려지지 않게 하는 것**이 목적이다.
 */
export function normalizeIssuer(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let t = raw;
  t = t.replace(/\[[^\]]*\]/g, ' ');            // [만 3.127]
  t = t.replace(/KR[A-Z0-9]{8,}/g, ' ');        // 표준코드
  t = t.replace(/언\s*더\s*\d+(?:\.\d+)?/g, ' ');
  t = t.replace(/오\s*[버바]\s*\d+(?:\.\d+)?/g, ' ');
  // 민평 잔여물. **숫자를 반드시 요구한다** — `\d*` 로 두면 `국민은행` 의 '민' 까지 지워
  // `국 은행` 이 되어 섹터 판정이 무너진다(실측으로 확인된 함정).
  // 끝전만 적는 `민평.964` 형태도 있어 선행 소수점을 허용한다.
  t = t.replace(/민\s*평?\s*[:：,~]?\s*(?:\d+(?:\.\d+)?|\.\d+)/g, ' '); // 민평3.112 / 민 3.61 / 민평.964
  t = t.replace(/(^|\s)민평?(?=\s|$)/g, ' ');   // 꼬리에 남은 단독 '민'·'민평'
  t = t.replace(/끝\s*전?\s*\.?\d*/g, ' ');
  t = t.replace(/쿠폰\s*\d+(?:\.\d+)?/g, ' ');
  t = t.replace(/\d{2,4}\.\d{1,2}\.?\d{0,2}/g, ' '); // 날짜 조각
  t = t.replace(/[~～][A-Z]{0,2}\d+/g, ' ');    // ~EB2
  t = t.replace(/\d+\s*억/g, ' ');
  t = t.replace(/[/(),:[\]]+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// ══════════════════════════════════════════════════════════════════════════
// 1축 — 섹터
// ══════════════════════════════════════════════════════════════════════════

/**
 * 순서가 규칙이다. 위에서부터 첫 매칭이 이긴다.
 * 앞선 규칙이 더 좁아야 한다 — 예: `국민주택`(국고)이 `국민은행`(시은)보다 먼저면 안 되고,
 * `지방은행`이 `시은`보다 먼저여야 `부산은행`이 시중계로 새지 않는다.
 */
export const SECTOR_RULES = [
  ['국고·통안', /국고|통안|재정증권|국민주택|국주|외평|국채/],
  ['지방채', /특별시|광역시|지역개발|지방채|도채권/],
  // 유동화·ABS — 분류만 하고 랭킹에서 뺀다(CP·CD·전단채와 동일 취급).
  // 구조화 상품이라 일반 채권과 같은 모집단에 두면 버킷 중앙값이 오염된다.
  ['유동화·ABS', /유동화|자산유동화|\bABS\b|ABSTB|\bSPC\b|제\s*\d+\s*차|제일차|제이차|제삼차/i],
  // 은행지주 — 은행채가 아니라 지주회사채다. 시은·특은 규칙보다 먼저 와야
  // `농협금융지주`·`신한지주` 가 은행 리프로 새지 않는다.
  ['은행지주', /금융지주|신한지주|KB금융|우리금융|하나금융|농협금융|BNK금융|DGB금융|JB금융/i],
  // 중벤공(중소벤처기업진흥공단)은 은행이 아니라 공단이다 — §2.2가 RWA0 실효 대상으로
  // 공사·공단에 두므로 특은에서 뺀다. 축약형 `중벤공` 은 공사·공단 규칙이 따로 잡는다.
  ['특은', /산금|산업은행|중금|기은|기업은행|수출입|농금|농협은행|농중|농협중앙회|수금|수협|정책금융/],
  ['지방은행', /부산은행|경남은행|대구은행|iM뱅크|아이엠뱅크|광주은행|전북은행|제주은행/i],
  ['시은-비시중계', /카카오뱅크|케이뱅크|토스뱅크/],
  // `국은채` 는 원문 축약이다. 만기 인접 민평 수준이 국민은행과 정합해 시중계로 본다.
  // 다만 **등급 역매핑은 하지 않는다** — 섹터는 거칠어도 되지만 등급은 틀리면 중앙값을 오염시킨다.
  ['시은-시중계', /국민은행|신한은행|하나은행|우리은행|SC제일|씨티은행|신한채|하나채|우리채|국민채|국은채/i],
  ['공사·공단', /공사|공단|한전|한국전력|철도|도로|토지주택|가스|수자원|주택도시|항만|교통|장학재단|예금보험|주금공|인도공|MBS|중벤공|보증기금|자산관리공사/i],
  ['여전-카드', /카드|롯카/],
  // 축약 표기가 많다: `IBK캐355-5`, `KB캐577-3`, `아이비캐`, `산은캐`. `캐피` 만으로는 안 잡힌다.
  ['여전-캐피탈', /캐피탈|캐피털|케피탈|캐피|커머셜|파이낸셜|에프앤아이|할부|여전|리스\b|IBK캐|KB캐|아이비캐|산은캐|우리캐|신한캐|하나캐|한투캐|키캐/i],
  ['증권채', /증권/],
];

/** 랭킹에서 제외되는 섹터(§4: 분류는 하되 랭킹 제외). 집계·중앙값 산출에서도 빠진다. */
export const RANKING_EXCLUDED_SECTORS = new Set(['CP·CD·전단채', '유동화·ABS']);

/**
 * 섹터 판정 → { sector, rwa, leaf, sector_basis }
 *   sector_basis: 'cp_cd' | 'matched' | 'default'(회사채로 떨어뜨림) | 'unknown'(발행사 자체가 없음)
 *   rwa: 공사·공단일 때만 'RWA0' | 'RWA20' | '기타', 그 외 null
 *   leaf: 리프 키. 공사·공단만 `공사·공단/RWA0` 형태가 된다.
 */
export function classifySector(quote) {
  const q = quote || {};
  if (q.is_cp_cd) return { sector: 'CP·CD·전단채', rwa: null, leaf: 'CP·CD·전단채', sector_basis: 'cp_cd' };

  const norm = normalizeIssuer(q.issuer_raw);
  if (!norm) return { sector: '분류미상', rwa: null, leaf: '분류미상', sector_basis: 'unknown' };

  for (const [sector, re] of SECTOR_RULES) {
    if (!re.test(norm)) continue;
    if (sector !== '공사·공단') return { sector, rwa: null, leaf: sector, sector_basis: 'matched' };
    const rwa = hasKey(RWA0_ISSUERS, norm) ? 'RWA0' : hasKey(RWA20_ISSUERS, norm) ? 'RWA20' : '기타';
    return { sector, rwa, leaf: `공사·공단/${rwa}`, sector_basis: 'matched' };
  }
  // 키워드에 안 걸리면 일반 사업회사로 본다. 다만 '추정'임을 basis 로 남긴다.
  return { sector: '회사채', rwa: null, leaf: '회사채', sector_basis: 'default' };
}

// ══════════════════════════════════════════════════════════════════════════
// 2축 — 등급
// ══════════════════════════════════════════════════════════════════════════

/**
 * 발행사 → 대표등급 역매핑. **정부보증·특은(AAA 확정군)부터 시작해 픽스처 등장 순으로 채운다.**
 * 키는 `normalizeIssuer` 결과에 대해 **부분 문자열 포함**으로 본다(발행사명 뒤에 회차가 붙으므로).
 *
 * ⚠ 여기 넣는 기준은 "거의 확실한가" 하나다. 등급이 갈리거나 시점에 따라 움직이는 발행사는
 *   **비워 두고 등급미상으로 남긴다.** 틀린 등급은 버킷 중앙값을 오염시키지만,
 *   등급미상은 그저 "모른다"일 뿐이다.
 */
export const ISSUER_RATING_MAP = [
  // ── 국책·특수은행 (정부계, AAA 확정군) ──
  ['산업은행', 'AAA'], ['산금', 'AAA'],
  ['기업은행', 'AAA'], ['중금', 'AAA'],
  ['수출입', 'AAA'],
  ['농협은행', 'AAA'], ['농금', 'AAA'],
  ['수협은행', 'AAA'], ['수금', 'AAA'],
  ['중소벤처기업진흥', 'AAA'], ['중벤공', 'AAA'],
  // ── 시중은행 (은행채 AAA) ──
  ['국민은행', 'AAA'], ['신한은행', 'AAA'], ['하나은행', 'AAA'], ['우리은행', 'AAA'],
  // ── 정부계 공사·공단 (AAA 확정군) ──
  ['한국전력', 'AAA'], ['한전', 'AAA'],
  ['한국도로공사', 'AAA'], ['도로공사', 'AAA'],
  ['한국토지주택', 'AAA'], ['토지주택', 'AAA'],
  ['한국가스공사', 'AAA'], ['가스공사', 'AAA'],
  ['국가철도공단', 'AAA'], ['철도공단', 'AAA'],
  ['한국주택금융공사', 'AAA'], ['주금공', 'AAA'],
  // 이하 픽스처 등장 순으로 확신 있는 것만 추가한다.
];

/** 등급 축 자체가 적용되지 않는 섹터. 국채는 신용등급 개념이 없다 — 미상과 구분해야 한다. */
export const RATING_NOT_APPLICABLE_SECTORS = new Set(['국고·통안']);

/**
 * 등급 해석 → { rating, rating_basis }
 *   'explicit'        원문에 등급이 찍혀 있었다 (parseRating 결과)
 *   'issuer_mapped'   발행사 역매핑으로 복구했다
 *   'not_applicable'  등급 축 비적용(국고·통안). **미상이 아니다** — 섞으면 "복구 못 한 것"
 *                     처럼 보여 등급미상 비율을 부풀린다
 *   'unknown'         모른다 — 숨기지 않고 '등급미상' 으로 남긴다
 * @param {object} quote
 * @param {string} [sector] 미지정 시 내부에서 판정한다(단독 호출 편의).
 */
export function resolveRating(quote, sector) {
  const q = quote || {};
  const sec = sector || classifySector(q).sector;
  if (RATING_NOT_APPLICABLE_SECTORS.has(sec)) return { rating: null, rating_basis: 'not_applicable' };
  if (q.rating) return { rating: q.rating, rating_basis: 'explicit' };
  const norm = normalizeIssuer(q.issuer_raw);
  if (norm) {
    for (const [key, rating] of ISSUER_RATING_MAP) {
      if (norm.includes(key)) return { rating, rating_basis: 'issuer_mapped' };
    }
  }
  return { rating: null, rating_basis: 'unknown' };
}

// ══════════════════════════════════════════════════════════════════════════
// 만기 격자 (리프 축 아님 — 수요 패널·분포 표시용)
// ══════════════════════════════════════════════════════════════════════════

export function residualYears(maturityDate, todayStr) {
  if (!maturityDate || !todayStr) return null;
  const ms = new Date(`${maturityDate}T00:00:00`) - new Date(`${todayStr}T00:00:00`);
  const y = ms / (365.25 * 864e5);
  return Number.isFinite(y) ? y : null;
}

/** 잔존연수 → 격자 key. 음수(과거 만기)는 null — 격자에 올리지 않는다. */
export function tenorBucketFromYears(ry) {
  if (ry == null || ry < 0) return null;
  for (const g of RV2_TENOR_GRID) if (ry >= g.lo && ry < g.hi) return g.key;
  return null;
}

export function tenorBucket(maturityDate, todayStr) {
  return tenorBucketFromYears(residualYears(maturityDate, todayStr));
}

// ══════════════════════════════════════════════════════════════════════════
// 집계 + 표본 가드
// ══════════════════════════════════════════════════════════════════════════

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 중앙값절대편차. 평균±표준편차를 쓰지 않는 이유는 소표본에서 이상치 1건이 기준을 흔들기 때문. */
export function mad(values) {
  const med = median(values);
  if (med == null) return null;
  return median(values.map((v) => Math.abs(v - med)));
}

/** 관측 1건 → 축 라벨 부착. offset_bp 는 그대로 둔다(여기서 값을 바꾸지 않는다). */
export function annotate(quote, todayStr) {
  const sec = classifySector(quote);
  const rat = resolveRating(quote, sec.sector);
  return {
    ...sec,
    rating: rat.rating,
    rating_basis: rat.rating_basis,
    tenor: tenorBucket(quote.maturity_date, todayStr),
    rankable: quote.offset_bp != null && !RANKING_EXCLUDED_SECTORS.has(sec.sector),
    q: quote,
  };
}

/**
 * 리프 집계 + 표본 가드.
 *
 * **가드 판정은 offset_bp 유효 관측 기준이다** — 미상은 세지 않는다. 미상을 세면
 * "표본이 있다"고 오인하게 된다. 다만 미상 건수는 버려지지 않고 리프별로 함께 보고된다(§6.2).
 *
 * 롤업 순서: 리프(공사·공단/RWA) → 섹터 → 세션 전체.
 * @returns {{ leaves, sectors, session, rows, stats }}
 */
export function buildBuckets(quotes, { todayStr, minSample = RV2_MIN_BUCKET_SAMPLE, madK = RV2_MAD_K } = {}) {
  const rows = (quotes || []).map((q) => annotate(q, todayStr));

  const leaves = new Map();
  const sectors = new Map();
  const touch = (map, key) => {
    if (!map.has(key)) map.set(key, { key, values: [], missing: 0, n: 0 });
    return map.get(key);
  };

  for (const r of rows) {
    if (RANKING_EXCLUDED_SECTORS.has(r.sector)) continue; // 분류만, 집계 제외
    const L = touch(leaves, r.leaf);
    const S = touch(sectors, r.sector);
    if (r.q.offset_bp == null) { L.missing++; S.missing++; continue; }
    L.values.push(r.q.offset_bp);
    S.values.push(r.q.offset_bp);
  }

  const finish = (b) => {
    b.n = b.values.length;
    b.median = median(b.values);
    b.mad = mad(b.values);
    return b;
  };
  for (const b of leaves.values()) finish(b);
  for (const b of sectors.values()) finish(b);

  const sessionValues = rows
    .filter((r) => !RANKING_EXCLUDED_SECTORS.has(r.sector) && r.q.offset_bp != null)
    .map((r) => r.q.offset_bp);
  const session = finish({ key: '세션', values: sessionValues, missing: 0, n: 0 });

  // 각 관측에 적용될 기준 중앙값 결정 — 리프 → 섹터 → 세션
  for (const r of rows) {
    if (RANKING_EXCLUDED_SECTORS.has(r.sector)) { r.medianUsed = null; r.medianSource = '제외'; continue; }
    const L = leaves.get(r.leaf), S = sectors.get(r.sector);
    if (L && L.n >= minSample) { r.medianUsed = L.median; r.medianSource = '리프'; }
    else if (S && S.n >= minSample) { r.medianUsed = S.median; r.medianSource = '섹터롤업'; }
    else if (session.n) { r.medianUsed = session.median; r.medianSource = '세션롤업'; }
    else { r.medianUsed = null; r.medianSource = '없음'; }
    r.adjustedOffset = (r.q.offset_bp != null && r.medianUsed != null) ? r.q.offset_bp - r.medianUsed : null;
    // 이상치 게이트 — |관측 − 중앙값| > k·MAD. 제외가 아니라 표시가 목적이다.
    const ref = (L && L.n >= minSample) ? L : (S && S.n >= minSample) ? S : session;
    r.outlier = (r.q.offset_bp != null && ref && ref.mad != null && ref.mad > 0)
      ? Math.abs(r.q.offset_bp - ref.median) > madK * ref.mad : false;
  }

  const arr = [...leaves.values()];
  const stats = {
    leaves: arr.length,
    leavesUnderGuard: arr.filter((b) => b.n < minSample).length,
    observationsUnderGuard: arr.filter((b) => b.n < minSample).reduce((s, b) => s + b.n, 0),
    rollupLeaf: rows.filter((r) => r.medianSource === '리프').length,
    rollupSector: rows.filter((r) => r.medianSource === '섹터롤업').length,
    rollupSession: rows.filter((r) => r.medianSource === '세션롤업').length,
    ratingBasis: rows.reduce((a, r) => { a[r.rating_basis] = (a[r.rating_basis] || 0) + 1; return a; }, {}),
    sectorBasis: rows.reduce((a, r) => { a[r.sector_basis] = (a[r.sector_basis] || 0) + 1; return a; }, {}),
  };

  return { leaves, sectors, session, rows, stats };
}
