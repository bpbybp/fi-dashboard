// rv2-parser 단위 테스트 — node --test (인자 없이 자동탐색).
// 초점: RV-2가 rv-parser 위에 **새로 얹은 계층**(프리패스 라우팅·오프셋 부호·체결마커·수량·중복키).
// rv-parser 자체의 정규식은 RV-1 소관이라 여기서 재검증하지 않되, 위임 결과가 새는지는 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseRv2, prepass, computeOffset, parseTradeStatus, parseVolume,
  parseUnder, parseOver, parseTenorSpan, instrumentKey, levelKey,
} from '../js/rv2-parser.js';

const L = (...lines) => lines.join('\n');
const onlyQuote = (txt) => {
  const r = parseRv2(txt);
  assert.equal(r.quotes.length, 1, `호가 1건 기대, 실제 ${r.quotes.length} / 미분류 ${JSON.stringify(r.unclassified)}`);
  return r.quotes[0];
};

// ── §1.4 오프셋 산출 + 부호 규약 ────────────────────────────────────────

test('규칙1 명시수익률+민평 — 부호는 공식을 따른다(+0.5원 = 비싼 오퍼 = 음수 오프셋)', () => {
  const q = onlyQuote('김진우 (09:05:04) : 중금채 27.8.3 +0.5원 3.605 팔자 (민 3.610) 100억 [부국증권 채권금융 368-9344]');
  assert.equal(q.offset_basis, 'explicit');
  // (3.605 − 3.610) × 100 = −0.5bp. 명령서 §1.4 예시의 '+' 부호는 오기(Phase 0 보고 §6.1).
  assert.equal(q.offset_bp, -0.5);
  assert.equal(q.side, 'offer');
  assert.equal(q.minpyeong_yield, 3.61);
  assert.equal(q.actual_yield, 3.605);
});

test('규칙1 — 민평보다 높은 수익률이면 양수(싸게 나온 오퍼)', () => {
  const q = onlyQuote('김진우 (09:05:04) : 중금채 27.8.3 3.650 팔자 (민 3.610)');
  assert.equal(q.offset_bp, 4);
  assert.equal(q.offset_basis, 'explicit');
});

test('규칙2 언더N = −N bp (rv-parser 미구현분 — 없으면 flat 0 으로 오인된다)', () => {
  assert.equal(parseUnder('언더4 팔자'), 4);
  const q = onlyQuote('김진우 (09:06:00) : 도로공사975 30.5.20 언더4 팔자');
  assert.equal(q.offset_bp, -4);
  assert.equal(q.offset_basis, 'under');
});

test('규칙2 오버N = +N bp', () => {
  assert.equal(parseOver('오버2 팔자'), 2);
  const q = onlyQuote('김진우 (09:06:10) : 도로공사975 30.5.20 오버2 팔자');
  assert.equal(q.offset_bp, 2);
  assert.equal(q.offset_basis, 'over');
});

test('규칙3 민평팔자/민팔자 = 0bp', () => {
  for (const expr of ['민평팔자', '민팔자', '민 팔자']) {
    const q = onlyQuote(`김진우 (09:07:00) : 중금채 27.8.3 ${expr}`);
    assert.equal(q.offset_bp, 0, `${expr} → 0bp`);
    assert.equal(q.offset_basis, 'flat');
  }
});

test('규칙4 "+N원"만 있고 결과 수익률 없음 → 결측(듀레이션 환산 안 함)', () => {
  const q = onlyQuote('김진우 (09:08:00) : 중금채 27.8.3 +2원 팔자');
  assert.equal(q.offset_bp, null);
  assert.equal(q.offset_basis, 'won_unresolved');
  assert.equal(q.spread_type, 'won'); // 관측은 저장한다
});

