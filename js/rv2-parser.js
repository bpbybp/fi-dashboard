// rv2-parser.js — RV-2 케이본드 호가 랭킹 스크리너 파서 (Phase 1).
//
// 정체: **매수자 관점 오퍼 랭킹**의 입력을 만든다. 벤치마크는 커브가 아니라 **민평 대비 오프셋(bp)**.
//       만기 정규화는 민평이 흡수하므로 커브 피팅·보간은 하지 않는다.
//       측정만 한다 — 싸다/비싸다 판단, 추천, 시그널 없음.
//
// ── 부호 규약 (전 계층 단일 근원) ────────────────────────────────────────
//   offset_bp = (호가수익률 − 민평수익률) × 100
//   **+오프셋 = 민평 대비 높은 수익률 = 싸게 나온 오퍼** (랭킹은 내림차순)
//   따라서 언더N = −N bp (민평보다 낮은 수익률 = 비싸게 팜), 오버N = +N bp.
//   ⚠ 명령서 §1.4 규칙 1의 예시("3.608 팔자 (민 3.610) → +0.2bp")는 부호 오기다.
//     (3.608−3.610)×100 = −0.2bp 가 맞고, 이것이 규칙 2·§3.2 랭킹 의미론과 일관된다.
//     Phase 0 보고 §6.1 참조. 구현은 **공식**을 따른다.
//
// ── rv-parser.js 와의 관계 ───────────────────────────────────────────────
//   RV-1의 `js/rv-parser.js`(Fenrir kbond.js 이식본)는 **불변**이다. 테스트가 없어 직접 수정 시
//   RV-1 회귀 위험이 크다. 이 모듈은 그 추출기들을 import 해 쓰는 래퍼이며,
//   **호출 이전에 프리패스**를 두어 RV-1이 RV-2 용도로 갖는 두 결함을 우회한다:
//
//     (A) NON_INDIVIDUAL_RE 가 "1.5년 특은 사자" 류를 버린다 → RV-2에선 이게 수요 신호다.
//         → 프리패스가 `demand` 레인으로 분기한다.
//     (B) SYSTEM_MESSAGE_RE 가 존댓말형 '입장하셨습니다'를 놓친다. 단순 누락이 아니라,
//         parseKbondLog 의 멀티라인 병합(rv-parser.js:38)이 그 라인을 **직전 호가에 붙여 오염**시킨다.
//         → 프리패스가 parseKbondLog 호출 이전, 원문 라인 단위로 제거한다.
//
//   rv-parser 가 제공하지 않아 여기서 신규 구현하는 것: 언더N, 체결마커(동·동통·대치), 수량, offset_bp.
//   (언더N 은 RV-1에도 갭이지만 rv-parser 수정은 별건 백로그 B-1 — 이 모듈은 자체 처리한다.)
//
//   DI: parseKbondQuotes(통합 파서) 대신 **개별 추출기**를 직접 조립한다. 통합 파서는 내부에서
//       NON_INDIVIDUAL_RE·CP/CD 로 선제 배제하는데, RV-2는 그 라인들을 버리지 않고 분류해야 하므로
//       (§4: CP/CD는 파싱·분류하되 랭킹만 제외) 단일 경로로 조립하는 편이 누수가 없다.

import {
  parseKbondLog,
  parseMaturity,
  parseSide,
  parseMinpyeong,
  parseSpread,
  parseRating,
  parseActualYield,
  parseIssuerRaw,
  parseTags,
  parseBroker,
} from './rv-parser.js';

// ── 상수 (임계값·패턴은 이 파일 한 곳에만) ──────────────────────────────

/** 입·퇴장 시스템 메시지. rv-parser 의 SYSTEM_MESSAGE_RE 와 달리 존댓말형을 포함한다(§2.2-B). */
export const RV2_SYSTEM_RE = /(?:입장|퇴장)하(?:셨|였)습니다/;

/** CP·CD·전단채 — rv-parser.js:12 의 CP_CD_RE 미러(미export). §4: 분류는 하되 랭킹 제외. */
export const RV2_CP_CD_RE = /\bCP\b|\bCD\b|알전단|\bCMA\b|전단채|ABSTB/i;

/** 구간 수요 표현 — "1.5년 특은 사자", "2~3년 매수관심" 류(§3.3). */
export const RV2_PERIOD_RE = /\d+\s*[~\-–]\s*\d+\s*년|\d+(?:\.\d+)?\s*년|\d+\s*개월|이내|이후|잔존|연내|저쿠폰|매수관심|사자관심/;

