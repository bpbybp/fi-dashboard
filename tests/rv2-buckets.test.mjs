// rv2-buckets 단위 테스트 — node --test (인자 없이 자동탐색).
// 초점: 분류 축(섹터·등급·만기)의 판정 규칙과 표본 가드. 오프셋 값 자체는 rv2-parser 소관.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RV2_MIN_BUCKET_SAMPLE, RV2_MAD_K, RV2_TENOR_GRID, RWA0_ISSUERS, RWA20_ISSUERS,
  ISSUER_RATING_MAP, RANKING_EXCLUDED_SECTORS, SUBSECTOR_BY_RWA,
  RV2_STAT_TENOR_KEYS, statTenorOf,
  normalizeIssuer, classifySector, resolveRating, tenorBucket, tenorBucketFromYears,
  mad, annotate, buildBuckets,
} from '../js/rv2-buckets.js';
import { parseRv2 } from '../js/rv2-parser.js';

const TODAY = '2026-08-05'; // 픽스처 원문 일자. Date.now() 를 쓰지 않는다 — 테스트가 날짜에 흔들리면 안 된다.
const q = (o) => ({ issuer_raw: null, rating: null, maturity_date: null, offset_bp: null, is_cp_cd: false, ...o });

// ── 상수 ────────────────────────────────────────────────────────────────

test('상수 — 표본 가드 n=8, MAD k=2.5 (§6 결정 1·2)', () => {
  assert.equal(RV2_MIN_BUCKET_SAMPLE, 8);
  assert.equal(RV2_MAD_K, 2.5);
  assert.equal(RV2_TENOR_GRID.length, 6);
  assert.deepEqual(RV2_TENOR_GRID.map((g) => g.key), ['~1y', '1-2', '2-3', '3-5', '5-10', '10y+']);
});

test('RWA — §2.2 확정 리스트가 반영돼 있다', () => {
  for (const k of ['토지주택', '장학재단', '중벤공', '주금공', '자산관리공사', '신용보증기금', '기술보증기금']) {
    assert.ok(RWA0_ISSUERS.includes(k), `RWA0 누락: ${k}`);
  }
  for (const k of ['한국전력', '도로공사', '가스공사', '철도공사', '수자원공사']) {
    assert.ok(RWA20_ISSUERS.includes(k), `RWA20 누락: ${k}`);
  }
});

test('공사·공단 3분할 — 신명칭을 쓰되 RWA 속성은 보존한다 (v2 대비)', () => {
  const cases = [
    ['토지주택채권155', 'RWA0', '중앙공사(보증·기금계)'],
    ['도로공사978', 'RWA20', '중앙공사(SOC·에너지계)'],
    ['인천도시공사238', '기타', '지방공기업'],
  ];
  for (const [name, rwa, subsector] of cases) {
    const r = classifySector(q({ issuer_raw: name }));
    assert.equal(r.sector, '공사·공단', name);
    assert.equal(r.rwa, rwa, `${name}: RWA 속성은 계속 보존한다`);
    assert.equal(r.subsector, subsector, name);
    assert.equal(r.leaf, subsector, '리프 라벨은 신명칭. 섹터는 롤업 단계로만 남는다');
  }
  assert.deepEqual(SUBSECTOR_BY_RWA, {
    RWA0: '중앙공사(보증·기금계)',
    RWA20: '중앙공사(SOC·에너지계)',
    기타: '지방공기업',
  });
});

test('RWA — 회차가 붙어도 잡는다 (부분 문자열 매칭)', () => {
  // 정확일치였다면 원문의 `도로공사978`·`한국전력1477` 을 하나도 못 잡는다.
  assert.equal(classifySector(q({ issuer_raw: '도로공사978' })).leaf, '중앙공사(SOC·에너지계)');
  assert.equal(classifySector(q({ issuer_raw: '한국전력1477' })).leaf, '중앙공사(SOC·에너지계)');
  assert.equal(classifySector(q({ issuer_raw: '한전1415' })).leaf, '중앙공사(SOC·에너지계)', '한전=한국전력');
  assert.equal(classifySector(q({ issuer_raw: '토지주택채권155' })).leaf, '중앙공사(보증·기금계)');
  assert.equal(classifySector(q({ issuer_raw: '중벤공787' })).leaf, '중앙공사(보증·기금계)');
});

