// rv-parser.js 특성화 테스트 — node --test (인자 없이 자동탐색).
//
// **목적이 다른 테스트다.** 여기서는 "옳은 동작"을 검증하지 않는다.
// `js/rv-parser.js` 는 Fenrir 이식 이래 테스트가 하나도 없었고(§3.1), 이제 백로그 B-6 로
// 동작을 바꾸려 한다. 그 전에 **현재 동작을 버그까지 포함해 있는 그대로 고정**해서,
// 수정이 무엇을 깨는지 diff 로 드러나게 만드는 것이 이 파일의 존재 이유다.
//
// 따라서 아래에는 **의도적으로 잘못된 기대값**이 들어 있다. 전부 `⚠ 현행 버그` 로 표시했고,
// 고칠 때 해당 assert 를 바꾸는 것이 정상 절차다. 표시 없는 assert 는 올바른 동작이다.
//
// 실데이터 라인은 tests/fixtures/kbond-sample.masked.txt (2026-08-05 원문) 에서 발췌했다.
// 백로그 항목 번호는 rv2-phase0-report.md §7 기준.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  parseKbondLog, parseKbondQuotes, parseMaturity, parseSide, parseMinpyeong,
  parseSpread, parseRating, parseActualYield, parseIssuerRaw, parseTags, parseBroker,
} from '../js/rv-parser.js';
import { quoteYield } from '../js/rv-engine.js';
import { buildGaps, bucketMedians, adjustGaps } from '../js/rv-cross.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kbond-sample.masked.txt');
const fixtureText = readFileSync(FIXTURE, 'utf8');

// ══════════════════════════════════════════════════════════════════════════
// 1. parseSpread — B-6 의 진앙. 우선순위 사슬 전체를 고정한다.
// ══════════════════════════════════════════════════════════════════════════

test('parseSpread 우선순위 — 원 > bp > 오버 > 명시flat > absolute > 폴백flat', () => {
  // 1순위 '원'. 다른 표현이 뒤에 있어도 원이 이긴다.
  assert.deepEqual(parseSpread('+0.5원 3.605 팔자 (민 3.610)'), { type: 'won', value: 0.5 });
  // 2순위 bp
  assert.deepEqual(parseSpread('도로공사978 팔자 민 4.404 -4bp'), { type: 'bp', value: -4 });
  // 3순위 오버N ('오바' 오타 포함) — bp 로 정규화된다
  assert.deepEqual(parseSpread('[민 4.511] AA0 오버2 팔자'), { type: 'bp', value: 2 });
  assert.deepEqual(parseSpread('오바3 팔자'), { type: 'bp', value: 3 });
  // 4순위 명시 flat
  assert.deepEqual(parseSpread('SBS14-2 (민:3.957%) 민 팔자'), { type: 'flat', value: 0 });
  assert.deepEqual(parseSpread('우리은행 민3.045(끝.93원)..팔자'), { type: 'won', value: 93 },
    '⚠ 현행 버그 2중: (1) `(끝.93원)` 의 "원" 이 먼저 걸려 `..팔자` 명시 flat 에 도달하지 못하고, '
    + '(2) 정규식이 선행 소수점을 못 받아 .93 을 **93원**으로 읽는다');
  // 5순위 absolute
  assert.deepEqual(parseSpread('중금채 3.650 팔자'), { type: 'absolute', value: 3.65 });
});

test('⚠ B-6 현행 버그 — 레벨 없는 호가에 폴백 flat 0 이 붙는다', () => {
  // 이 라인들에는 수익률도, 언더/오버도, 민평팔자 표현도 없다. "모른다" 가 맞는 답인데
  // rv-parser.js:159 의 마지막 폴백이 팔자/사자 존재만 보고 flat 0 을 만든다.
  for (const line of [
    '27.5.4(화) 지에스리테일34-2(사)(민 3.802%/.04/AA) 팔자',
    '26.9.23 한전1422 팔자',
    '27.1.25 중금 (민 3.212, 끝전1) 팔자',
    '2년 산금 사자',
  ]) {
    assert.deepEqual(parseSpread(line), { type: 'flat', value: 0 }, `폴백 발화: ${line}`);
  }
});

test('⚠ B-1 현행 버그 — 언더N 이 없어 폴백 flat 0 으로 읽힌다', () => {
  // 실제로는 민평 대비 −3bp 인데 0bp 가 된다.
  assert.deepEqual(parseSpread('28.1.3(월) 만기 중금(사) (민3.744%) 언더3 팔자'), { type: 'flat', value: 0 });
});

test('parseSpread — 방향어조차 없으면 null', () => {
  assert.equal(parseSpread('27.5.4 지에스리테일34-2'), null);
  assert.equal(parseSpread(''), null);
  assert.equal(parseSpread(null), null);
});