/** 언더N — rv-parser.parseSpread 가 처리하지 않는다(오버만 구현). 없으면 "언더4"가 flat 0 으로 오인된다. */
export const RV2_UNDER_RE = /언\s*더\s*(\d+(?:\.\d+)?)/;
/** 오버N — 기저 파서와 동일 범위('오바' 오타 포함). basis 라벨 구분을 위해 별도로 읽는다. */
export const RV2_OVER_RE = /오\s*[버바]\s*(\d+(?:\.\d+)?)/;

/**
 * 명시적 "민평에 판다" 표현(§1.4 규칙 3). rv-parser.parseSpread 는 마지막 폴백에서
 * **팔자/사자가 있기만 하면** flat 0 을 돌려준다(rv-parser.js:159). 그대로 믿으면
 * "도로공사975 팔자"처럼 레벨이 없는 라인에까지 offset 0 이 붙는다 — 반드시 여기서 재확인한다.
 */
export const RV2_FLAT_RE = /민평?\s*(?:팔자|사자)|플랫|\bflat\b|\.\.(?:팔자|사자)/i;

/** 수량 — "100억", "50억*5장", "50억*2". */
export const RV2_VOLUME_RE = /(\d+(?:\.\d+)?)\s*억(?:\s*[*x×]\s*(\d+)\s*장?)?/;

/**
 * 민평 표기 이형 폴백(B-7). rv-parser 의 `parseMinpyeong` 은 `민 3.610`·`민3.517` 만 읽고
 * **`민평 3.242` / `민:3.957%` / `민평3.112` / `민,3.945` 를 놓친다** — 픽스처 198건.
 * rv-parser 는 불변이므로 여기서 보충한다(언더N 과 같은 구조).
 *
 * `(?<![가-힣])` 가 핵심이다. 이게 없으면 "국민 3.05 팔자" 의 `민`이 걸린다.
 * 기저 파서는 이 가드가 없지만, 폴백은 **기저가 실패했을 때만** 도는 만큼 더 엄격하게 간다.
 */
export const RV2_MINPYEONG_FALLBACK_RE = /(?<![가-힣])민\s*평?\s*[:：,~～]?\s*(\d+\.\d{2,4})/;

/**
 * 명시 수익률 폴백(B-8). 기저 `parseActualYield` 는 `(\d+\.\d+)%?\s+(?:팔자|사자|…)` 로
 * **공백을 필수**로 요구해 `3.602팔자` 를 놓친다 — 픽스처 43건.
 * 기저와 같은 전처리(민/민평 괄호 제거)를 거친 뒤 공백 없는 형태만 추가로 잡는다.
 */
export const RV2_YIELD_NOSPACE_RE = /(\d+\.\d+)%?(?:팔자|사자|매도|매수)/;
const RV2_MINPYEONG_PAREN_RE = /[(\[](민|민평)[^)\]]*[)\]]/g;

const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

// ── 프리패스 ─────────────────────────────────────────────────────────────

/**
 * 원문 라인 단위 1차 정리. **parseKbondLog 호출 이전에** 돌아야 한다 —
 * 멀티라인 병합이 시스템 메시지를 직전 호가에 붙이기 전에 걷어내는 것이 목적(§2.2-B).
 * @returns {{ text: string, stats: {total_lines, system_messages, empty_lines} }}
 */
export function prepass(rawText) {
  const lines = String(rawText ?? '').split('\n');
  const stats = { total_lines: lines.length, system_messages: 0, empty_lines: 0 };
  const kept = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) { stats.empty_lines++; continue; }
    if (RV2_SYSTEM_RE.test(t)) { stats.system_messages++; continue; }
    kept.push(t);
  }
  return { text: kept.join('\n'), stats };
}

// ── 필드 추출기 (rv-parser 가 제공하지 않는 것들) ────────────────────────

/**
 * 체결마커(§1.5) → 'traded' | 'matched_market' | 'quote'.
 * '동'은 **단독 토큰일 때만** 인정한다 — 동양·부동산·동일 등 오탐을 막기 위함.
 */
export function parseTradeStatus(content) {
  if (!content || typeof content !== 'string') return 'quote';
  if (/(?:^|[\s,(])대치(?:[\s,)]|$)/.test(content)) return 'matched_market';
  if (/(?:^|[\s,(])동통(?:[\s,)]|$)/.test(content)) return 'traded';
  if (/(?:^|[\s,(])동(?:[\s,)]|$)/.test(content)) return 'traded';
  if (/거래완료|체결/.test(content)) return 'traded';
  if (/(?:^|[\s,(])거래(?:[\s,)]|$)/.test(content)) return 'traded';
  return 'quote';
}