test('RWA — 분기는 섹터 우선. 특은 소속은 공사 세분화에 쓰이지 않는다 (§2.2 주의사항)', () => {
  // 산업은행·중소기업은행·수출입은행은 RWA0 리스트에 있지만 섹터가 특은이다.
  for (const name of ['산금채', '중금채', '수출입채']) {
    const r = classifySector(q({ issuer_raw: name }));
    assert.equal(r.sector, '특은', name);
    assert.equal(r.rwa, null, '특은 리프는 RWA 하위축을 갖지 않는다');
    assert.ok(!r.leaf.includes('RWA'));
  }
});

test('RWA — 철도공사와 국가철도공단은 별개 발행사이되 둘 다 RWA20', () => {
  assert.equal(classifySector(q({ issuer_raw: '국가철도공단410' })).leaf, '중앙공사(SOC·에너지계)');
  assert.equal(classifySector(q({ issuer_raw: '한국철도공사12' })).leaf, '중앙공사(SOC·에너지계)');
});

test('RWA — §2.2 에 없는 발행사는 기타로 둔다', () => {
  assert.equal(classifySector(q({ issuer_raw: '경기주택도시공사' })).leaf, '지방공기업');
  assert.equal(classifySector(q({ issuer_raw: '인천도시공사238' })).leaf, '지방공기업');
  // `연합자산관리`(UAMCO)는 `자산관리공사`(캠코)가 아니다 — 부분 문자열이 겹치지 않는다.
  assert.equal(classifySector(q({ issuer_raw: '연합자산관리' })).sector, '회사채');
});

test('섹터 — 은행지주는 은행 리프로 새지 않는다', () => {
  for (const name of ['우리금융지주28', '신한지주168-1', '신한금융지주', 'BNK금융지주47', 'KB금융12', '하나금융지주3', '농협금융지주1']) {
    assert.equal(classifySector(q({ issuer_raw: name })).sector, '은행지주', name);
  }
  // 은행 본체는 그대로 은행 리프다.
  assert.equal(classifySector(q({ issuer_raw: '신한은행' })).sector, '시은-시중계');
  assert.equal(classifySector(q({ issuer_raw: '농금은행' })).sector, '특은');
  // 지주는 등급 역매핑 대상이 아니다 — 은행 본체 AAA 를 지주에 그대로 쓰면 안 된다.
  assert.equal(resolveRating(q({ issuer_raw: '신한지주168-1' })).rating_basis, 'unknown');
});

test('섹터 — 유동화·ABS 는 분류만 하고 랭킹·집계에서 뺀다', () => {
  const r = classifySector(q({ issuer_raw: '뉴스타비산유동화전문' }));
  assert.equal(r.sector, '유동화·ABS');
  assert.ok(RANKING_EXCLUDED_SECTORS.has('유동화·ABS'), 'CP·CD·전단채와 동일 취급');
  assert.equal(classifySector(q({ issuer_raw: '엠에이치수표제일차' })).sector, '유동화·ABS');

  // 구조화 상품이 일반 채권 모집단에 섞이면 중앙값이 오염된다.
  const { leaves, session } = buildBuckets([
    q({ issuer_raw: '뉴스타비산유동화전문', offset_bp: 99 }),
    q({ issuer_raw: '중금채', offset_bp: 1 }),
  ], { todayStr: TODAY });
  assert.ok(!leaves.has('유동화·ABS'));
  assert.equal(session.n, 1);
});

// ── 발행사 정규화 ───────────────────────────────────────────────────────