// ══════════════════════════════════════════════════════════════════════════
// 2. B-6 의 피해 경로 — quoteYield → rawGap → 버킷 중앙값
// ══════════════════════════════════════════════════════════════════════════

test('⚠ B-6 피해 경로 — 폴백 flat + 민평이면 "민평에 판다"가 되어 원괴리 0 으로 유입된다', () => {
  const q = { actual_yield: null, minpyeong_yield: 3.802, spread_type: 'flat', spread_value: 0 };
  assert.deepEqual(quoteYield(q), { y: 3.802, basis: '민평flat' },
    '⚠ 레벨을 제시하지 않은 호가인데 민평 그 자체를 호가수익률로 채택한다');
});

test('⚠ B-6 피해 경로 — 허수 0bp 가 버킷 중앙값을 끌어당긴다', () => {
  const mk = (minpyeong, spread_type, actual_yield = null) => ({
    q: { minpyeong_yield: minpyeong, spread_type, spread_value: 0, actual_yield, side: 'offer' },
    ref: { group: '은행채', refYield: null, method: 'issuer' },
  });
  // 실제 레벨을 제시한 호가 2건(+5bp, +7bp)과, 레벨 없는 폴백 flat 3건.
  const rows = [
    mk(3.0, 'absolute', 3.05),
    mk(3.0, 'absolute', 3.07),
    mk(3.0, 'flat'), mk(3.0, 'flat'), mk(3.0, 'flat'),
  ];
  const gaps = buildGaps(rows, quoteYield);
  // 부동소수 오차가 있어 근사 비교한다(4.999999… ≈ 5).
  assert.deepEqual(gaps.map((g) => Math.round(g.rawGap * 1e6) / 1e6), [5, 7, 0, 0, 0],
    '폴백 flat 3건이 rawGap 0 으로 들어온다');

  const bm = bucketMedians(gaps);
  assert.equal(bm.bucketCount['은행채'], 5);
  assert.equal(bm.bucketMedian['은행채'], 0, '⚠ 중앙값이 5~7bp 가 아니라 0 으로 끌려간다');

  adjustGaps(gaps, bm);
  // 진짜 호가의 조정괴리가 부풀려진다 — 시장 베타를 못 빼서 +5bp 가 그대로 남는다.
  assert.deepEqual(gaps.slice(0, 2).map((g) => Math.round(g.adjustedGap * 1e6) / 1e6), [5, 7]);
});

// ══════════════════════════════════════════════════════════════════════════
// 3. 나머지 추출기 — B-6 수정이 건드리면 안 되는 회귀 안전망
// ══════════════════════════════════════════════════════════════════════════

test('parseMaturity — 5개 패턴', () => {
  assert.deepEqual(parseMaturity('27.5.4(화) 지에스리테일34-2'),
    { date: '2027-05-04', confidence: 'high', matched_text: '27.5.4(화)' });
  assert.deepEqual(parseMaturity('26.12.12 국은채 팔자'),
    { date: '2026-12-12', confidence: 'high', matched_text: '26.12.12' });
  assert.deepEqual(parseMaturity('26 12 12 국은채'),
    { date: '2026-12-12', confidence: 'medium', matched_text: '26 12 12' });
  assert.deepEqual(parseMaturity('26년 12월 12일 국은채'),
    { date: '2026-12-12', confidence: 'medium', matched_text: '26년 12월 12일' });
  assert.equal(parseMaturity('중금채 팔자'), null);
});

test('⚠ B-9 현행 버그 — 만기 없는 `3.30 팔자` 의 수익률을 만기로 오인한다', () => {
  assert.deepEqual(parseMaturity('3.30 팔자 (한양증권 00-0000-1084)'),
    { date: '2026-03-30', confidence: 'low', matched_text: '3.30' });
});

test('parseMaturity — 26~35 년 밖은 confidence 를 low 로 낮춘다', () => {
  assert.equal(parseMaturity('45.5.4(화) 무언가').confidence, 'low');
  assert.equal(parseMaturity('30.3.25(월) 농금은행').confidence, 'high');
});

test('parseSide — 교체는 offer, 거래완료는 방향 없음', () => {
  assert.equal(parseSide('중금채 팔자'), 'offer');
  assert.equal(parseSide('2년 산금 사자'), 'bid');
  assert.equal(parseSide('IBK캐피탈345-2 교체'), 'offer');
  assert.equal(parseSide('매수관심'), 'bid', '⚠ 사자/매수 검사가 관심보다 먼저라 interest 로 안 간다');
  assert.equal(parseSide('국전전 관심'), 'interest');
  assert.equal(parseSide('중금채 팔자 거래완료'), null, '거래완료가 최우선 — 방향을 지운다');
  assert.equal(parseSide('27.5.4 지에스리테일34-2'), null);
});

