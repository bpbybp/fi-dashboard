// rv2-ui 순수 로직 테스트 — node --test (인자 없이 자동탐색).
// 초점: **§1.7 저장 규약**. RV-1 은 동일 키를 덮어쓰고 RV-2 는 append 하는데,
// 이 차이가 설계 전체가 걸린 지점이라 렌더와 무관하게 따로 못 박는다.
// DOM 을 건드리는 렌더 함수는 여기서 다루지 않는다(모듈 최상위에 DOM 접근이 없어 import 가능).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  accumulate, currentQuotes, todayKey, bucketDemand, sessionCounts,
  demandKey, unclassifiedKey, mergeKeyed,
  TENOR_KEYS, TENOR_UNKNOWN, tenorKeyOf, tenorCounts, applyTenorFilter, tenorGroupsOf,
} from '../js/rv2-ui.js';
import { buildBuckets, RV2_TENOR_GRID } from '../js/rv2-buckets.js';
import { parseRv2 } from '../js/rv2-parser.js';

const emptySession = () => ({ dateKey: '2026-08-05', instruments: {}, demand: [], unclassified: [] });
const quotesOf = (...lines) => parseRv2(lines.join('\n')).quotes;

test('todayKey — 로컬 날짜를 쓴다 (UTC 로 자르면 오전 9시 이전이 전날이 된다)', () => {
  // 한국시간 2026-08-05 08:00 = UTC 2026-08-04 23:00. 로컬 기준이면 08-05 여야 한다.
  assert.equal(todayKey(new Date(2026, 7, 5, 8, 0, 0)), '2026-08-05');
  assert.equal(todayKey(new Date(2026, 0, 9, 23, 30, 0)), '2026-01-09', '한 자리 월·일 0 패딩');
});

test('§1.7 — 같은 시각·같은 레벨은 재붙여넣기로 보고 스킵한다', () => {
  const s = emptySession();
  const line = '트레이더01 (09:00:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]';
  assert.equal(accumulate(s, quotesOf(line)).added, 1);
  // 같은 원문을 다시 붙여넣었다 — 시각도 레벨도 같다.
  assert.deepEqual(accumulate(s, quotesOf(line)), { added: 0, appended: 0, repeated: 1 });
  assert.equal(Object.values(s.instruments)[0].observations.length, 1);
});

test('§1.7 — 같은 레벨이라도 시각이 다르면 관측으로 쌓는다 (호가가 살아 있다는 관측)', () => {
  const s = emptySession();
  accumulate(s, quotesOf('트레이더01 (09:00:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]'));
  const c = accumulate(s, quotesOf('트레이더01 (09:30:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]'));
  assert.deepEqual(c, { added: 0, appended: 1, repeated: 0 });
  const inst = Object.values(s.instruments)[0];
  assert.equal(inst.observations.length, 2);
  // 관측은 2건이지만 **레벨 변동은 0건**이다 — 둘을 섞어 세면 수명주기를 오해한다.
  assert.equal(sessionCounts(s).levelChanged, 0);
});
test('§1.7 — 레벨이 바뀌면 덮어쓰지 않고 관측을 쌓는다 (수명주기 데이터)', () => {
  const s = emptySession();
  accumulate(s, quotesOf('트레이더01 (09:00:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]'));
  const c = accumulate(s, quotesOf('트레이더01 (10:00:00) : 28.1.10 중금(사) 언더1 팔자 (민3.751) [한화 0000-1021]'));
  assert.deepEqual(c, { added: 0, appended: 1, repeated: 0 });

  const inst = Object.values(s.instruments)[0];
  assert.equal(inst.observations.length, 2);
  assert.deepEqual(inst.observations.map((o) => o.q.offset_bp), [-3, -1], '−3bp → −1bp 로 물러선 이력이 남는다');
  assert.equal(inst.latest.offset_bp, -1, '랭킹에는 최신 관측을 쓴다');
  assert.equal(currentQuotes(s).length, 1, '호가는 여전히 1건');
});

test('§1.7 — 딜러가 다르면 같은 종목·같은 레벨이어도 별개 호가다', () => {
  const s = emptySession();
  accumulate(s, quotesOf(
    '트레이더01 (09:00:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]',
    '트레이더02 (09:01:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [케이프 0000-1099]',
  ));
  assert.equal(Object.keys(s.instruments).length, 2, '전화번호가 딜러 ID — 중복제거 주 키');
});

test('§1.7 — 방향이 다르면 별개 호가다', () => {
  const s = emptySession();
  accumulate(s, quotesOf(
    '트레이더01 (09:00:00) : 중금채 27.8.3 3.650 팔자 (민 3.610) [한화 0000-1021]',
    '트레이더01 (09:01:00) : 중금채 27.8.3 3.650 사자 (민 3.610) [한화 0000-1021]',
  ));
  assert.equal(Object.keys(s.instruments).length, 2);
});

