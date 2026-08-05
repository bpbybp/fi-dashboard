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
  // 예전 rv-parser.parseSpread 는 팔자만 있어도 {type:flat, value:0} 을 돌려줬고(구 rv-parser.js:159),
  // RV-2 는 그걸 믿지 않는 방어를 얹어 왔다. 2026-08-05 백로그 B-6 으로 **기저 파서 쪽이 고쳐져**
  // 이제 null 이 온다. RV-2 의 결론(offset 미상)은 그대로다 — 방어는 이중화로 남는다.
  const q = onlyQuote('김진우 (09:09:00) : 도로공사975 30.5.20 팔자');
  assert.equal(q.spread_type, null, 'B-6 수정 후 기저 파서는 미상(null)을 준다');
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

// ══════════════════════════════════════════════════════════════════════════
// 실데이터 이형 — tests/fixtures/kbond-sample.masked.txt (2026-08-05 원문 1일치)
//
// 위 합성 테스트는 §1.3~1.7 규칙을 검증한다. 이 절은 다르다: **실제 채팅에 나온 라인을
// 그대로 박아 넣고**, 파서가 오늘 무엇을 하는지 고정한다. 일부는 의도한 동작이 아니라
// **알려진 갭**(B-7·B-8·B-9)이며, 그 사실을 주석으로 명시한 채 현재 동작을 고정한다.
// 갭을 고칠 때 이 테스트가 먼저 깨져 영향 범위를 드러내는 것이 목적이다.
// 인용 라인은 마스킹 픽스처에서 발췌했다 — 이름·번호는 이미 더미다.
// ══════════════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kbond-sample.masked.txt');
const fixtureText = readFileSync(FIXTURE, 'utf8');
const fixture = parseRv2(fixtureText);

// 발췌 라인을 메시지 1건으로 감싼다. 발화자·시각은 픽스처 형식과 동일한 더미.
const asMessage = (line) => `트레이더01 (09:00:00) : ${line}`;
const quoteOf = (line) => onlyQuote(asMessage(line));

// ── 픽스처 무결성: 마스킹이 풀리면 여기서 먼저 죽는다 ────────────────────

test('픽스처 PII 가드 — 마스킹되지 않은 연락처가 커밋 픽스처에 남으면 실패', () => {
  // 더미는 마지막 그룹만 일련번호이고 앞 그룹은 전부 0 이다. 0 으로 시작하지 않는
  // 전화번호 형태가 보이면 마스킹이 새로 생긴 이형을 놓쳤다는 뜻이다.
  const hyphen = [...fixtureText.matchAll(/\b\d{2,4}-\d{3,4}-\d{4}\b|\b\d{3,4}-\d{4}\b/g)]
    .map((m) => m[0]).filter((s) => !/^0+-/.test(s));
  assert.deepEqual(hyphen, [], `하이픈형 미마스킹 번호: ${hyphen.slice(0, 5)}`);

  // 점·공백형. 딜러태그 안만 본다 — 본문 숫자는 채권 데이터다.
  // 더미 번호는 전부 0 으로 시작하므로, 0 이 아닌 것만 후보로 본다.
  // `트레이더811` 같은 익명 발화자 토큰은 뒤 번호와 붙어 `811 0000` 처럼 보이므로 먼저 지운다.
  const loose = [];
  for (const tag of fixtureText.matchAll(/[[(]([^\])]+)[\])]/g)) {
    for (const m of tag[1].replace(/트레이더\d+/g, ' ').matchAll(/\b\d{3,4}[.\s]\d{4}\b/g)) {
      if (!/^0/.test(m[0])) loose.push(m[0]);
    }
  }
  assert.deepEqual(loose, [], `점·공백형 미마스킹 번호: ${loose.slice(0, 5)}`);

  const mails = [...fixtureText.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)]
    .map((m) => m[0]).filter((s) => !s.endsWith('@example.com'));
  assert.deepEqual(mails, [], `미마스킹 이메일: ${mails}`);
});

// ── 분류표 회귀 (Phase 0 보고 §5) ────────────────────────────────────────