/** 수량(§1.3) → { unit_eok, lots, total_eok, raw } | null */
export function parseVolume(content) {
  if (!content || typeof content !== 'string') return null;
  const m = content.match(RV2_VOLUME_RE);
  if (!m) return null;
  const unit = parseFloat(m[1]);
  if (!Number.isFinite(unit)) return null;
  const lots = m[2] ? parseInt(m[2], 10) : 1;
  return { unit_eok: unit, lots, total_eok: round2(unit * lots), raw: m[0].trim() };
}

/**
 * 민평 — 기저 파서 우선, 실패 시 표기 이형 폴백(B-7).
 * 끝전은 기저가 성공했을 때만 나온다. 폴백 경로에서는 기저의 끝전 패턴을 재사용할 수 없어
 * (`parseMinpyeong` 이 수익률 매칭 위치를 기준으로 끝전을 찾기 때문) `끝.NN`·`끝전 : N` 만 본다.
 * @returns {{ yield: number, kkeutjeon: number|null, basis: 'base'|'fallback' } | null}
 */
export function parseMinpyeongRv2(content) {
  const base = parseMinpyeong(content);
  if (base && base.yield != null) return { ...base, basis: 'base' };
  if (!content || typeof content !== 'string') return null;
  const m = content.match(RV2_MINPYEONG_FALLBACK_RE);
  if (!m) return null;
  const y = parseFloat(m[1]);
  if (!Number.isFinite(y)) return null;
  let kkeutjeon = null;
  const kk = content.match(/끝전?\s*[:：]?\s*\.?(\d+)/);
  if (kk) kkeutjeon = parseFloat('0.' + kk[1]);
  return { yield: y, kkeutjeon, basis: 'fallback' };
}

/** 명시 수익률 — 기저 파서 우선, 실패 시 공백 없는 형태 폴백(B-8). */
export function parseActualYieldRv2(content) {
  const base = parseActualYield(content);
  if (base != null) return base;
  if (!content || typeof content !== 'string') return null;
  const cleaned = content.replace(RV2_MINPYEONG_PAREN_RE, '');
  const m = cleaned.match(RV2_YIELD_NOSPACE_RE);
  return m ? parseFloat(m[1]) : null;
}

/** 언더N → number | null (bp, 부호 없는 크기) */
export function parseUnder(content) {
  const m = typeof content === 'string' ? content.match(RV2_UNDER_RE) : null;
  return m ? parseFloat(m[1]) : null;
}

/** 오버N → number | null (bp, 부호 없는 크기) */
export function parseOver(content) {
  const m = typeof content === 'string' ? content.match(RV2_OVER_RE) : null;
  return m ? parseFloat(m[1]) : null;
}

/**
 * 오프셋 산출(§1.4). 우선순위대로 내려간다.
 * @returns {{ offset_bp: number|null, offset_basis: string }}
 *   basis: explicit | under | over | bp | flat | won_unresolved | no_minpyeong | unknown
 */
export function computeOffset({
  actual_yield = null, minpyeong_yield = null,
  under_bp = null, over_bp = null,
  spread_type = null, spread_value = null,
  is_explicit_flat = false,
} = {}) {
  // 1. 명시 수익률 + 민평 둘 다 존재 → 공식 그대로.
  if (actual_yield != null && minpyeong_yield != null) {
    return { offset_bp: round2((actual_yield - minpyeong_yield) * 100), offset_basis: 'explicit' };
  }
  // 2. 언더N = −N (민평보다 낮은 수익률 = 비싸게 팜)
  if (under_bp != null) return { offset_bp: -under_bp, offset_basis: 'under' };
  // 2'. 오버N = +N
  if (over_bp != null) return { offset_bp: over_bp, offset_basis: 'over' };
  // 3. 명시 bp 표기("+2bp")
  if (spread_type === 'bp' && spread_value != null) {
    return { offset_bp: round2(spread_value), offset_basis: 'bp' };
  }
  // 4. 민평팔자 = 0. **명시 표현일 때만** — parseSpread 의 폴백 flat 은 신뢰하지 않는다.
  if (is_explicit_flat) return { offset_bp: 0, offset_basis: 'flat' };
  // 5. "+N원"만 있고 결과 수익률 없음 → v1 확정 결정: 결측. 듀레이션 환산 안 함.
  if (spread_type === 'won') return { offset_bp: null, offset_basis: 'won_unresolved' };
  // 6. 수익률은 있는데 민평 앵커가 없음(CP/전단채 등) → 오프셋 정의 불가.
  if (actual_yield != null) return { offset_bp: null, offset_basis: 'no_minpyeong' };
  return { offset_bp: null, offset_basis: 'unknown' };
}