test('normalizeIssuer — 레벨·민평 잔여물을 걷어낸다', () => {
  assert.equal(normalizeIssuer('중금 언더4'), '중금');
  assert.equal(normalizeIssuer('아이비케이캐피탈355-5 민'), '아이비케이캐피탈355-5');
  assert.equal(normalizeIssuer('수금은행 [만 3.127]'), '수금은행');
  assert.equal(normalizeIssuer('SBS14-2 민평.964'), 'SBS14-2');
  assert.equal(normalizeIssuer('도로공사978 오버5'), '도로공사978');
  assert.equal(normalizeIssuer('토지주택채권155 KR3561037291'), '토지주택채권155');
});

test('normalizeIssuer — `국민은행` 의 민을 민평으로 오인하지 않는다', () => {
  // 민평 정규식이 숫자를 요구하지 않으면 `국민은행` → `국 은행` 이 되어 섹터 판정이 무너진다.
  // 실측으로 확인된 함정이라 회귀 테스트로 못 박는다.
  assert.equal(normalizeIssuer('국민은행'), '국민은행');
  assert.equal(classifySector(q({ issuer_raw: '국민은행' })).sector, '시은-시중계');
  assert.equal(normalizeIssuer('국민주택25-02 민평'), '국민주택25-02');
});

// ── 1축 섹터 ────────────────────────────────────────────────────────────

test('섹터 — 특은. 수협은행 귀속을 명시한다 (§6 결정 4)', () => {
  for (const name of ['중금채', '산금채', '기업은행', '수출입채', '농금은행']) {
    assert.equal(classifySector(q({ issuer_raw: name })).sector, '특은', name);
  }
  // "수금" = 수협은행(rv-abbrev 확정). 수협중앙회도 같은 특수채 계열로 둔다.
  assert.equal(classifySector(q({ issuer_raw: '수금은행' })).sector, '특은');
  assert.equal(classifySector(q({ issuer_raw: '수협은행' })).sector, '특은');
  assert.equal(classifySector(q({ issuer_raw: '수협중앙회' })).sector, '특은');
});

test('섹터 — 은행 3분류가 서로 새지 않는다', () => {
  assert.equal(classifySector(q({ issuer_raw: '신한은행' })).sector, '시은-시중계');
  assert.equal(classifySector(q({ issuer_raw: '우리채' })).sector, '시은-시중계');
  assert.equal(classifySector(q({ issuer_raw: '카카오뱅크12' })).sector, '시은-비시중계');
  // 지방은행 규칙이 시은보다 먼저여야 `부산은행` 이 시중계로 새지 않는다.
  assert.equal(classifySector(q({ issuer_raw: '부산은행26-1' })).sector, '지방은행');
  assert.equal(classifySector(q({ issuer_raw: '전북은행' })).sector, '지방은행');
});

test('섹터 — 공사·공단은 RWA 하위축을 갖는다. 중벤공은 은행이 아니라 공단이다', () => {
  const r = classifySector(q({ issuer_raw: '인천도시공사238' }));
  assert.equal(r.sector, '공사·공단');
  assert.equal(r.leaf, '지방공기업');
  // 중소벤처기업진흥공단 — §2.2 가 RWA0 실효 대상으로 공사·공단에 둔다(특은 아님).
  assert.equal(classifySector(q({ issuer_raw: '중벤공787' })).sector, '공사·공단');
  // 다른 섹터는 rwa 를 갖지 않는다.
  assert.equal(classifySector(q({ issuer_raw: '중금채' })).rwa, null);
});

