// rv2-buckets 단위 테스트 — node --test (인자 없이 자동탐색).
// 초점: 분류 축(섹터·등급·만기)의 판정 규칙과 표본 가드. 오프셋 값 자체는 rv2-parser 소관.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RV2_MIN_BUCKET_SAMPLE, RV2_MAD_K, RV2_TENOR_GRID, RWA0_ISSUERS, RWA20_ISSUERS,
  ISSUER_RATING_MAP, RANKING_EXCLUDED_SECTORS,
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

test('RWA 리스트는 명령서 §2.2 확정 전까지 비어 있다 (의도된 상태)', () => {
  // 위험가중치를 잘못 붙이면 그 자체가 오염이다. 리스트가 오면 이 두 상수만 채운다.
  // 이 테스트가 깨지는 시점 = §2.2 를 반영한 시점. 그때 기대값을 갱신하면 된다.
  assert.equal(RWA0_ISSUERS.size, 0, '§2.2 반영 시 이 값을 갱신할 것');
  assert.equal(RWA20_ISSUERS.size, 0, '§2.2 반영 시 이 값을 갱신할 것');
  // 비어 있으면 모든 공사·공단이 '기타' 로 떨어진다 — 누락이 아니라 미확정의 정직한 표현.
  assert.equal(classifySector(q({ issuer_raw: '한국전력1477' })).leaf, '공사·공단/기타');
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
  for (const name of ['중금채', '산금채', '기업은행', '수출입채', '농금은행', '중벤공787']) {
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

test('섹터 — 공사·공단은 RWA 하위축을 갖는다', () => {
  const r = classifySector(q({ issuer_raw: '국가철도공단410' }));
  assert.equal(r.sector, '공사·공단');
  assert.equal(r.rwa, '기타', '§2.2 미반영 상태');
  assert.equal(r.leaf, '공사·공단/기타');
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
  // 공사·공단/기타 10건(중앙값 5) + 지방채 2건(중앙값 -3)
  const { rows, leaves } = buildBuckets([...mk('한국전력1477', 10, 5), ...mk('대구광역시채권1', 2, -3)], { todayStr: TODAY });
  assert.equal(leaves.get('공사·공단/기타').n, 10);
  assert.equal(leaves.get('지방채').n, 2);

  const gongsa = rows.find((r) => r.sector === '공사·공단');
  assert.equal(gongsa.medianSource, '리프', 'n>=8 이면 자기 리프를 쓴다');
  assert.equal(gongsa.medianUsed, 5);

  const jibang = rows.find((r) => r.sector === '지방채');
  // 지방채는 리프도 섹터도 n=2 라 세션으로 내려간다.
  assert.equal(jibang.medianSource, '세션롤업');
  assert.equal(jibang.medianUsed, 5, '세션 12건의 중앙값');
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
    특은: 350, 회사채: 173, '여전-캐피탈': 158, '공사·공단/기타': 152,
    '시은-시중계': 71, '여전-카드': 65, 증권채: 24, '국고·통안': 17,
    지방채: 9, 지방은행: 1,
  });
});

test('픽스처 — n<8 리프는 1개(관측 1건)뿐이다 → n=8 유지 근거', () => {
  assert.equal(fx.stats.leaves, 10);
  assert.equal(fx.stats.leavesUnderGuard, 1, '지방은행 n=1');
  assert.equal(fx.stats.observationsUnderGuard, 1);
  // 롤업이 예외로 남는다 — Phase 0 §6 결정 1이 우려한 "롤업이 기본" 상황이 아니다.
  assert.equal(fx.stats.rollupLeaf, 1019);
  assert.equal(fx.stats.rollupSector, 0);
  assert.equal(fx.stats.rollupSession, 1);
});

test('픽스처 — rating_basis 분해. 역매핑이 등급미상을 75.4% → 28.1% 로 줄인다', () => {
  assert.deepEqual(fx.stats.ratingBasis, { explicit: 254, issuer_mapped: 479, unknown: 287 });
  const pct = (n) => Math.round((n / rankable.length) * 1000) / 10;
  assert.equal(pct(254), 24.9);
  assert.equal(pct(479), 47.0);
  assert.equal(pct(287), 28.1, 'Phase 0 실측 75.4% 대비');
});

test('픽스처 — sector_basis 분해. default(회사채 추정) 비율을 드러낸다', () => {
  assert.deepEqual(fx.stats.sectorBasis, { matched: 847, default: 173 });
});

test('픽스처 — 세션 중앙값과 만기 격자 분포', () => {
  assert.equal(fx.session.n, 1020);
  assert.equal(fx.session.median, -0.2);
  const tenor = fx.rows.reduce((a, r) => { a[r.tenor || '(미상)'] = (a[r.tenor || '(미상)'] || 0) + 1; return a; }, {});
  assert.deepEqual(tenor, { '~1y': 541, '1-2': 303, '2-3': 92, '3-5': 50, '5-10': 23, '(미상)': 11 });
  // 만기 미상 11건 = B-9 잔여(과거 만기 오탐). 격자에 올리지 않는다.
});