test('parseMinpyeong — 인식하는 표기', () => {
  assert.deepEqual(parseMinpyeong('(민 3.610)'), { yield: 3.61, kkeutjeon: null });
  assert.deepEqual(parseMinpyeong('민3.517, 끝.73'), { yield: 3.517, kkeutjeon: 0.73 });
  assert.deepEqual(parseMinpyeong('민평 : 3.242 끝전 : 0.91'), { yield: 3.242, kkeutjeon: 0.91 });
  assert.deepEqual(parseMinpyeong('[민 4.372] (.90)'), { yield: 4.372, kkeutjeon: 0.9 });
});

test('⚠ B-7 현행 버그 — `민평 N`·`민:N`·`민,N` 표기를 놓친다', () => {
  assert.equal(parseMinpyeong('민평3.112 끝전06'), null);
  assert.equal(parseMinpyeong('(민평 3.242%/ 끝.91)'), null);
  assert.equal(parseMinpyeong('(민:3.957% / 끝.79)'), null);
  assert.equal(parseMinpyeong('한국캐피탈(민,3.945) 10억 팔자'), null);
});

test('parseRating', () => {
  assert.equal(parseRating('(사)(민 3.802%/.04/AA) 팔자'), 'AA0', 'AA 는 AA0 으로 정규화');
  assert.equal(parseRating('[민 4.511] AA0 오버2'), 'AA0');
  assert.equal(parseRating('(27.10.7,목,AA0)'), 'AA0');
  assert.equal(parseRating('중금채 팔자'), null);
  assert.equal(parseRating('A 등급'), null, '단독 A 는 등급으로 보지 않는다');
});

test('parseActualYield — 민평 괄호를 지운 뒤 방향어 인접 숫자를 읽는다', () => {
  assert.equal(parseActualYield('중금채 3.650 팔자 (민 3.610)'), 3.65);
  assert.equal(parseActualYield('팔자 3.650'), 3.65);
  assert.equal(parseActualYield('중금채 팔자'), null);
});

test('⚠ B-8 현행 버그 — 숫자와 방향어가 붙으면 놓친다', () => {
  assert.equal(parseActualYield('민+1원 3.602팔자'), null);
  assert.equal(parseActualYield('민+1원 3.602 팔자'), 3.602, '공백이 있으면 잡는다');
});

test('⚠ B-5 현행 버그 — 만기 꼬리가 수익률로 채택된다 (합성 라인에서만 발화)', () => {
  // §7.1 의 실증. 실데이터 3,842건에서는 0건이라 강등됐지만 메커니즘 자체는 살아 있다.
  assert.equal(parseActualYield('중금채 27.8.3 팔자'), 8.3);
  assert.equal(parseActualYield('도로공사975 30.5.20 팔자'), 5.2);
});

test('parseIssuerRaw — 딜러태그·민평·수량을 걷어내고 발행사와 종목코드를 남긴다', () => {
  assert.deepEqual(
    parseIssuerRaw('27.5.4(화) 지에스리테일34-2(사)(민 3.802%/.04/AA) 팔자 [교보 채영 0000-1099]', '27.5.4(화)'),
    { issuer_raw: '지에스리테일', bond_code: '34-2' });
  assert.deepEqual(
    parseIssuerRaw('26.12.12 국은채 팔자 [신한투자증권 0000-1018]', '26.12.12'),
    { issuer_raw: '국은채', bond_code: null });
});

test('parseTags', () => {
  assert.deepEqual(parseTags('IBK캐피탈345-2 교체 팔자'), ['replace']);
  assert.deepEqual(parseTags('우리은행 팔자 (수반)'), ['suban']);
  assert.deepEqual(parseTags('농금은행(상/후) 팔자'), [],
    '⚠ 현행 버그: 정규식이 `(후)` 단독만 보아 `(상/후)` 를 후순위로 못 읽는다');
  assert.deepEqual(parseTags('농금은행 후순위 팔자'), ['subordinated']);
  assert.deepEqual(parseTags('중금채 팔자'), []);
});

test('parseBroker — 마지막 후보를 쓰고 전화번호를 떼어낸다', () => {
  assert.deepEqual(parseBroker('중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]'),
    { broker: '한화', phone: '0000-1021' });
  assert.deepEqual(parseBroker('27.4.9 하나은행(민3.517) 팔자 [케이프 채권투자 0000.1010]'),
    { broker: '케이프 채권투자 0000.1010', phone: null },
    '⚠ 점 구분 번호는 전화번호로 인식되지 않아 브로커명에 그대로 남는다');
});

// ══════════════════════════════════════════════════════════════════════════
// 4. parseKbondLog — 멀티라인 병합과 시스템 메시지
// ══════════════════════════════════════════════════════════════════════════