test('섹터 — 여전 카드/캐피탈 분리. 축약 표기까지 잡는다', () => {
  assert.equal(classifySector(q({ issuer_raw: '현대카드955-4' })).sector, '여전-카드');
  assert.equal(classifySector(q({ issuer_raw: '롯카' })).sector, '여전-카드');
  assert.equal(classifySector(q({ issuer_raw: '메리츠캐피탈292-3' })).sector, '여전-캐피탈');
  // `캐피` 만으로는 안 잡히는 실데이터 축약들 — 이게 없으면 회사채로 오분류된다.
  for (const name of ['IBK캐355-5', 'KB캐577-3', '아이비캐', '산은캐', '현대커머셜574-2']) {
    assert.equal(classifySector(q({ issuer_raw: name })).sector, '여전-캐피탈', name);
  }
  // 카드 규칙이 캐피탈보다 먼저다 — `신한카드` 가 캐피탈로 새면 안 된다.
  assert.equal(classifySector(q({ issuer_raw: '신한카드2206-4' })).sector, '여전-카드');
});

test('섹터 — 국고·통안, 지방채, 증권채', () => {
  assert.equal(classifySector(q({ issuer_raw: '국고이자' })).sector, '국고·통안');
  assert.equal(classifySector(q({ issuer_raw: '국주 23-05' })).sector, '국고·통안');
  assert.equal(classifySector(q({ issuer_raw: '대구광역시채권2025-1' })).sector, '지방채');
  assert.equal(classifySector(q({ issuer_raw: '서울특별시채권 2024-1' })).sector, '지방채');
  assert.equal(classifySector(q({ issuer_raw: '삼성증권20-2' })).sector, '증권채');
});

test('섹터 — CP·CD·전단채는 분류만 하고 랭킹에서 뺀다', () => {
  const r = classifySector(q({ issuer_raw: '키움증권 전단채', is_cp_cd: true }));
  assert.equal(r.sector, 'CP·CD·전단채');
  assert.equal(r.sector_basis, 'cp_cd');
  assert.ok(RANKING_EXCLUDED_SECTORS.has(r.sector));
  // is_cp_cd 가 다른 모든 규칙을 이긴다(증권채로 새지 않는다).
});

test('섹터 — 매칭 실패는 회사채 default 로 두되 basis 로 구분한다', () => {
  const r = classifySector(q({ issuer_raw: 'LG화학58-2' }));
  assert.equal(r.sector, '회사채');
  assert.equal(r.sector_basis, 'default', '추정임을 남긴다');
  assert.equal(classifySector(q({ issuer_raw: '중금채' })).sector_basis, 'matched');
  // 발행사 자체가 없으면 회사채로 추정하지 않는다 — 모른다고 말한다.
  assert.equal(classifySector(q({ issuer_raw: null })).sector, '분류미상');
  assert.equal(classifySector(q({ issuer_raw: null })).sector_basis, 'unknown');
});

// ── 2축 등급 ────────────────────────────────────────────────────────────

test('등급 — 원문 명시가 역매핑을 이긴다', () => {
  // 중금채는 역매핑상 AAA 지만, 원문에 AA+ 가 찍혀 있으면 원문을 따른다.
  const r = resolveRating(q({ issuer_raw: '중금채', rating: 'AA+' }));
  assert.deepEqual(r, { rating: 'AA+', rating_basis: 'explicit' });
});

test('등급 — 역매핑은 AAA 확정군만. 확신 없으면 미상으로 남긴다', () => {
  assert.deepEqual(resolveRating(q({ issuer_raw: '산금채' })), { rating: 'AAA', rating_basis: 'issuer_mapped' });
  assert.deepEqual(resolveRating(q({ issuer_raw: '한국전력1477' })), { rating: 'AAA', rating_basis: 'issuer_mapped' });

  // ↓ 등급이 갈리거나 시점에 따라 움직이는 발행사는 **넣지 않는다.**
  //   미상은 "모른다"일 뿐이지만, 틀린 등급은 버킷 중앙값을 오염시킨다.
  for (const name of ['현대카드955-4', '대한항공118-1', '경기주택도시공사', '전북은행', 'LG화학58-2']) {
    assert.equal(resolveRating(q({ issuer_raw: name })).rating_basis, 'unknown', name);
  }
  // `국은채` 는 섹터로는 시중계로 보지만 등급 역매핑은 하지 않는다(원문 축약이라 확정 불가).
  assert.equal(resolveRating(q({ issuer_raw: '국은채' })).rating_basis, 'unknown');
});