test('폴백 flat 방어 — 레벨 없는 "팔자"에 0bp를 붙이지 않는다', () => {
  // rv-parser.parseSpread 는 팔자만 있어도 {type:flat, value:0} 을 돌려준다(rv-parser.js:159).
  // 그대로 믿으면 레벨 없는 호가가 전부 "민평 플랫"으로 랭킹에 올라간다.
  const q = onlyQuote('김진우 (09:09:00) : 도로공사975 30.5.20 팔자');
  assert.equal(q.spread_type, 'flat', '기저 파서는 flat 을 준다');
  assert.equal(q.offset_bp, null, 'rv2는 명시 표현이 아니면 0으로 확정하지 않는다');
  assert.equal(q.offset_basis, 'unknown');
});

test('만기 꼬리를 수익률로 읽지 않는다 ("30.5.20 팔자"의 5.20)', () => {
  // rv-parser 의 parseActualYield/parseSpread 는 만기 문자열을 모른 채 `\d+\.\d+\s*팔자` 를 잡는다.
  // 걸러내지 않으면 호가 레벨·중복키가 만기일 조각으로 오염된다.
  const q = onlyQuote('김진우 (09:09:00) : 도로공사975 30.5.20 팔자');
  assert.equal(q.actual_yield, null);
  assert.equal(q.maturity_date, '2030-05-20');
});

test('computeOffset 우선순위 — 명시수익률이 원(won) 표기를 이긴다', () => {
  const r = computeOffset({
    actual_yield: 3.608, minpyeong_yield: 3.61, spread_type: 'won', spread_value: 0.5,
  });
  assert.deepEqual(r, { offset_bp: -0.2, offset_basis: 'explicit' });
});

test('computeOffset — 민평 앵커 없는 수익률은 오프셋 정의 불가', () => {
  const r = computeOffset({ actual_yield: 3.4, minpyeong_yield: null });
  assert.equal(r.offset_bp, null);
  assert.equal(r.offset_basis, 'no_minpyeong');
});

// ── §2.2-B 프리패스: 시스템 메시지 ──────────────────────────────────────

test('프리패스가 존댓말형 "입장하셨습니다"를 제거한다', () => {
  const r = prepass(L('홍길동님이 입장하셨습니다.', '가나다님이 퇴장하였습니다', '실내용'));
  assert.equal(r.stats.system_messages, 2);
  assert.equal(r.text, '실내용');
});

test('시스템 메시지가 직전 호가에 병합돼 오염시키지 않는다', () => {
  // 이것이 프리패스를 parseKbondLog 이전에 두는 이유다: 병합 로직(rv-parser.js:38)이
  // 시각 없는 라인을 무조건 직전 메시지에 붙인다.
  const res = parseRv2(L(
    '김진우 (09:05:04) : 중금채 27.8.3 3.605 팔자 (민 3.610)',
    '홍길동님이 입장하셨습니다.',
  ));
  assert.equal(res.quotes.length, 1);
  assert.ok(!res.quotes[0].raw_line.includes('입장'), '호가 원문에 시스템 메시지가 섞이면 안 된다');
  assert.equal(res.stats.system_messages, 1);
  assert.equal(res.quotes[0].offset_bp, -0.5);
});

// ── §2.2-A 프리패스: 버킷 수요 라우팅 ───────────────────────────────────

test('구간 수요는 미분류가 아니라 demand 레인으로 간다', () => {
  const res = parseRv2('김진우 (09:10:00) : 1.5년 특은 사자');
  assert.equal(res.quotes.length, 0);
  assert.equal(res.demand.length, 1);
  assert.equal(res.unclassified.length, 0);
  assert.equal(res.demand[0].side, 'bid');
  assert.equal(res.demand[0].tenor_lo, 1.5);
  assert.equal(res.demand[0].tenor_hi, 1.5);
});

test('구간 수요 — 범위 표현', () => {
  const res = parseRv2('김진우 (09:11:00) : 2~3년 은행채 매수관심');
  assert.equal(res.demand.length, 1);
  assert.equal(res.demand[0].tenor_lo, 2);
  assert.equal(res.demand[0].tenor_hi, 3);
});