test('⚠ B-4 현행 버그 — 존댓말형 입장 메시지가 직전 호가에 병합된다', () => {
  const { preprocessed, stats } = parseKbondLog([
    '트레이더01 (09:00:00) : 26.12.12 국은채 팔자 (민3.117)',
    '트레이더02님이 입장하셨습니다.',
  ].join('\n'));
  assert.equal(stats.system_messages, 0, 'SYSTEM_MESSAGE_RE 가 존댓말형을 모른다');
  assert.equal(preprocessed.length, 1);
  assert.ok(preprocessed[0].raw_content.includes('입장하셨습니다'), '⚠ 호가 라인이 오염된다');

  // 평서형은 정상적으로 걷힌다.
  const ok = parseKbondLog('트레이더03님이 퇴장하였습니다.');
  assert.equal(ok.stats.system_messages, 1);
});

// ══════════════════════════════════════════════════════════════════════════
// 5. 픽스처 집계 고정 — B-6 수정의 영향 범위가 여기서 드러난다
// ══════════════════════════════════════════════════════════════════════════

const rv1 = parseKbondQuotes(fixtureText);

test('픽스처 — parseKbondQuotes 집계 (RV-1 현행)', () => {
  assert.equal(rv1.stats.total_lines, 5225);
  assert.equal(rv1.stats.preprocessed, 3842);
  assert.equal(rv1.stats.excluded_cp_cd, 148);
  assert.equal(rv1.stats.excluded_general_interest, 90, 'NON_INDIVIDUAL_RE — RV-2 에선 수요 신호(§2.2-A)');
  assert.equal(rv1.stats.excluded_no_side, 25);
  assert.equal(rv1.stats.quotes_total, 3579);
  assert.deepEqual(rv1.stats.confidence, { high: 3051, medium: 380, low: 148 });
});

test('픽스처 — spread_type 분포 (RV-1 현행)', () => {
  const dist = {};
  for (const q of rv1.quotes) dist[q.spread_type || '(null)'] = (dist[q.spread_type || '(null)'] || 0) + 1;
  assert.deepEqual(dist, { won: 869, flat: 2405, absolute: 139, bp: 52, '(null)': 114 });
});

test('⚠ B-6 픽스처 실측 — flat 2,405건 중 94.5% 가 폴백이다', () => {
  // rv-parser.js:156 의 명시 flat 정규식과 동일. 이 조건에 걸리지 않은 flat = 폴백.
  const EXPLICIT = /민\s*(?:팔자|사자)|플랫|flat(?:\s|$)|\.\.(?:팔자|사자)/i;
  const flats = rv1.quotes.filter((q) => q.spread_type === 'flat');
  assert.equal(flats.length, 2405);
  assert.equal(flats.filter((q) => EXPLICIT.test(q.raw_line)).length, 133, '명시 flat');

  const fallback = flats.filter((q) => !EXPLICIT.test(q.raw_line));
  assert.equal(fallback.length, 2272, '폴백 flat');
  // ↓ 이 1,963건이 quoteYield 에서 "민평에 판다"가 되어 원괴리 0 으로 횡단면에 유입된다.
  //   전체 호가 3,579건의 54.8%. B-6 을 1순위로 올린 근거다.
  assert.equal(fallback.filter((q) => q.minpyeong_yield != null).length, 1963);
  assert.equal(fallback.filter((q) => q.minpyeong_yield == null).length, 309);
});

test('⚠ B-6 픽스처 실측 — 원괴리 0 으로 유입되는 호가 비율', () => {
  // quoteYield 는 민평이 있고 spread_type 이 bp/absolute/won 중 어느 것도 아니면
  // 전부 '민평flat' 으로 떨어뜨린다 — 폴백 flat 뿐 아니라 **spread_type=null** 도 포함된다.
  const contaminated = rv1.quotes.filter((q) => quoteYield(q).basis === '민평flat');
  assert.equal(contaminated.length, 2152);
  assert.equal(Math.round((contaminated.length / rv1.stats.quotes_total) * 1000) / 10, 60.1,
    '전체 호가의 60.1% 가 원괴리 0 으로 횡단면에 들어온다');

  // 내역: 명시 flat(정당) / 폴백 flat(B-6) / spread_type null(레벨도 방향표현도 없음)
  const EXPLICIT = /민\s*(?:팔자|사자)|플랫|flat(?:\s|$)|\.\.(?:팔자|사자)/i;
  const byKind = { explicitFlat: 0, fallbackFlat: 0, nullType: 0 };
  for (const q of contaminated) {
    if (q.spread_type === 'flat') (EXPLICIT.test(q.raw_line) ? byKind.explicitFlat++ : byKind.fallbackFlat++);
    else byKind.nullType++;
  }
  // 폴백 flat 1,963건 중 4건은 actual_yield 가 있어 basis 'actual' 로 빠진다 → 1,959.
  assert.deepEqual(byKind, { explicitFlat: 107, fallbackFlat: 1959, nullType: 86 });
});