test('등급 — 역매핑 사전에 중복 키가 없다', () => {
  const keys = ISSUER_RATING_MAP.map(([k]) => k);
  assert.equal(new Set(keys).size, keys.length);
});

// ── 만기 격자 ───────────────────────────────────────────────────────────

test('만기 격자 — 경계는 하한 포함·상한 배제', () => {
  assert.equal(tenorBucketFromYears(0.5), '~1y');
  assert.equal(tenorBucketFromYears(1), '1-2');
  assert.equal(tenorBucketFromYears(1.999), '1-2');
  assert.equal(tenorBucketFromYears(3), '3-5');
  assert.equal(tenorBucketFromYears(10), '10y+');
  assert.equal(tenorBucketFromYears(30), '10y+');
});

test('만기 격자 — 과거 만기·미상은 격자에 올리지 않는다', () => {
  assert.equal(tenorBucketFromYears(-0.5), null, '과거 만기(B-9 잔여)는 제외');
  assert.equal(tenorBucketFromYears(null), null);
  assert.equal(tenorBucket(null, TODAY), null);
  // 365일은 365.25로 나눠 0.999년이라 `~1y` 다. 경계가 율리우스년 기준임을 못 박는다.
  assert.equal(tenorBucket('2027-08-05', TODAY), '~1y');
  assert.equal(tenorBucket('2027-08-07', TODAY), '1-2');
  assert.equal(tenorBucket('2029-02-01', TODAY), '2-3');
  assert.equal(tenorBucket('2029-08-05', TODAY), '3-5');
});

// ── MAD ─────────────────────────────────────────────────────────────────

test('MAD — 이상치 1건이 기준을 흔들지 않는다 (평균±표준편차 금지 근거)', () => {
  const base = [1, 2, 3, 4, 5];
  assert.equal(mad(base), 1);
  // 100 을 하나 넣어도 MAD 는 거의 안 움직인다. 표준편차였다면 40 가까이 뛴다.
  assert.equal(mad([...base, 100]), 1.5);
  assert.equal(mad([]), null);
});

// ── 집계 + 표본 가드 ────────────────────────────────────────────────────

test('가드 — 판정은 offset_bp 유효 관측 기준이다 (미상은 세지 않는다)', () => {
  // 유효 3건 + 미상 20건. 미상을 세면 n=23 으로 "표본이 있다"고 오인한다.
  const quotes = [
    ...Array.from({ length: 3 }, (_, i) => q({ issuer_raw: '삼성증권20-2', offset_bp: i })),
    ...Array.from({ length: 20 }, () => q({ issuer_raw: '삼성증권20-2', offset_bp: null })),
  ];
  const { leaves } = buildBuckets(quotes, { todayStr: TODAY });
  const b = leaves.get('증권채');
  assert.equal(b.n, 3, '유효 관측만 센다');
  assert.equal(b.missing, 20, '미상은 버리지 않고 함께 보고한다');
});

test('가드 — n<8 리프는 섹터 → 세션 순으로 롤업한다', () => {
  const mk = (issuer, n, off) => Array.from({ length: n }, () => q({ issuer_raw: issuer, offset_bp: off }));
  // 만기가 없는 관측이라 **통계 칸이 만들어지지 않는다**(만기 미상 = B-9 잔재, 칸 아님).
  // 공사·공단/RWA20 10건(중앙값 5) + 지방채 2건(중앙값 -3)
  const { rows, leaves } = buildBuckets([...mk('한국전력1477', 10, 5), ...mk('대구광역시채권1', 2, -3)], { todayStr: TODAY });
  assert.equal(leaves.get('중앙공사(SOC·에너지계)').n, 10);
  assert.equal(leaves.get('지방채').n, 2);

  const gongsa = rows.find((r) => r.sector === '공사·공단');
  assert.equal(gongsa.cell, null, '만기 미상 → 칸 없음');
  assert.equal(gongsa.medianSource, '섹터롤업', '칸이 없으면 섹터 리프 통계를 쓴다');
  assert.equal(gongsa.medianUsed, 5);

  const jibang = rows.find((r) => r.sector === '지방채');
  // 지방채는 칸도 리프도 섹터도 n=2 라 세션으로 내려간다.
  assert.equal(jibang.medianSource, '세션롤업');
  assert.equal(jibang.medianUsed, 5, '세션 12건의 중앙값');
});