/**
 * 구간 수요의 만기 표현 → { lo, hi, note } | null (연 단위).
 * 격자 배정(~1y / 1–2 / 2–3 / 3–5 / 5–10 / 10y+)은 Phase 2 rv2-buckets 소관 — 여기선 숫자만 뽑는다.
 */
export function parseTenorSpan(content) {
  if (!content || typeof content !== 'string') return null;
  let m;
  // "2~3년", "2-3년"
  if ((m = content.match(/(\d+(?:\.\d+)?)\s*[~\-–]\s*(\d+(?:\.\d+)?)\s*년/))) {
    return { lo: parseFloat(m[1]), hi: parseFloat(m[2]), note: null };
  }
  // "1년 이내", "6개월 이내"
  if ((m = content.match(/(\d+(?:\.\d+)?)\s*년\s*이내/))) return { lo: 0, hi: parseFloat(m[1]), note: null };
  if ((m = content.match(/(\d+)\s*개월\s*이내/))) return { lo: 0, hi: round2(parseInt(m[1], 10) / 12), note: null };
  // "3년 이후"
  if ((m = content.match(/(\d+(?:\.\d+)?)\s*년\s*이후/))) return { lo: parseFloat(m[1]), hi: null, note: null };
  // "6개월"
  if ((m = content.match(/(\d+)\s*개월/))) {
    const y = round2(parseInt(m[1], 10) / 12);
    return { lo: y, hi: y, note: null };
  }
  // "26년 말" / "29년초" → 연도 지칭이지 잔존이 아니다.
  if (/(\d+)\s*년\s*[말초중]/.test(content)) return { lo: null, hi: null, note: 'calendar' };
  // "1.5년"
  if ((m = content.match(/(\d+(?:\.\d+)?)\s*년/))) {
    const y = parseFloat(m[1]);
    // 25~40 은 잔존 25년일 수도, "27년"(연도)일 수도 있다. 값은 살리되 불확실을 표시한다.
    return { lo: y, hi: y, note: y >= 25 && y <= 40 ? 'check_calendar' : null };
  }
  return null;
}

// ── 중복 제거 키 (§1.7) ──────────────────────────────────────────────────

/** 딜러 식별자 — 전화번호가 사실상 딜러 ID. 없으면 브로커명, 그것도 없으면 발화자. */
export function dealerId(q) {
  return q.dealer_phone || q.broker || q.trader_name || '';
}

/** 호가 정체성 — observations 배열의 소유자. 레벨은 포함하지 않는다. */
export function instrumentKey(q) {
  return [dealerId(q), q.issuer_raw || '', q.bond_code || '', q.maturity_date || '', q.side || ''].join('|');
}

/**
 * 레벨 포함 키. 동일 = 광고 반복(최초 timestamp 유지, last_seen 갱신).
 * 다르면 = 레벨 변동 → 새 관측으로 append (v2 호가 수명주기 데이터).
 */
export function levelKey(q) {
  const lvl = q.offset_bp != null ? `o${q.offset_bp.toFixed(2)}`
    : q.actual_yield != null ? `y${q.actual_yield}`
      : `r${q.offset_basis}`;
  return instrumentKey(q) + '|' + lvl;
}

// ── 메시지 분류 + 조립 ───────────────────────────────────────────────────

/** 구간 범위 표현 — "2~3년". issuer 추출 전에 중화해야 한다(아래 extract 주석 참조). */
const RV2_RANGE_RE = /\d+(?:\.\d+)?\s*[~～–\-]\s*\d+(?:\.\d+)?\s*년/g;