test('§1.7 — 오프셋 미상 호가도 저장한다 (랭킹에서만 빠진다)', () => {
  const s = emptySession();
  accumulate(s, quotesOf('트레이더01 (09:00:00) : 27.5.4(화) 지에스리테일34-2 (민 3.802) 팔자 [한화 0000-1021]'));
  const [q] = currentQuotes(s);
  assert.equal(q.offset_bp, null);
  assert.equal(q.offset_basis, 'unknown');
  assert.equal(Object.keys(s.instruments).length, 1, '버리지 않는다 — 미상 카운트의 모집단');
});

test('currentQuotes — instrument 당 최신 1건만 돌려준다', () => {
  const s = emptySession();
  accumulate(s, quotesOf('트레이더01 (09:00:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]'));
  accumulate(s, quotesOf('트레이더01 (10:00:00) : 28.1.10 중금(사) 언더1 팔자 (민3.751) [한화 0000-1021]'));
  const cur = currentQuotes(s);
  assert.equal(cur.length, 1);
  assert.equal(cur[0].offset_bp, -1);
});

// ── 사자 수요 격자 (§3.3) ───────────────────────────────────────────────

const gridOf = (r) => Object.fromEntries(r.grid.map((g) => [g.key, g.bid]));

test('수요 격자 — 구간이 걸치는 칸에 모두 센다 (한 칸으로 접지 않는다)', () => {
  // "1~5년 사자" 는 1-2·2-3·3-5 세 칸 모두에 수요가 있다. 한 칸으로 접으면 정보가 준다.
  const r = bucketDemand([{ tenor_lo: 1, tenor_hi: 5, side: 'bid' }]);
  assert.deepEqual(gridOf(r), { '~1y': 0, '1-2': 1, '2-3': 1, '3-5': 1, '5-10': 0, '10y+': 0 });
  assert.equal(r.unplaced, 0);
});

test('수요 격자 — 점 구간(1.5년)은 한 칸에만 들어간다', () => {
  assert.deepEqual(gridOf(bucketDemand([{ tenor_lo: 1.5, tenor_hi: 1.5, side: 'bid' }])),
    { '~1y': 0, '1-2': 1, '2-3': 0, '3-5': 0, '5-10': 0, '10y+': 0 });
});

test('수요 격자 — 상한 없는 "3년 이후" 는 3-5 부터 끝까지 센다', () => {
  assert.deepEqual(gridOf(bucketDemand([{ tenor_lo: 3, tenor_hi: null, side: 'bid' }])),
    { '~1y': 0, '1-2': 0, '2-3': 0, '3-5': 1, '5-10': 1, '10y+': 1 });
});

test('수요 격자 — "1년 이내" 는 ~1y 한 칸만 (상한이 칸 하한과 같으면 넘치지 않는다)', () => {
  assert.deepEqual(gridOf(bucketDemand([{ tenor_lo: 0, tenor_hi: 1, side: 'bid' }])),
    { '~1y': 1, '1-2': 0, '2-3': 0, '3-5': 0, '5-10': 0, '10y+': 0 });
});

test('수요 격자 — 방향별로 나눠 센다', () => {
  const r = bucketDemand([
    { tenor_lo: 2, tenor_hi: 3, side: 'bid' },
    { tenor_lo: 2, tenor_hi: 3, side: 'offer' },
  ]);
  const g = r.grid.find((x) => x.key === '2-3');
  assert.equal(g.bid, 1);
  assert.equal(g.offer, 1);
});

test('수요 격자 — 연 단위 표현이 없으면 미배정으로 센다 (버리지 않는다)', () => {
  const r = bucketDemand([
    { tenor_lo: null, tenor_hi: null, tenor_note: null, side: 'bid' },   // "국전전 사자관심"
    { tenor_lo: null, tenor_hi: null, tenor_note: 'calendar', side: 'bid' }, // "28년 초"
  ]);
  assert.equal(r.unplaced, 2);
  assert.deepEqual(gridOf(r), { '~1y': 0, '1-2': 0, '2-3': 0, '3-5': 0, '5-10': 0, '10y+': 0 });
});

// ── 만기구간 표시 계층 (v1.1) ───────────────────────────────────────────
//
// 핵심 불변식: **필터는 표시만 거른다.** 버킷 중앙값·MAD·이상치·n 은 리프 전체 기준이며
// 필터와 무관하다(Phase 2 결정 "만기는 통계 축이 아니다" 유지).

const row = (tenor, adj, extra = {}) => ({ tenor, adjustedOffset: adj, rating_basis: 'unknown', ...extra });