test('가드 경계 — n=7 은 롤업, n=8 은 자기 칸 (v1.2)', () => {
  const mk = (n, off, maturity) => Array.from({ length: n }, () => q({
    issuer_raw: '중금채', offset_bp: off, maturity_date: maturity, side: 'offer',
  }));
  // 특은 · ~1y 에 7건(중앙값 5), 특은 · 1-2 에 20건(중앙값 1) → 리프 27건.
  const seven = buildBuckets([...mk(7, 5, '2027-01-01'), ...mk(20, 1, '2028-03-01')], { todayStr: TODAY });
  const r7 = seven.rows.find((r) => r.statTenor === '~1y');
  assert.equal(seven.cells.get('특은 · ~1y').n, 7);
  assert.equal(r7.medianSource, '섹터롤업', 'n=7 → 칸 통계를 쓰지 않는다');
  assert.equal(r7.medianUsed, seven.leaves.get('특은').median);

  // 한 건만 늘려 8이 되면 자기 칸을 쓴다.
  const eight = buildBuckets([...mk(8, 5, '2027-01-01'), ...mk(20, 1, '2028-03-01')], { todayStr: TODAY });
  const r8 = eight.rows.find((r) => r.statTenor === '~1y');
  assert.equal(eight.cells.get('특은 · ~1y').n, 8);
  assert.equal(r8.medianSource, '칸');
  assert.equal(r8.medianUsed, 5);
});

test('통계 격자 — 표시 6칸이 통계 3칸으로 접힌다 (매핑 단일 정의)', () => {
  assert.deepEqual(RV2_STAT_TENOR_KEYS, ['~1y', '1-2', '2y+']);
  assert.equal(statTenorOf('~1y'), '~1y');
  assert.equal(statTenorOf('1-2'), '1-2');
  for (const k of ['2-3', '3-5', '5-10', '10y+']) assert.equal(statTenorOf(k), '2y+', k);
  // 만기 미상은 칸이 아니다 — B-9 잔재라 "만기 구간"으로 부를 수 없다. 섹터로 롤업한다.
  assert.equal(statTenorOf(null), null);
  assert.equal(statTenorOf('미상'), null);

  const rows = buildBuckets([q({ issuer_raw: '중금채', offset_bp: 1, maturity_date: null, side: 'offer' })],
    { todayStr: TODAY }).rows;
  assert.equal(rows[0].statTenor, null);
  assert.equal(rows[0].cell, null, '칸을 만들지 않는다');
});

test('집계 — CP·CD 는 리프 집계에서 아예 빠진다', () => {
  const quotes = [
    q({ issuer_raw: '키움증권 전단채', is_cp_cd: true, offset_bp: 99 }),
    q({ issuer_raw: '중금채', offset_bp: 1 }),
  ];
  const { leaves, session, rows } = buildBuckets(quotes, { todayStr: TODAY });
  assert.ok(!leaves.has('CP·CD·전단채'), '집계 대상 아님');
  assert.equal(session.n, 1, 'CP/CD 가 세션 중앙값을 흔들면 안 된다');
  assert.equal(rows.find((r) => r.q.is_cp_cd).medianSource, '제외');
});