test('픽스처 분류표 — 보고 §5.0 수치를 고정한다', () => {
  const s = fixture.stats;
  assert.equal(s.total_lines, 5225);
  assert.equal(s.system_messages, 994, '존댓말형 입·퇴장 포함. 이게 줄면 §2.2-B 방어가 샌 것');
  assert.equal(s.messages, 3842);
  assert.equal(s.quotes, 3596);
  assert.equal(s.demand, 129, '구간 수요 레인 — NON_INDIVIDUAL_RE 가 버리던 라인들(§2.2-A)');
  assert.equal(s.unclassified, 117);
  assert.equal(s.cp_cd, 142);
});

test('픽스처 오프셋 — 보고 §5.0.1·필수행2 수치를 고정한다', () => {
  const s = fixture.stats;
  assert.equal(s.rankable, 932, '랭킹 가능 = 개별호가의 25.9%');
  assert.equal(s.offset_missing, 2664);
  assert.deepEqual(s.offset_missing_by_basis, {
    won_unresolved: 457,
    unknown: 2150,
    no_minpyeong: 57,
  });

  const byBasis = {};
  for (const q of fixture.quotes) {
    if (q.offset_bp != null) byBasis[q.offset_basis] = (byBasis[q.offset_basis] || 0) + 1;
  }
  // under 186건은 rv-parser 에 없는 표현이다. RV-2 자체 처리가 없으면 전부 flat 0 으로 오인된다(B-1).
  assert.deepEqual(byBasis, { explicit: 453, flat: 243, under: 186, over: 38, bp: 12 });
});

test('픽스처 필수행1 — 레벨 없는 개별 호가는 offset_basis=unknown 과 같은 모집단', () => {
  const noLevel = fixture.quotes.filter((q) => q.actual_yield == null && q.offset_basis === 'unknown');
  assert.equal(noLevel.length, 2150);
  assert.equal(noLevel.length, fixture.stats.offset_missing_by_basis.unknown, '§5.1 등식');

  // B-6 모집단: 레벨은 없는데 민평은 있다 → RV-1 폴백 flat 이 "민평에 판다"로 오인하는 라인.
  // 개별호가의 50.9%. 이 수가 크다는 것이 B-6 을 1순위로 올린 근거다(보고 §5.1).
  assert.equal(noLevel.filter((q) => q.minpyeong_yield != null).length, 1829);
});

// ── 오프셋 basis 별 실데이터 라인 ────────────────────────────────────────

test('실데이터 — 언더N (rv-parser 미구현분을 RV-2 가 잡는다)', () => {
  const q = quoteOf('28.1.3(월) 만기 중금(사) (민3.744%) 언더3 팔자 [DS FI금융 000-1027]');
  assert.equal(q.offset_basis, 'under');
  assert.equal(q.offset_bp, -3, '언더 = 민평보다 낮은 수익률 = 비싸게 팜 = 음수');
  assert.equal(q.minpyeong_yield, 3.744);
  assert.equal(q.side, 'offer');
});

test('실데이터 — 오버N, 민평이 대괄호 안에 있어도 읽는다', () => {
  const q = quoteOf('30.3.25(월) 농금은행(상/후) [민 4.511] AA0 오버2 팔자 [케이프 인수금융팀 00-0000-1059]');
  assert.equal(q.offset_basis, 'over');
  assert.equal(q.offset_bp, 2);
  assert.equal(q.minpyeong_yield, 4.511);
  assert.equal(q.rating, 'AA0');
});

test('실데이터 — `..팔자` 와 `/ 민평 팔자` 는 명시 flat 으로 인정한다', () => {
  const a = quoteOf('26.11.21(토) 우리은행 민3.045(끝.93원)..팔자  (수반) [리딩증권 FI솔루션 (00-0000-1038)]');
  assert.equal(a.offset_basis, 'flat');
  assert.equal(a.offset_bp, 0);
  assert.equal(a.minpyeong_yield, 3.045);

  const b = quoteOf('30.1.24 LG화학58-2 [민 4.372] (.90) AA0/AA+ 팔자 / 민평 팔자  (bgc 0000-1048)');
  assert.equal(b.offset_basis, 'flat');
  assert.equal(b.minpyeong_yield, 4.372);
});

test('실데이터 — `-4bp` 명시 표기', () => {
  const q = quoteOf('35.10.22(월) 도로공사978 팔자 민 4.404 .2  100억   -4bp [다올 0000-1094/7]');
  assert.equal(q.offset_basis, 'bp');
  assert.equal(q.offset_bp, -4);
  assert.equal(q.volume.total_eok, 100);
});