test('격자는 rv2-buckets 단일 소스를 재사용한다 (UI 재정의 금지)', () => {
  assert.deepEqual(TENOR_KEYS, [...RV2_TENOR_GRID.map((g) => g.key), '미상']);
  assert.equal(TENOR_UNKNOWN, '미상');
});

test('tenorKeyOf — 만기 미상(B-9 잔여)은 숨기지 않고 미상 칸으로 보낸다', () => {
  assert.equal(tenorKeyOf({ tenor: '2-3' }), '2-3');
  assert.equal(tenorKeyOf({ tenor: null }), '미상');
  assert.equal(tenorKeyOf({}), '미상');
});

test('tenorCounts — 0인 구간은 담지 않는다 (헤더 미니 카운트가 0을 생략한다)', () => {
  const c = tenorCounts([row('~1y', 1), row('~1y', 2), row('2-3', 3), row(null, 4)]);
  assert.deepEqual(c, { '~1y': 2, '2-3': 1, 미상: 1 });
  assert.ok(!('1-2' in c));
});

test('applyTenorFilter — 빈 집합은 전체 표시(필터 없음)', () => {
  const rows = [row('~1y', 1), row('2-3', 2)];
  assert.equal(applyTenorFilter(rows, new Set()).length, 2);
  assert.equal(applyTenorFilter(rows, null).length, 2);
});

test('applyTenorFilter — 복수 선택이 OR 로 동작하고 미상도 고를 수 있다', () => {
  const rows = [row('~1y', 1), row('1-2', 2), row('2-3', 3), row(null, 4)];
  assert.deepEqual(applyTenorFilter(rows, new Set(['~1y', '2-3'])).map((r) => r.adjustedOffset), [1, 3]);
  assert.deepEqual(applyTenorFilter(rows, new Set(['미상'])).map((r) => r.adjustedOffset), [4]);
});

test('필터는 표시만 거른다 — 통계 모집단(n·중앙값·MAD)은 건드리지 않는다', () => {
  // 이 테스트가 v1.1 의 핵심 계약이다. buildBuckets 입력은 필터 전 전체여야 한다.
  const quotes = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((v, i) => ({
    issuer_raw: '중금채', offset_bp: v, is_cp_cd: false, rating: null,
    maturity_date: i < 5 ? '2027-01-01' : '2031-01-01', side: 'offer',
  }));
  const { leaves, rows } = buildBuckets(quotes, { todayStr: '2026-08-05' });
  const b = leaves.get('특은');
  assert.equal(b.n, 9);
  assert.equal(b.median, 5);

  // 표시를 한 구간으로 좁혀도 위 값은 그대로다 — 필터는 rows 만 자른다.
  const shown = applyTenorFilter(rows, new Set(['~1y']));
  assert.ok(shown.length < rows.length, '표시 건수는 줄어든다');
  assert.equal(leaves.get('특은').n, 9, 'n 불변');
  assert.equal(leaves.get('특은').median, 5, '중앙값 불변');
  assert.equal(leaves.get('특은').mad, b.mad, 'MAD 불변');
  // 이상치 판정도 전체 기준으로 이미 붙어 있다.
  assert.deepEqual(shown.map((r) => r.outlier), shown.map(() => false));
});

test('tenorGroupsOf — 격자 순서대로, 미상은 마지막', () => {
  const g = tenorGroupsOf([row('10y+', 1), row(null, 2), row('~1y', 3), row('2-3', 4)]);
  assert.deepEqual(g.map((x) => x.key), ['~1y', '2-3', '10y+', '미상']);
});

test('tenorGroupsOf — 관측이 없는 구간은 그룹 자체가 없다', () => {
  const g = tenorGroupsOf([row('2-3', 1)]);
  assert.deepEqual(g.map((x) => x.key), ['2-3']);
});

test('tenorGroupsOf — 그룹 내 정렬은 조정오프셋 내림차순 (리프 안에선 offset_bp 순과 동일)', () => {
  // 같은 리프 안에서는 버킷 중앙값이 상수라 두 정렬이 같은 순서를 준다 — 순위 의미론 불변.
  const g = tenorGroupsOf([row('1-2', -1), row('1-2', 5), row('1-2', 2)]);
  assert.deepEqual(g[0].rows.map((r) => r.adjustedOffset), [5, 2, -1]);
});

// ── Phase 4 회귀: 붙여넣기 시나리오 4종의 최종 상태 동일성 ──────────────
//
// 장중 수시 복사가 기본 워크플로다. 어떻게 잘라 붙이든 최종 상태가 같아야 한다.
// 2026-08-05 실측에서 겹치는 재복사가 관측을 이중 계상하던 것을 고친 뒤 고정한다.

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kbond-sample.masked.txt');
const FIXTURE = readFileSync(FIXTURE_PATH, 'utf8');