/** 메시지 1건에서 공통 필드를 한 번만 뽑는다. */
function extract(item) {
  const c = item.raw_content;
  const maturity = parseMaturity(c);
  const matched = maturity ? maturity.matched_text : '';

  // ── 방어 1: 만기 문자열을 가격 표현에서 떼어낸다.
  //    "도로공사975 30.5.20 팔자" 에서 rv-parser 의 parseActualYield/parseSpread 는
  //    만기 꼬리 '5.20' 을 수익률로 읽는다(`(\d+\.\d+)\s*팔자` 매칭). RV-1은 민평이 함께
  //    있어야 괴리를 내므로 가려졌지만, RV-2는 이 값이 곧 호가 레벨·중복키가 되므로 치명적이다.
  //    parseIssuerRaw 가 만기를 인자로 받아 지우는 것과 같은 이유·같은 처리다.
  //
  //    ── B-9 수정 (2026-08-05) ──
  //    **confidence 가 low 인 만기는 방어에서 제외한다.** `3.30 팔자` 처럼 만기 없이
  //    수익률만 던지는 전단채/PF 라인에서 parseMaturity 가 `3.30` 을 2026-03-30(low)으로
  //    오인하는데, 그 위에서 방어가 돌면 **유일한 레벨이 지워진다** — 픽스처 9건.
  //    확신 없는 매칭으로 가격 파서 입력을 삭제하는 것이 오류의 본질이다.
  //    (만기일 자체가 틀리는 것은 rv-parser 소관이라 여기서 고치지 않는다 — §7 B-9 잔여.)
  const useMaturityGuard = matched && maturity.confidence !== 'low';
  const priceText = useMaturityGuard ? c.split(matched).join(' ') : c;

  // ── 방어 2: 범위 표현의 물결표가 종목코드 마커로 오인되는 것을 막는다.
  //    parseIssuerRaw 의 `[~～]([A-Z]?\d+)` 가 "2~3년" 에서 bond_code '3' 을 만들어내고,
  //    그 가짜 코드 때문에 구간 수요 라인이 개별 호가로 오분류된다.
  const issuerText = priceText.replace(RV2_RANGE_RE, ' ');

  const issuer = parseIssuerRaw(issuerText, '');
  const minpyeong = parseMinpyeongRv2(priceText); // B-7 폴백 포함
  const spread = parseSpread(priceText);
  const broker = parseBroker(c); // 딜러태그는 원문 괄호 구조가 필요하다
  return {
    item,
    content: c,
    maturity,
    issuer_raw: issuer ? issuer.issuer_raw : null,
    bond_code: issuer ? issuer.bond_code : null,
    minpyeong,
    spread,
    broker,
    side: parseSide(c),
    rating: parseRating(priceText),
    actual_yield: parseActualYieldRv2(priceText), // B-8 폴백 포함
    tags: parseTags(c),
    status: parseTradeStatus(c),
    volume: parseVolume(priceText),
    under_bp: parseUnder(priceText),
    over_bp: parseOver(priceText),
    is_explicit_flat: RV2_FLAT_RE.test(priceText),
    is_cp_cd: RV2_CP_CD_RE.test(c),
  };
}

/**
 * 메시지 분류 → 'quote' | 'demand' | 'unclassified'.
 * 순서가 규칙이다: 만기 명시 > 구간수요 > 종목단서 보유.
 */
export function classifyExtract(r) {
  // '대치'는 방향 토큰 없이도 양측 레벨이 존재하는 호가다(§1.5).
  if (r.side === null && r.status !== 'matched_market') return 'unclassified';

  // 만기가 찍혀 있으면 "잔존 3년" 같은 표현이 섞여 있어도 개별 호가다.
  if (r.maturity) return 'quote';

  // 만기·종목코드·가격 앵커가 모두 없고 기간 표현만 있으면 구간 수요(§3.3).
  const hasPriceAnchor = (r.minpyeong && r.minpyeong.yield != null) || r.actual_yield != null;
  if (!r.bond_code && !hasPriceAnchor && RV2_PERIOD_RE.test(r.content)) return 'demand';

  // 만기는 없지만 종목코드나 가격 앵커가 있으면 개별 호가(신뢰도는 낮게).
  if (r.bond_code || hasPriceAnchor) return 'quote';

  return 'unclassified';
}