test('만기가 명시된 호가는 "잔존" 표현이 섞여도 개별 호가다', () => {
  const res = parseRv2('김진우 (09:12:00) : 중금채 27.8.3 잔존 1.5년 3.605 팔자 (민 3.610)');
  assert.equal(res.demand.length, 0, 'demand 로 새면 안 된다');
  assert.equal(res.quotes.length, 1);
  assert.equal(res.quotes[0].maturity_date, '2027-08-03');
});

test('parseTenorSpan — 개월·이내·이후·연도지칭', () => {
  assert.deepEqual(parseTenorSpan('6개월 사자'), { lo: 0.5, hi: 0.5, note: null });
  assert.deepEqual(parseTenorSpan('1년 이내 사자'), { lo: 0, hi: 1, note: null });
  assert.deepEqual(parseTenorSpan('3년 이후 사자'), { lo: 3, hi: null, note: null });
  assert.deepEqual(parseTenorSpan('26년 말 사자'), { lo: null, hi: null, note: 'calendar' });
  // 잔존 27년인지 '27년'(연도)인지 모호 — 값은 살리되 표시한다
  assert.equal(parseTenorSpan('27년 사자').note, 'check_calendar');
});

// ── §1.5 체결마커 ───────────────────────────────────────────────────────

test('체결마커 — 동/동통/거래/대치', () => {
  assert.equal(parseTradeStatus('3.605 팔자 동'), 'traded');
  assert.equal(parseTradeStatus('3.605 팔자 동통'), 'traded');
  assert.equal(parseTradeStatus('3.605 팔자 거래'), 'traded');
  assert.equal(parseTradeStatus('2.98 // 3.01 대치'), 'matched_market');
  assert.equal(parseTradeStatus('3.605 팔자'), 'quote');
});

test('체결마커 "동"은 단독 토큰일 때만 — 동양생명·부동산 오탐 없음', () => {
  assert.equal(parseTradeStatus('동양생명 28.3.1 3.5 팔자'), 'quote');
  assert.equal(parseTradeStatus('부동산 관련 채권 팔자'), 'quote');
});

test('대치 라인은 방향 토큰이 없어도 호가로 분류된다', () => {
  const res = parseRv2('김진우 (09:13:00) : 중금채 27.8.3 2.98 // 3.01 대치');
  assert.equal(res.quotes.length, 1);
  assert.equal(res.quotes[0].status, 'matched_market');
});

// ── §1.3 수량 ───────────────────────────────────────────────────────────

test('수량 — 100억 / 50억*5장', () => {
  assert.deepEqual(parseVolume('팔자 100억'), { unit_eok: 100, lots: 1, total_eok: 100, raw: '100억' });
  const v = parseVolume('팔자 50억*5장');
  assert.equal(v.unit_eok, 50);
  assert.equal(v.lots, 5);
  assert.equal(v.total_eok, 250);
  assert.equal(parseVolume('팔자'), null);
});

// ── 멀티라인 / 딜러태그 ─────────────────────────────────────────────────

test('시각 없는 다음 줄 호가는 직전 발화자에 귀속된다', () => {
  const res = parseRv2(L(
    '김진우 (09:05:04) : 중금채 27.8.3 3.605 팔자 (민 3.610)',
    '도로공사975 30.5.20 3.210 사자 (민 3.200)',
  ));
  assert.equal(res.quotes.length, 2);
  assert.equal(res.quotes[1].trader_name, '김진우');
  assert.equal(res.quotes[1].timestamp, '09:05:04');
  assert.equal(res.quotes[1].side, 'bid');
});