test('실데이터 — `+N원` 만 있고 결과 수익률이 없으면 결측 (듀레이션 환산 안 함)', () => {
  const q = quoteOf('26.12.12 국은채 팔자 (민3.117 / .7원) [신한투자증권 0000-1018]');
  assert.equal(q.offset_basis, 'won_unresolved');
  assert.equal(q.offset_bp, null);
  assert.equal(q.minpyeong_yield, 3.117);
});

// ── 체결마커·수량 ────────────────────────────────────────────────────────

test('실데이터 — 단독 토큰 `동` 은 체결, 수량은 별개로 읽는다', () => {
  const q = quoteOf('26.12.10 가스공사511  민평3.112  끝전06  +0.5원 3.099 팔자 100억 동 (KMB 트레이더811 0000-1061)');
  assert.equal(q.status, 'traded');
  assert.equal(q.actual_yield, 3.099);
  assert.equal(q.volume.total_eok, 100);
});

test('실데이터 — `대치` 는 방향어가 없어도 호가로 남는다', () => {
  const q = quoteOf('26.09.23 키움증권 전단채 100억 매도 > 2.98 // 3.01 대치 (KR투자증권/채권팀 0000-1019)');
  assert.equal(q.status, 'matched_market');
  assert.equal(q.is_cp_cd, true, '전단채 → 분류는 하되 랭킹 제외');
});

test('실데이터 — `50억*5장` 은 장수를 곱한다', () => {
  const q = quoteOf('26.11.2 부산은행CD 팔자 50억*5장 [한화 0000-1021]');
  assert.deepEqual(q.volume, { unit_eok: 50, lots: 5, total_eok: 250, raw: '50억*5장' });
});

// ── 구간 수요 (§3.3 사자 패널) ───────────────────────────────────────────

test('실데이터 — 구간 수요는 호가 레인으로 새지 않는다', () => {
  const r = parseRv2(asMessage('1~1.5년 증권사 사자 [신한 0000-1032]'));
  assert.equal(r.quotes.length, 0, 'RV2_RANGE_RE 중화가 없으면 bond_code "1.5" 가 생겨 호가로 오분류된다');
  assert.equal(r.demand.length, 1);
  assert.deepEqual([r.demand[0].tenor_lo, r.demand[0].tenor_hi], [1, 1.5]);
  assert.equal(r.demand[0].side, 'bid');
});

test('실데이터 — RWA 표기가 섞인 구간 수요', () => {
  const [d] = parseRv2(asMessage('4~5년 RWA0 공사채 지방채 사자 [부국 채권전략 0000-1158]')).demand;
  assert.deepEqual([d.tenor_lo, d.tenor_hi], [4, 5]);
});

test('실데이터 — `28년 초` 는 잔존이 아니라 달력 연도로 표시된다', () => {
  const [d] = parseRv2(asMessage('28년 초 은행채사자 [신한 0000-1032]')).demand;
  assert.equal(d.tenor_note, 'calendar');
  assert.equal(d.tenor_lo, null);
});

// ── 노이즈 ───────────────────────────────────────────────────────────────

test('실데이터 — 존댓말형 입·퇴장은 프리패스가 걷는다 (병합 오염 차단, §2.2-B)', () => {
  const r = parseRv2(L(
    '트레이더01 (09:00:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]',
    '트레이더02님이 입장하셨습니다.',
    '트레이더03님이 퇴장하였습니다.',
  ));
  assert.equal(r.quotes.length, 1);
  assert.equal(r.quotes[0].offset_bp, -3);
  assert.ok(!r.quotes[0].raw_line.includes('입장'), '병합돼 호가 라인에 붙으면 안 된다');
});

test('실데이터 — 채용공고는 미분류로 남되 버려지지 않는다', () => {
  const r = parseRv2(asMessage('[흥국증권 FICC세일즈팀 채용공고] 1. 모집부문 : 채권 중개 및 인수'));
  assert.equal(r.quotes.length, 0);
  assert.equal(r.unclassified.length, 1);
  assert.equal(r.unclassified[0].reason, '방향 없음');
  assert.ok(r.unclassified[0].raw.includes('채용공고'), '원문 보존 — 사전 확장 피드백 루프');
});