function runPastes(...texts) {
  const s = emptySession();
  for (const t of texts) {
    const r = parseRv2(t);
    accumulate(s, r.quotes);
    mergeKeyed(s.demand, r.demand, demandKey);
    mergeKeyed(s.unclassified, r.unclassified, unclassifiedKey);
  }
  return { ...sessionCounts(s), demand: s.demand.length, unclassified: s.unclassified.length };
}

test('붙여넣기 4종 — 일괄 / 3분할 / 동일 2회 / 겹침이 모두 같은 최종 상태', () => {
  const L = FIXTURE.split('\n');
  const a = Math.floor(L.length / 3), b = Math.floor((L.length * 2) / 3);
  const c1 = L.slice(0, a).join('\n'), c2 = L.slice(a, b).join('\n'), c3 = L.slice(b).join('\n');
  const twoThirds = L.slice(0, b).join('\n');

  const whole = runPastes(FIXTURE);
  assert.deepEqual(whole, {
    quotes: 957, observations: 3596, levelChanged: 168, demand: 129, unclassified: 117,
  }, '기준 상태 — 관측은 메시지 단위, 레벨 변동은 별개 지표');

  assert.deepEqual(runPastes(c1, c2, c3), whole, '3분할 순차');
  assert.deepEqual(runPastes(FIXTURE, FIXTURE), whole, '동일 원문 2회');
  assert.deepEqual(runPastes(twoThirds, FIXTURE), whole, '겹치는 창 재복사');
  assert.deepEqual(runPastes(c1, c1, c2, FIXTURE, c3), whole, '뒤죽박죽 중복');
});

test('§1.7 — A→B→A 레벨 회귀는 관측으로 남는다 (되돌린 사실이 정보다)', () => {
  const s = emptySession();
  const at = (t, u) => `트레이더01 (${t}) : 28.1.10 중금(사) 언더${u} 팔자 (민3.751) [한화 0000-1021]`;
  accumulate(s, quotesOf(at('09:00:00', 3)));
  accumulate(s, quotesOf(at('10:00:00', 1)));
  const back = accumulate(s, quotesOf(at('11:00:00', 3))); // 원래 레벨로 회귀
  assert.deepEqual(back, { added: 0, appended: 1, repeated: 0 }, '마지막 관측만 보면 놓치는 케이스');

  const inst = Object.values(s.instruments)[0];
  assert.deepEqual(inst.observations.map((o) => o.q.offset_bp), [-3, -1, -3]);
  assert.equal(inst.latest.offset_bp, -3);
  assert.equal(sessionCounts(s).levelChanged, 1, '서로 다른 레벨이 2종 이상 = 변동 있음');

  // 그 상태에서 전체를 재붙여넣어도 늘지 않는다.
  const again = accumulate(s, quotesOf(at('09:00:00', 3), at('10:00:00', 1), at('11:00:00', 3)));
  assert.deepEqual(again, { added: 0, appended: 0, repeated: 3 });
  assert.equal(inst.observations.length, 3);
});

test('수요·미분류 중복 키 — 딜러·발화자 + 시각 + 원문', () => {
  const d1 = { dealer_phone: '0000-1021', timestamp: '09:00:00', raw_line: '2년  산금  사자' };
  const d1ws = { ...d1, raw_line: '2년 산금 사자' }; // 공백만 다름 → 같은 수요
  const d2 = { ...d1, timestamp: '10:00:00' };       // 시각만 다름 → 별개 관측(수요 지속)
  const d3 = { ...d1, dealer_phone: '0000-9999' };   // 딜러만 다름 → 별개
  const list = [];
  assert.equal(mergeKeyed(list, [d1, d1ws], demandKey), 1, '공백 차이는 같은 수요');
  assert.equal(mergeKeyed(list, [d2], demandKey), 1, '시각이 다르면 수요 지속의 실측이므로 남긴다');
  assert.equal(mergeKeyed(list, [d3], demandKey), 1, '딜러가 다르면 별개');
  assert.equal(mergeKeyed(list, [d1, d2, d3], demandKey), 0, '재붙여넣기는 전부 스킵');
  assert.equal(list.length, 3);

  const u = { trader_name: '트레이더01', timestamp: '09:00:00', raw: '[채용공고] 어쩌고' };
  const ulist = [];
  assert.equal(mergeKeyed(ulist, [u, { ...u }], unclassifiedKey), 1);
  assert.equal(mergeKeyed(ulist, [{ ...u, timestamp: '09:05:00' }], unclassifiedKey), 1);
});