function toQuote(r) {
  const minpyeong_yield = r.minpyeong ? r.minpyeong.yield : null;
  const { offset_bp, offset_basis } = computeOffset({
    actual_yield: r.actual_yield,
    minpyeong_yield,
    under_bp: r.under_bp,
    over_bp: r.over_bp,
    spread_type: r.spread ? r.spread.type : null,
    spread_value: r.spread ? r.spread.value : null,
    is_explicit_flat: r.is_explicit_flat,
  });

  // 신뢰도는 **랭킹 가능성 + 종목 식별력**의 결합. RV-1의 parse_confidence 와 기준이 다르다.
  const rankable = offset_bp != null;
  const parse_confidence =
    rankable && r.maturity && r.maturity.confidence === 'high' && r.issuer_raw ? 'high'
      : rankable && (r.maturity || r.bond_code) && r.issuer_raw ? 'medium'
        : 'low';

  return {
    timestamp: r.item.timestamp,
    trader_name: r.item.trader_name,
    broker: r.broker.broker,
    dealer_phone: r.broker.phone,
    maturity_date: r.maturity ? r.maturity.date : null,
    maturity_confidence: r.maturity ? r.maturity.confidence : null,
    issuer_raw: r.issuer_raw,
    bond_code: r.bond_code,
    rating: r.rating,
    side: r.side,
    minpyeong_yield,
    minpyeong_kkeutjeon: r.minpyeong ? r.minpyeong.kkeutjeon : null,
    // 'base' = rv-parser 가 읽음 / 'fallback' = RV-2 표기 이형 폴백(B-7)이 건짐
    minpyeong_basis: r.minpyeong ? r.minpyeong.basis : null,
    actual_yield: r.actual_yield,
    spread_type: r.spread ? r.spread.type : null,
    spread_value: r.spread ? r.spread.value : null,
    offset_bp,
    offset_basis,
    volume: r.volume,
    status: r.status,
    tags: r.tags,
    is_cp_cd: r.is_cp_cd,
    parse_confidence,
    raw_line: r.content,
  };
}

function toDemand(r) {
  const span = parseTenorSpan(r.content);
  return {
    timestamp: r.item.timestamp,
    trader_name: r.item.trader_name,
    broker: r.broker.broker,
    dealer_phone: r.broker.phone,
    side: r.side,
    tenor_lo: span ? span.lo : null,
    tenor_hi: span ? span.hi : null,
    tenor_note: span ? span.note : null,
    rating: r.rating,
    issuer_hint: r.issuer_raw, // best-effort — 섹터 귀속은 Phase 2 소관
    tags: r.tags,
    raw_line: r.content,
  };
}

// ── 통합 진입점 ──────────────────────────────────────────────────────────

/**
 * 케이본드 채팅 원문 → { quotes, demand, unclassified, stats }
 * 라인은 **버리지 않는다** — 분류되지 않은 것은 원문 그대로 unclassified 로 남는다(사전 확장 피드백 루프).
 */
export function parseRv2(rawText) {
  const pre = prepass(rawText);
  const { preprocessed, stats: logStats } = parseKbondLog(pre.text);

  const quotes = [];
  const demand = [];
  const unclassified = [];

  for (const item of preprocessed) {
    const r = extract(item);
    const kind = classifyExtract(r);
    if (kind === 'quote') quotes.push(toQuote(r));
    else if (kind === 'demand') demand.push(toDemand(r));
    else {
      unclassified.push({
        timestamp: item.timestamp,
        trader_name: item.trader_name,
        raw: item.raw_content,
        reason: r.side === null ? '방향 없음' : '종목·구간 단서 없음',
      });
    }
  }

  const offsetMissing = quotes.filter((q) => q.offset_bp == null);
  const stats = {
    total_lines: pre.stats.total_lines,
    empty_lines: pre.stats.empty_lines,
    // 프리패스에서 걷은 것 + parseKbondLog 가 자체 패턴으로 걷은 것(정상 표현) 합산
    system_messages: pre.stats.system_messages + logStats.system_messages,
    messages: preprocessed.length,
    merged_lines: logStats.merged_lines,
    quotes: quotes.length,
    demand: demand.length,
    unclassified: unclassified.length,
    cp_cd: quotes.filter((q) => q.is_cp_cd).length,
    // "오프셋 미상" 카운트 — 랭킹에서 빠지지만 숨기지 않고 표시한다(§1.4 규칙 4).
    offset_missing: offsetMissing.length,
    offset_missing_by_basis: offsetMissing.reduce((acc, q) => {
      acc[q.offset_basis] = (acc[q.offset_basis] || 0) + 1;
      return acc;
    }, {}),
    rankable: quotes.filter((q) => q.offset_bp != null && !q.is_cp_cd).length,
    // RV-2 계층 폴백이 건진 건수(B-7). 0 이 되면 rv-parser 쪽이 개선됐다는 뜻이다.
    minpyeong_fallback: quotes.filter((q) => q.minpyeong_basis === 'fallback').length,
  };

  return { quotes, demand, unclassified, stats };
}