// ── 알려진 갭: 현재 동작을 고정한다 (고칠 때 여기가 먼저 깨진다) ─────────

test('B-7 갭 — parseMinpyeong 이 `민평 N`·`민:N` 표기를 놓친다 (현행 고정)', () => {
  // 픽스처 198건. 인식하는 형태와 못 하는 형태를 나란히 둔다.
  assert.equal(quoteOf('27.4.9 하나은행(민3.517, 끝.73) 팔자').minpyeong_yield, 3.517, '`민N` 은 인식');
  assert.equal(quoteOf('28.1.10 중금(사) 언더3 팔자 (민3.751)').minpyeong_yield, 3.751, '`(민N)` 은 인식');

  // ↓ 전부 원문에 민평이 있는데 null 이 된다. 고치면 이 세 줄이 깨진다 — 그게 신호다.
  assert.equal(quoteOf('26.12.10 가스공사511  민평3.112  끝전06  팔자 100억').minpyeong_yield, null, '`민평N` 미인식');
  assert.equal(quoteOf('27.2.4(목) 중금채 (민평 3.242%/ 끝.91/ 쿠폰 2.88%) 팔자').minpyeong_yield, null, '`민평 N` 미인식');
  assert.equal(quoteOf('27.8.27(금) SBS14-2 (민:3.957% / 끝.79 / AA ) 민 팔자').minpyeong_yield, null, '`민:N` 미인식');

  const gap = fixture.quotes.filter((q) => q.minpyeong_yield == null && /민\s*평?\s*[:：]?\s*\d\.\d{2,4}/.test(q.raw_line));
  assert.equal(gap.length, 198, '픽스처 실측 — 줄어들면 B-7 이 개선된 것');
});

test('B-8 갭 — parseActualYield 가 `3.602팔자`(공백 없음)를 놓친다 (현행 고정)', () => {
  const q = quoteOf('27.8.3  중금채  민3.610(끝전.3).. 민+1원 3.602팔자 (SK 0000-1025)');
  assert.equal(q.minpyeong_yield, 3.61);
  assert.equal(q.actual_yield, null, '공백이 있으면 3.602 를 잡는다. 붙으면 놓친다');
  assert.equal(q.offset_basis, 'won_unresolved', '인식되면 explicit / −0.8bp 가 되어야 할 관측');

  const gap = fixture.quotes.filter((x) => x.actual_yield == null && /\d\.\d{2,4}(?:팔자|사자)/.test(x.raw_line));
  assert.equal(gap.length, 43, '픽스처 실측');
});

test('B-9 갭 — 만기 없는 `3.30 팔자` 에서 방어가 레벨을 지운다 (RV-2 자체 결함, 현행 고정)', () => {
  const q = quoteOf('3.30 팔자 (한양증권 00-0000-1084)');
  // parseMaturity 가 `3.30` 을 2026-03-30(confidence low)으로 오인 → 방어가 그 문자열을
  // 가격 파서 입력에서 제거 → 유일한 레벨이 사라진다.
  assert.equal(q.maturity_confidence, 'low');
  assert.equal(q.actual_yield, null);
  assert.equal(q.offset_basis, 'unknown');

  // 과거 만기가 붙은 호가는 이 오탐의 관측 가능한 흔적이다.
  const past = fixture.quotes.filter((x) => x.maturity_date && x.maturity_date < '2026-08-05');
  assert.equal(past.length, 11, '픽스처 실측 — B-9 수정 시 줄어야 한다');
});

test('갭 — parseBroker 는 점·공백 구분 번호를 딜러 ID 로 잡지 못한다 (현행 고정)', () => {
  const withHyphen = quoteOf('28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]');
  assert.equal(withHyphen.dealer_phone, '0000-1021');

  const withDot = quoteOf('27.4.9 하나은행(민3.517, 끝.73) 팔자 [케이프 채권투자 0000.1010]');
  assert.equal(withDot.dealer_phone, null, '전화번호가 딜러 ID 인데 폴백이 브로커명으로 내려간다');
  assert.ok(withDot.broker, '브로커명은 남아 중복제거가 완전히 무너지지는 않는다');
});