test('대괄호 딜러태그 연속 줄은 직전 호가에 병합되고 전화번호가 딜러 ID가 된다', () => {
  const res = parseRv2(L(
    '김진우 (09:05:04) : 중금채 27.8.3 3.605 팔자 (민 3.610)',
    '[부국증권 채권금융 368-9344]',
  ));
  assert.equal(res.quotes.length, 1);
  assert.equal(res.quotes[0].dealer_phone, '368-9344');
  assert.equal(res.quotes[0].broker, '부국증권 채권금융');
});

// ── 미분류 (버리지 않는다) ──────────────────────────────────────────────

test('호가가 아닌 라인은 원문 그대로 미분류에 남는다', () => {
  const res = parseRv2(L(
    '김진우 (09:20:00) : 오늘 채용공고 올라왔습니다 관심있으신 분 연락주세요',
    '이영희 (09:21:00) : +2dnjs vkfwk',
  ));
  assert.equal(res.quotes.length, 0);
  assert.equal(res.demand.length, 0);
  assert.equal(res.unclassified.length, 2);
  assert.ok(res.unclassified[1].raw.includes('vkfwk'), '오타 라인 원문 보존');
});

// ── §4 CP/CD — 분류는 하되 랭킹 제외 ────────────────────────────────────

test('CP/CD는 파싱·분류하되 rankable 에서 빠진다', () => {
  const res = parseRv2(L(
    '김진우 (09:30:00) : 중금채 27.8.3 3.650 팔자 (민 3.610)',
    '김진우 (09:31:00) : A1 CP 3개월 3.20 팔자',
  ));
  const cp = res.quotes.find((q) => q.is_cp_cd);
  assert.ok(cp, 'CP 라인도 관측으로 남는다');
  assert.equal(res.stats.cp_cd, 1);
  assert.equal(res.stats.rankable, 1, 'CP 는 랭킹 대상에서 제외');
});

// ── §1.7 중복 제거 키 ───────────────────────────────────────────────────

test('같은 레벨 재게시 = 같은 levelKey, 레벨 변동 = 같은 instrumentKey·다른 levelKey', () => {
  const base = '중금채 27.8.3 3.605 팔자 (민 3.610) [부국증권 채권금융 368-9344]';
  const moved = '중금채 27.8.3 3.615 팔자 (민 3.610) [부국증권 채권금융 368-9344]';
  const [a] = parseRv2(`김진우 (09:05:04) : ${base}`).quotes;
  const [b] = parseRv2(`이영희 (09:40:00) : ${base}`).quotes; // 같은 딜러 태그, 다른 발화자
  const [c] = parseRv2(`김진우 (10:00:00) : ${moved}`).quotes;

  assert.equal(levelKey(a), levelKey(b), '동일 딜러·동일 레벨 재게시는 광고 반복');
  assert.equal(instrumentKey(a), instrumentKey(c), '레벨이 바뀌어도 같은 호가 정체성');
  assert.notEqual(levelKey(a), levelKey(c), '레벨 변동은 새 관측');
});

// ── 통계 ────────────────────────────────────────────────────────────────

test('stats — 오프셋 미상 건수를 사유별로 숨기지 않고 집계한다', () => {
  const res = parseRv2(L(
    '김진우 (09:05:04) : 중금채 27.8.3 3.650 팔자 (민 3.610)',
    '김진우 (09:06:00) : 중금채 27.8.3 +2원 팔자',
    '김진우 (09:07:00) : 도로공사975 30.5.20 팔자',
  ));
  assert.equal(res.stats.quotes, 3);
  assert.equal(res.stats.offset_missing, 2);
  assert.deepEqual(res.stats.offset_missing_by_basis, { won_unresolved: 1, unknown: 1 });
  assert.equal(res.stats.rankable, 1);
});

test('빈 입력·잡음 입력에서 죽지 않는다', () => {
  for (const bad of ['', '   ', '\n\n\n', null, undefined]) {
    const res = parseRv2(bad);
    assert.equal(res.quotes.length, 0);
    assert.equal(res.demand.length, 0);
  }
});