test('이상치 게이트 — k·MAD 밖은 표시하되 제외하지 않는다', () => {
  // 중앙값 4, MAD 2 → 임계 2.5×2 = 5. 50 만 밖이다.
  const vals = [0, 1, 2, 3, 4, 5, 6, 7, 50];
  const quotes = vals.map((v) => q({ issuer_raw: '중금채', offset_bp: v }));
  const { rows, leaves } = buildBuckets(quotes, { todayStr: TODAY });
  assert.equal(leaves.get('특은').n, 9, '이상치도 표본에는 남는다 — 제외가 아니라 표시가 목적');
  assert.equal(leaves.get('특은').mad, 2);
  assert.equal(rows.filter((r) => r.outlier).length, 1);
  assert.equal(rows.find((r) => r.outlier).q.offset_bp, 50);
});

test('이상치 게이트 — MAD=0 이면 아무도 표시하지 않는다 (의식적 선택)', () => {
  // 값이 거의 한 점에 몰리면 MAD 가 0 이 되고, 임계도 0 이 되어 **미세한 차이까지 전부**
  // 이상치가 된다. 그래서 mad>0 일 때만 게이트를 건다.
  // 대가: 아래 50 은 표시되지 않는다. 표본이 한 점에 몰린 버킷에서는 "이상치" 정의 자체가
  // 성립하지 않는다고 보는 편이, 8건 중 3건을 이상치로 찍는 것보다 낫다고 판단했다.
  const quotes = [0, 0, 0, 0, 0, 1, 1, 1, 50].map((v) => q({ issuer_raw: '중금채', offset_bp: v }));
  const { rows, leaves } = buildBuckets(quotes, { todayStr: TODAY });
  assert.equal(leaves.get('특은').mad, 0);
  assert.equal(rows.filter((r) => r.outlier).length, 0);
});

// ── 픽스처 실측 회귀 ────────────────────────────────────────────────────

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'kbond-sample.masked.txt');
const parsed = parseRv2(readFileSync(FIXTURE, 'utf8'));
const rankable = parsed.quotes.filter((x) => x.offset_bp != null && !x.is_cp_cd);
const fx = buildBuckets(rankable, { todayStr: TODAY });

test('픽스처 — rankable 1,020건의 리프 분포를 고정한다', () => {
  assert.equal(rankable.length, 1020);
  const dist = {};
  for (const [k, b] of fx.leaves) dist[k] = b.n;
  assert.deepEqual(dist, {
    특은: 334, '여전-캐피탈': 158, 회사채: 141,
    '중앙공사(SOC·에너지계)': 92, '지방공기업': 48, '중앙공사(보증·기금계)': 28,
    '시은-시중계': 71, '여전-카드': 65, 증권채: 24, 은행지주: 18, '국고·통안': 17,
    지방채: 9, 지방은행: 1,
  });
  // 랭킹 제외군은 리프에 아예 없다. 입력 1,020 중 유동화 14건이 빠져 집계 1,006.
  assert.ok(!fx.leaves.has('유동화·ABS'));
  assert.equal(fx.session.n, 1006);
  // RWA 3분할이 실제로 갈린다 — 통합 하나로 뒀을 때는 안 보이던 차이다.
  assert.equal(fx.leaves.get('중앙공사(SOC·에너지계)').median, -1.25);
  assert.equal(fx.leaves.get('중앙공사(보증·기금계)').median, -1.4);
  assert.equal(fx.leaves.get('지방공기업').median, 0);
});

test('픽스처 — RWA 3분할 후에도 n<8 리프는 1개(관측 1건)뿐 → n=8 유지 근거', () => {
  assert.equal(fx.stats.leaves, 13);
  assert.equal(fx.stats.leavesUnderGuard, 1, '지방은행 n=1');
  // 3분할된 공사·공단 3칸이 전부 가드를 넘는다(28·52·88).
  for (const k of ['중앙공사(보증·기금계)', '중앙공사(SOC·에너지계)', '지방공기업']) {
    assert.ok(fx.leaves.get(k).n >= RV2_MIN_BUCKET_SAMPLE, k);
  }
  // v1.2: 1차 단위는 칸(섹터 리프 × 통계 만기). 칸 미달분만 섹터로 롤업한다.
  assert.equal(fx.stats.cells, 31);
  assert.equal(fx.stats.cellsUnderGuard, 9);
  assert.equal(fx.stats.observationsUnderGuard, 30, '칸 미달 관측 = 전체의 3.0%');
  assert.equal(fx.stats.rollupCell, 965);
  assert.equal(fx.stats.rollupLeaf, 40, '칸 미달 30 + 만기 미상 10');
  assert.equal(fx.stats.rollupSector, 0);
  assert.equal(fx.stats.rollupSession, 1);
});

test('픽스처 — 특은 3칸 중앙값이 실측표와 일치한다 (v1.2 승격 근거)', () => {
  // 승격 전에는 이 셋을 한 중앙값(−0.20)으로 뭉갰다. 칸 간 폭 5.0bp 는 섹터 MAD(1.60)보다 크다.
  assert.equal(fx.cells.get('특은 · ~1y').median, 0);
  assert.equal(fx.cells.get('특은 · 1-2').median, -3);
  assert.equal(fx.cells.get('특은 · 2y+').median, 2);
  assert.deepEqual(
    ['~1y', '1-2', '2y+'].map((k) => fx.cells.get(`특은 · ${k}`).n), [214, 99, 11]);
  assert.equal(fx.leaves.get('특은').median, -0.2, '섹터 중앙값은 그대로 남는다(롤업 대상)');
});

test('픽스처 — rating_basis 분해. 역매핑이 등급미상을 75.4% → 26.5% 로 줄인다', () => {
  assert.deepEqual(fx.stats.ratingBasis, {
    explicit: 254, issuer_mapped: 479, unknown: 270, not_applicable: 17,
  });
  const pct = (n) => Math.round((n / rankable.length) * 1000) / 10;
  assert.equal(pct(254), 24.9);
  assert.equal(pct(479), 47.0);
  assert.equal(pct(270), 26.5, 'Phase 0 실측 75.4% 대비');
  // 국고·통안 17건은 미상이 아니라 비적용이다. 섞으면 등급미상 비율이 부풀려진다.
  assert.equal(pct(17), 1.7);
});

test('등급 — 국고·통안은 등급 축 비적용. 미상과 분리한다', () => {
  const r = resolveRating(q({ issuer_raw: '국고이자' }));
  assert.deepEqual(r, { rating: null, rating_basis: 'not_applicable' });
  assert.equal(resolveRating(q({ issuer_raw: '국주 23-05' })).rating_basis, 'not_applicable');
  // 픽스처의 국고·통안 리프 17건이 전부 비적용으로 떨어진다.
  const gg = fx.rows.filter((x) => x.sector === '국고·통안');
  assert.equal(gg.length, 17);
  assert.ok(gg.every((x) => x.rating_basis === 'not_applicable'));
});

test('픽스처 — sector_basis 분해. default(회사채 추정) 비율을 드러낸다', () => {
  assert.deepEqual(fx.stats.sectorBasis, { matched: 879, default: 141 });
});

test('픽스처 — 세션 중앙값과 만기 격자 분포', () => {
  assert.equal(fx.session.n, 1006, '입력 1,020 − 유동화·ABS 14');
  assert.equal(fx.session.median, -0.2);
  const tenor = fx.rows.reduce((a, r) => { a[r.tenor || '(미상)'] = (a[r.tenor || '(미상)'] || 0) + 1; return a; }, {});
  assert.deepEqual(tenor, { '~1y': 541, '1-2': 303, '2-3': 92, '3-5': 50, '5-10': 23, '(미상)': 11 });
  // 만기 미상 11건 = B-9 잔여(과거 만기 오탐). 격자에 올리지 않는다.
});
