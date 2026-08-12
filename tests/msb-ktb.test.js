// MS-1 국고-통안 상대가치 — 데이터 계층 테스트 (node --test 자동탐색, CJS)
//
// [라이선스] 실데이터(유료 민평)를 동결하지 않는다. 합성 곡선·합성 워크북만 커밋한다.
// 실데이터 앵커 블록은 data/raw/국고통안.xlsx(.gitignore 대상)가 있을 때만 돈다.
//
// 합성 곡선 규약: 모든 계보가 같은 기울기(0.2%/년)의 직선이라 계보 간 스프레드는
// 잔존과 무관하게 절편 차이로 고정된다. 덕분에 잔존을 일수로 환산할 때 생기는
// 반올림 오차와 무관하게 sp/liq/adj 기대값을 손으로 못 박을 수 있다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const B = require('../tools/build-msb-ktb.js');

const DATE = '2026-08-12';
const SLOPE = 0.2;
const shift = (iso, days) => new Date(Date.parse(iso + 'T00:00:00Z') + days * 86400000)
  .toISOString().slice(0, 10);

// 절편(%) — liq.msb = -16.5bp, liq.ktb = -3.2bp 가 되도록 잡았다(실데이터 앵커와 같은 부호).
const BASE = { M2: 3.000, M3: 2.835, K2: 2.960, K3: 2.928 };
// 잔존 0.55 / 1.51 / 3.01년 → 노드 [1.0 … 2.5] 를 전부 감싼다.
const OFFSETS = [200, 550, 1100];

function mkBond(code, lineage, offsetDays, date = DATE) {
  const maturity = shift(date, offsetDays);
  const ttm = B.yearsBetween(date, maturity);
  return { code, lineage, maturity, obs: new Map([[date, BASE[lineage] + SLOPE * ttm]]) };
}

const fixtureBonds = (offsets = { M2: OFFSETS, M3: OFFSETS, K2: OFFSETS, K3: OFFSETS }) =>
  B.LINEAGES.flatMap(lin => offsets[lin].map((d, i) => mkBond(`${lin}_${i}`, lin, d)));

// ── 1. local linear 보간 ────────────────────────────────────────────────────
test('MS-1: local linear 은 인접 2점만 쓴다 (전역 적합 아님)', () => {
  // 볼록 3점. 전역 2차/스플라인이면 1.25·1.75 값이 아래 기대치와 어긋난다.
  const pts = [{ ttm: 1.0, y: 3.0 }, { ttm: 1.5, y: 3.5 }, { ttm: 2.0, y: 3.6 }];
  assert.equal(B.localLinear(pts, 1.25).value, 3.25); // (3.0+3.5)/2
  assert.equal(B.localLinear(pts, 1.75).value, 3.55); // (3.5+3.6)/2
  assert.equal(B.localLinear(pts, 1.5).value, 3.5);
  assert.equal(B.localLinear(pts, 1.0).value, 3.0);
  assert.equal(B.localLinear(pts, 2.0).value, 3.6);
  assert.ok(Math.abs(B.localLinear(pts, 1.1).value - 3.1) < 1e-12);
});

test('MS-1: localLinear 은 상·하 경계 밖에서 외삽하지 않는다', () => {
  const pts = [{ ttm: 1.0, y: 3.0 }, { ttm: 2.0, y: 3.4 }];
  assert.deepEqual(B.localLinear(pts, 0.75), { value: null, extrap: true });
  assert.deepEqual(B.localLinear(pts, 2.25), { value: null, extrap: true });
  assert.equal(B.localLinear(pts, 1.0).extrap, false);
  assert.equal(B.localLinear(pts, 2.0).extrap, false);
  assert.deepEqual(B.localLinear([], 1.0), { value: null, extrap: true });
  assert.equal(B.localLinear([{ ttm: 1.5, y: 3.1 }], 1.5).value, 3.1);
  assert.equal(B.localLinear([{ ttm: 1.5, y: 3.1 }], 1.25).value, null);
});

test('MS-1: 동일 잔존 종목은 평균으로 합쳐 단조 커브를 만든다', () => {
  assert.deepEqual(B.buildCurve([
    { code: 'a', ttm: 1.0, y: 3.0 },
    { code: 'b', ttm: 1.0, y: 3.2 },
    { code: 'c', ttm: 0.5, y: 2.8 },
  ]), [{ ttm: 0.5, y: 2.8 }, { ttm: 1.0, y: 3.1 }]);
});

// ── 2. 계보 판정 ────────────────────────────────────────────────────────────
test('MS-1: 종목명에서 종류·만기·접미사를 뽑는다', () => {
  assert.deepEqual(B.parseBondName('통안02010-2708-02'), { kind: 'msb', maturity: '2027-08-05', suffix: '02' });
  assert.deepEqual(B.parseBondName('통안02010-2802-03'), { kind: 'msb', maturity: '2028-02-05', suffix: '03' });
  assert.deepEqual(B.parseBondName('국고03500-2906(26-5)'), { kind: 'ktb', maturity: '2029-06-10', suffix: null });
  assert.equal(B.parseBondName('회사채AA-'), null);
  assert.equal(B.parseBondName('국민주택1종'), null);
  assert.equal(B.parseBondName(''), null);
});

test('MS-1: 통안 계보는 접미 2자리, 02/03 이외는 계보 없음', () => {
  const mk = suffix => ({ kind: 'msb', suffix, maturity: '2028-02-05', firstObs: '2026-01-02' });
  assert.equal(B.assignLineage(mk('02')), 'M2');
  assert.equal(B.assignLineage(mk('03')), 'M3');
  assert.equal(B.assignLineage(mk('01')), null);
  assert.equal(B.assignLineage(mk('04')), null);
});

test('MS-1: 국고 계보는 원발행만기 2.5년으로 가른다 (2.1y→K2, 3.2y→K3)', () => {
  const mat = '2029-06-10';
  assert.equal(B.ktbLineage(mat, shift(mat, -Math.round(2.1 * 365.25))), 'K2');
  assert.equal(B.ktbLineage(mat, shift(mat, -Math.round(3.2 * 365.25))), 'K3');
  // 경계: 2.5년(913.125일) 바로 아래는 K2, 위는 K3
  assert.equal(B.ktbLineage(mat, shift(mat, -913)), 'K2'); // 2.4997y
  assert.equal(B.ktbLineage(mat, shift(mat, -914)), 'K3'); // 2.5024y
  // assignLineage 경유도 동일
  assert.equal(B.assignLineage({ kind: 'ktb', maturity: mat, firstObs: shift(mat, -Math.round(3.2 * 365.25)) }), 'K3');
  assert.equal(B.assignLineage({ kind: 'ktb', maturity: mat, firstObs: null }), null);
});

// ── 3. 휴일 캐리 제거 ───────────────────────────────────────────────────────
test('MS-1: 동일값이 3일 연속이면 1일만 남는다', () => {
  const bond = {
    code: 'x',
    obs: new Map([['2026-08-10', 3.00], ['2026-08-11', 3.00], ['2026-08-12', 3.00], ['2026-08-13', 3.05]]),
  };
  const dates = [...bond.obs.keys()];
  assert.deepEqual(B.removeHolidayCarry([bond], dates), ['2026-08-10', '2026-08-13']);
});

test('MS-1: 캐리 비교 대상은 직전 원본일이 아니라 직전 유효일이다', () => {
  // 2일차만 캐리, 3일차는 1일차와 값이 같다. 직전 원본일(2일차)과만 비교하면
  // 3일차도 '변화 0' 이라 잘못 버려진다 — 직전 유효일(1일차) 기준이면 남는다.
  const bond = { code: 'x', obs: new Map([['2026-08-10', 3.00], ['2026-08-11', 3.00], ['2026-08-12', 3.00]]) };
  assert.deepEqual(B.removeHolidayCarry([bond], [...bond.obs.keys()]), ['2026-08-10']);

  const moved = { code: 'x', obs: new Map([['2026-08-10', 3.00], ['2026-08-11', 3.02], ['2026-08-12', 3.00]]) };
  assert.deepEqual(B.removeHolidayCarry([moved], [...moved.obs.keys()]), ['2026-08-10', '2026-08-11', '2026-08-12']);
});

test('MS-1: 한 종목만 움직여도 그날은 남는다 (절대합 기준)', () => {
  const a = { code: 'a', obs: new Map([['2026-08-10', 3.00], ['2026-08-11', 3.00]]) };
  const b = { code: 'b', obs: new Map([['2026-08-10', 2.90], ['2026-08-11', 2.901]]) };
  assert.deepEqual(B.removeHolidayCarry([a, b], ['2026-08-10', '2026-08-11']), ['2026-08-10', '2026-08-11']);
});

test('MS-1: 종목 구성이 바뀐 날(발행·만기)은 캐리로 보지 않는다', () => {
  const a = { code: 'a', obs: new Map([['2026-08-10', 3.00], ['2026-08-11', 3.00]]) };
  const fresh = { code: 'b', obs: new Map([['2026-08-11', 2.90]]) }; // 신규 발행
  assert.deepEqual(B.removeHolidayCarry([a, fresh], ['2026-08-10', '2026-08-11']), ['2026-08-10', '2026-08-11']);
});

// ── 4. 계보별 곡선·스프레드 ─────────────────────────────────────────────────
test('MS-1: 4계보 합성 곡선에서 sp·liq·adj 가 전 노드 정확히 재현된다', () => {
  const rec = B.computeDay(fixtureBonds(), DATE);
  const rep = v => B.NODES.map(() => v);

  assert.deepEqual(rec.sp.M2_K2, rep(4));      // (3.000-2.960)*100
  assert.deepEqual(rec.sp.M2_K3, rep(7.2));    // (3.000-2.928)*100
  assert.deepEqual(rec.sp.M3_K2, rep(-12.5));  // (2.835-2.960)*100
  assert.deepEqual(rec.sp.M3_K3, rep(-9.3));   // (2.835-2.928)*100

  assert.deepEqual(rec.liq.msb, rep(-16.5));   // M3 - M2
  assert.deepEqual(rec.liq.ktb, rep(-3.2));    // K3 - K2
  assert.deepEqual(rec.liq.delta, rep(-13.3)); // liq.msb - liq.ktb

  // adj = sp - liq.delta
  assert.deepEqual(rec.adj.M2_K2, rep(17.3));
  assert.deepEqual(rec.adj.M2_K3, rep(20.5));
  assert.deepEqual(rec.adj.M3_K2, rep(0.8));
  assert.deepEqual(rec.adj.M3_K3, rep(4));

  assert.deepEqual(rec.cover, { M2: 3, M3: 3, K2: 3, K3: 3 });
  assert.deepEqual(rec.flags, []);
});

test('MS-1: liq 부호 — 계보가 뒤집히면 부호도 뒤집힌다', () => {
  // M2/M3 절편을 맞바꾼다. liq.msb 부호만 반전되고 liq.ktb 는 그대로.
  const bonds = fixtureBonds().map(b => (
    b.lineage === 'M2' || b.lineage === 'M3'
      ? { ...b, lineage: b.lineage === 'M2' ? 'M3' : 'M2' }
      : b));
  const rec = B.computeDay(bonds, DATE);
  assert.deepEqual(rec.liq.msb, B.NODES.map(() => 16.5));
  assert.deepEqual(rec.liq.ktb, B.NODES.map(() => -3.2));
  assert.deepEqual(rec.liq.delta, B.NODES.map(() => 19.7));
});

test('MS-1: 계보는 절대 합쳐지지 않는다 (한 계보를 빼면 그 계보만 null)', () => {
  const rec = B.computeDay(fixtureBonds().filter(b => b.lineage !== 'K3'), DATE);
  assert.deepEqual(rec.sp.M2_K2, B.NODES.map(() => 4), 'K3 부재가 M2_K2 를 오염시키면 안 된다');
  assert.deepEqual(rec.sp.M2_K3, B.NODES.map(() => null));
  assert.deepEqual(rec.sp.M3_K3, B.NODES.map(() => null));
  assert.deepEqual(rec.liq.ktb, B.NODES.map(() => null));
  assert.deepEqual(rec.liq.delta, B.NODES.map(() => null));
  // liq.delta 가 null 이면 sp 가 살아 있어도 adj 는 전부 null
  for (const p of B.PAIRS) assert.deepEqual(rec.adj[p], B.NODES.map(() => null), p);
  assert.equal(rec.cover.K3, 0);
});

// ── 5. 외삽 금지 ────────────────────────────────────────────────────────────
test('MS-1: 계보별 관측 범위 밖 노드는 null + extrap 플래그', () => {
  // K3 최장 관측을 잔존 2.14년(780일)으로 잘라 노드 2.25·2.50 만 범위 밖으로 만든다.
  const rec = B.computeDay(fixtureBonds({ M2: OFFSETS, M3: OFFSETS, K2: OFFSETS, K3: [200, 550, 780] }), DATE);
  assert.deepEqual(rec.flags, ['extrap_K3_2.25', 'extrap_K3_2.50']);

  const idx = B.NODES.map((n, i) => (n >= 2.25 ? i : -1)).filter(i => i >= 0);
  for (const i of idx) {
    assert.equal(rec.sp.M2_K3[i], null);
    assert.equal(rec.sp.M3_K3[i], null);
    assert.equal(rec.liq.ktb[i], null);
    assert.equal(rec.liq.delta[i], null);
    for (const p of B.PAIRS) assert.equal(rec.adj[p][i], null, `${p}@${B.NODES[i]}`);
    assert.notEqual(rec.sp.M2_K2[i], null, 'K3 결측이 M2_K2 를 죽이면 안 된다');
  }
  // 범위 안 노드는 정상
  assert.equal(rec.sp.M2_K3[0], 7.2);
  assert.equal(rec.adj.M2_K2[0], 17.3);
});

test('MS-1: 종목이 하나도 없으면 전 노드 null 이고 4계보 모두 extrap 플래그', () => {
  const rec = B.computeDay([], DATE);
  for (const p of B.PAIRS) assert.deepEqual(rec.sp[p], B.NODES.map(() => null));
  for (const k of B.LIQ_KEYS) assert.deepEqual(rec.liq[k], B.NODES.map(() => null));
  assert.deepEqual(rec.cover, { M2: 0, M3: 0, K2: 0, K3: 0 });
  assert.equal(rec.flags.length, B.NODES.length * B.LINEAGES.length);
});

test('MS-1: 잔존 0.05년 이하 종목은 제외된다', () => {
  const bonds = fixtureBonds().concat([mkBond('stub', 'M2', 10)]); // 잔존 0.027년
  assert.equal(B.computeDay(bonds, DATE).cover.M2, 3);
  assert.equal(B.computeDay(bonds.concat([mkBond('keep', 'M2', 30)]), DATE).cover.M2, 4); // 0.082년
});

test('MS-1: 계보 미부여 종목은 집계에 들어가지 않는다', () => {
  const bonds = fixtureBonds().concat([{ ...mkBond('x', 'M2', 400), lineage: null }]);
  assert.deepEqual(B.computeDay(bonds, DATE).cover, { M2: 3, M3: 3, K2: 3, K3: 3 });
});

// ── 6. 관측 소실 감시 (이상치 필터 없음) ────────────────────────────────────
test('MS-1: 이상치 제외는 하지 않는다 — 계보 내 편차는 곡선 기울기 그 자체다', () => {
  // 잔존이 거의 같은 동일계보 두 종목이 25bp 벌어져 있어도 어느 쪽도 버리지 않는다.
  const bonds = [
    { code: 'M2a', lineage: 'M2', maturity: shift(DATE, 550), obs: new Map([[DATE, 3.30]]) },
    { code: 'M2b', lineage: 'M2', maturity: shift(DATE, 551), obs: new Map([[DATE, 3.05]]) },
  ];
  const rec = B.computeDay(bonds, DATE);
  assert.equal(rec.cover.M2, 2);
  assert.deepEqual(rec.flags.filter(f => f.startsWith('outlier_')), []);
  assert.equal(B.flagOutliers, undefined, '이상치 필터가 되살아났다');
});

test('MS-1: 계보 종목수가 전일 대비 2 이상 줄면 cover_drop 플래그', () => {
  assert.deepEqual(B.coverDropFlags({ M2: 6, M3: 6, K2: 6, K3: 6 }, null), [], '첫날은 비교 대상 없음');
  assert.deepEqual(B.coverDropFlags({ M2: 4, M3: 6, K2: 6, K3: 6 }, { M2: 6, M3: 6, K2: 6, K3: 6 }), ['cover_drop_M2']);
  assert.deepEqual(B.coverDropFlags({ M2: 5, M3: 6, K2: 6, K3: 6 }, { M2: 6, M3: 6, K2: 6, K3: 6 }), [], '1 감소는 통과');
  assert.deepEqual(
    B.coverDropFlags({ M2: 4, M3: 3, K2: 6, K3: 6 }, { M2: 6, M3: 6, K2: 6, K3: 6 }),
    ['cover_drop_M2', 'cover_drop_M3'],
  );
  assert.deepEqual(B.coverDropFlags({ M2: 8, M3: 6, K2: 6, K3: 6 }, { M2: 6, M3: 6, K2: 6, K3: 6 }), [], '증가는 무시');
});

test('MS-1: cover_drop 은 레코드 flags 에 실려 나온다', () => {
  const prev = { M2: 3, M3: 3, K2: 3, K3: 3 };
  const bonds = fixtureBonds().filter(b => !(b.lineage === 'K2' && b.code !== 'K2_0'));
  const rec = B.computeDay(bonds, DATE, prev);
  assert.equal(rec.cover.K2, 1);
  assert.ok(rec.flags.includes('cover_drop_K2'), JSON.stringify(rec.flags));
  assert.equal(rec.flags.includes('cover_drop_M2'), false);
});

// ── 7. 워크북 파싱 (합성 wide 레이아웃) ─────────────────────────────────────
// row1=조회 메타, row2=종목명, row3=라벨, row4~ 데이터. 종목당 2열.
const WB_NAMES = [
  '통안02010-2708-02',    // M2
  '통안02010-2802-03',    // M3
  '국고03500-2906(26-5)', // 만기 2029-06-10, 최초관측 2026-08-10 → 원발행 2.83년 → K3
  '국고02250-2806(25-4)', // 만기 2028-06-10, 최초관측 2026-08-10 → 원발행 1.83년 → K2
  '회사채AA-',            // 종목명 파싱 실패 → 제외
];
function buildAoa(rows) {
  const aoa = [['시작', 1, '종료', 2, 'Data 개수', rows.length]];
  aoa[1] = [];
  aoa[2] = [];
  WB_NAMES.forEach((n, i) => {
    aoa[1][i * 2] = n;
    aoa[2][i * 2] = '일자';
    aoa[2][i * 2 + 1] = '민평3사 수익률(산출일)';
  });
  rows.forEach(([date, ...ys], r) => {
    const row = [];
    ys.forEach((y, i) => { row[i * 2] = date; row[i * 2 + 1] = y; });
    aoa[3 + r] = row;
  });
  return aoa;
}

const WB_ROWS = [
  ['2026-08-10', 3.10, 3.05, 3.00, 2.98, 4.50],
  ['2026-08-11', 3.10, 3.05, 3.00, 2.98, 4.50], // 전 종목 무변화 → 캐리
  ['2026-08-12', 3.14, 3.08, 3.02, 2.99, 4.52],
];

test('MS-1: wide 레이아웃 라벨 행 탐색·종목 파싱', () => {
  const aoa = buildAoa(WB_ROWS);
  assert.equal(B.findHeaderRow(aoa), 2);

  const { bonds, dates, skipped } = B.parseWorkbook(aoa);
  assert.deepEqual(bonds.map(b => b.code), WB_NAMES.slice(0, 4), '회사채는 종목명 파싱 실패로 제외');
  assert.equal(skipped.unparsedName, 1);
  assert.deepEqual(dates, ['2026-08-10', '2026-08-11', '2026-08-12']);
  assert.equal(bonds[0].maturity, '2027-08-05');
  assert.equal(bonds[2].maturity, '2029-06-10');
  assert.equal(bonds[3].maturity, '2028-06-10');
  assert.equal(bonds[0].firstObs, '2026-08-10');
});

test('MS-1: 일자/수익률 열 순서가 뒤집혀도 라벨로 판별한다', () => {
  const aoa = buildAoa(WB_ROWS);
  // 첫 종목만 열 순서를 뒤집는다
  aoa[2][0] = '민평3사 수익률(산출일)';
  aoa[2][1] = '일자';
  for (let r = 3; r < aoa.length; r++) {
    const [d, y] = [aoa[r][0], aoa[r][1]];
    aoa[r][0] = y; aoa[r][1] = d;
  }
  const { bonds } = B.parseWorkbook(aoa);
  assert.equal(bonds[0].code, WB_NAMES[0]);
  assert.equal(bonds[0].obs.get('2026-08-12'), 3.14);
});

test('MS-1: 라벨 행이 없으면 조용히 넘어가지 않고 실패한다', () => {
  assert.throws(() => B.parseWorkbook([['a', 'b'], [1, 2]]), /라벨 행/);
});

test('MS-1: Excel 시리얼 일자도 ISO 로 정규화된다', () => {
  // 앵커: 46154 = 26-5 지표물 전환일(data/onoff-ktb3y.js), 42373 = data/ktb-curve.js 첫 행
  assert.equal(B.toISO(46154), '2026-05-12');
  assert.equal(B.toISO(42373), '2016-01-04');
  assert.equal(B.toISO('2026-08-12'), '2026-08-12');
  assert.equal(B.toISO('2026/8/2'), '2026-08-02');
  assert.equal(B.toISO('20260812'), '2026-08-12');
  assert.equal(B.toISO(''), null);
});

test('MS-1: buildSeries 는 전처리 순서(캐리→ttm→이상치)를 거쳐 유효일만 낸다', () => {
  const { series, stats } = B.buildSeries(buildAoa(WB_ROWS));
  assert.deepEqual(Object.keys(series), ['2026-08-10', '2026-08-12'], '캐리일 08-11 제거');
  assert.equal(stats.rawDays, 3);
  assert.equal(stats.validDays, 2);
  assert.equal(stats.bonds, 4);
  // 통안 02/03 = M2/M3, 국고는 원발행만기 2.83년 → K3 / 1.83년 → K2
  assert.deepEqual(stats.lineage, { M2: 1, M3: 1, K2: 1, K3: 1 });
  // 계보당 종목 1개뿐이라 곡선을 만들 수 없다 → 전 노드 null
  assert.deepEqual(series['2026-08-12'].sp.M2_K3, B.NODES.map(() => null));
});

test('MS-1: cover_drop 비교 기준은 직전 유효일이다 (캐리일은 건너뛴다)', () => {
  // 08-11 은 캐리로 제거되고, 08-12 의 비교 대상은 08-10 이 된다.
  const { series } = B.buildSeries(buildAoa(WB_ROWS));
  assert.deepEqual(Object.keys(series), ['2026-08-10', '2026-08-12']);
  assert.deepEqual(series['2026-08-10'].flags.filter(f => f.startsWith('cover_drop_')), [], '첫날은 비교 없음');
  assert.deepEqual(series['2026-08-12'].flags.filter(f => f.startsWith('cover_drop_')), [], '구성 불변');
});

test('MS-1: 절단 경고는 K2 로 떨어진 종목에만 낸다 (오분류가 가능한 방향)', () => {
  const { stats } = B.buildSeries(buildAoa(WB_ROWS));
  const trunc = stats.warnings.filter(w => /원발행만기 절단/.test(w));
  // 절단은 만기를 짧게만 만든다 → K3 로 잡혔으면 실제는 더 길어 판정이 뒤집힐 수 없다.
  assert.equal(trunc.length, 1, JSON.stringify(trunc));
  assert.match(trunc[0], /25-4/);
  assert.equal(trunc.some(w => /26-5/.test(w)), false, 'K3 는 절단으로 뒤집히지 않으므로 경고 대상이 아니다');
});

test('MS-1: 일수 게이트는 알려진 조회범위에서만 하드 게이트로 작동한다', () => {
  assert.equal(B.checkDayCount({ rawDays: 3810, validDays: 2556 }).ok, true);
  assert.equal(B.checkDayCount({ rawDays: 3810, validDays: 2552 }).ok, true); // ±5 이내
  assert.equal(B.checkDayCount({ rawDays: 3810, validDays: 2400 }).ok, false);
  assert.match(B.checkDayCount({ rawDays: 3810, validDays: 2400 }).message, /기대치를 벗어남/);
  // 조회범위가 다르면 경고만
  const other = B.checkDayCount({ rawDays: 1000, validDays: 700 });
  assert.equal(other.ok, true);
  assert.match(other.message, /게이트 skip/);
});

// ── 8. 스키마 v2 / 직렬화 ───────────────────────────────────────────────────
test('MS-1: series 레코드는 스키마 v2 키만 갖는다 (원본 금리 미저장)', () => {
  const rec = B.computeDay(fixtureBonds(), DATE);
  assert.deepEqual(Object.keys(rec).sort(), ['adj', 'cover', 'flags', 'liq', 'sp']);
  assert.deepEqual(Object.keys(rec.sp).sort(), [...B.PAIRS].sort());
  assert.deepEqual(Object.keys(rec.adj).sort(), [...B.PAIRS].sort());
  assert.deepEqual(Object.keys(rec.liq).sort(), [...B.LIQ_KEYS].sort());
  assert.deepEqual(Object.keys(rec.cover).sort(), [...B.LINEAGES].sort());
  for (const p of B.PAIRS) assert.equal(rec.sp[p].length, B.NODES.length);
  for (const k of B.LIQ_KEYS) assert.equal(rec.liq[k].length, B.NODES.length);

  // 원본 수익률(3.x %) 이 어떤 필드에도 남지 않는다 — 값은 전부 bp 스프레드
  const nums = [...B.PAIRS.flatMap(p => rec.sp[p].concat(rec.adj[p])),
    ...B.LIQ_KEYS.flatMap(k => rec.liq[k])].filter(v => v !== null);
  assert.equal(nums.some(v => v > 2.5 && v < 4.5 && !Number.isInteger(v)), false);
});

test('MS-1: sp·liq·adj 는 0.1bp 로 반올림돼 저장된다', () => {
  const isTenth = v => v === null || Math.abs(v * 10 - Math.round(v * 10)) < 1e-9;
  // 1dp 경계에 걸치도록 절편을 0.001%(0.1bp) 단위 아래로 흔든 곡선
  const bonds = B.LINEAGES.flatMap(lin => OFFSETS.map((d, i) => {
    const b = mkBond(`${lin}_${i}`, lin, d);
    return { ...b, obs: new Map([[DATE, b.obs.get(DATE) + (lin === 'K3' ? 0.000123 : 0)]]) };
  }));
  const rec = B.computeDay(bonds, DATE);
  for (const p of B.PAIRS) {
    for (const v of rec.sp[p]) assert.ok(isTenth(v), `sp.${p} = ${v}`);
    for (const v of rec.adj[p]) assert.ok(isTenth(v), `adj.${p} = ${v}`);
  }
  for (const k of B.LIQ_KEYS) for (const v of rec.liq[k]) assert.ok(isTenth(v), `liq.${k} = ${v}`);

  // 저장값끼리 adj = sp - liq.delta 가 정확히 성립해야 한다(읽는 쪽이 재계산해도 같게)
  for (const p of B.PAIRS) {
    B.NODES.forEach((_, i) => {
      if (rec.adj[p][i] === null) return;
      assert.equal(rec.adj[p][i], Math.round((rec.sp[p][i] - rec.liq.delta[i]) * 10) / 10, `${p}@${B.NODES[i]}`);
    });
  }
});

test('MS-1: 직렬화 결과는 유효 JSON 이고 수치 배열이 한 줄로 눕는다', () => {
  const doc = B.upsertDate(B.emptyDoc(), DATE, B.computeDay(fixtureBonds(), DATE));
  const text = B.serialize(doc);
  assert.deepEqual(JSON.parse(text), doc, '커스텀 직렬화가 라운드트립을 깬다');
  assert.equal(JSON.parse(text).schema_version, 2);
  assert.deepEqual(JSON.parse(text).pairs, B.PAIRS);
  assert.match(text, /"sp": \{"M2_K2": \[4,4,4,4,4,4,4\]/);
  assert.ok(text.endsWith('\n'));
  // 하루치가 10줄 미만 — 값마다 줄바꿈하면 2556일에서 파일이 터진다
  assert.ok(text.split('\n').length < 20, `직렬화가 너무 장황하다: ${text.split('\n').length}줄`);
});

test('MS-1: 갱신은 해당 날짜만 건드리고 다른 날짜는 불변이다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msb-ktb-'));
  const path = join(dir, 'nodes.json');
  try {
    const recA = B.computeDay(fixtureBonds(), DATE);
    let doc = B.upsertDate(B.emptyDoc(), '2026-08-10', recA);
    doc = B.upsertDate(doc, '2026-08-12', recA);
    writeFileSync(path, B.serialize(doc), 'utf8');
    const before = JSON.parse(readFileSync(path, 'utf8'));

    const recB = B.computeDay(fixtureBonds().filter(b => b.lineage !== 'K3'), DATE);
    const updated = B.upsertDate(B.readDoc(path), '2026-08-11', recB);
    writeFileSync(path, B.serialize(updated), 'utf8');
    const after = JSON.parse(readFileSync(path, 'utf8'));

    assert.deepEqual(after.series['2026-08-10'], before.series['2026-08-10']);
    assert.deepEqual(after.series['2026-08-12'], before.series['2026-08-12']);
    assert.deepEqual(Object.keys(after.series), ['2026-08-10', '2026-08-11', '2026-08-12']);
    assert.equal(after.schema_version, 2);
    assert.deepEqual(after.nodes, B.NODES);

    // 같은 입력 재실행은 바이트 동일 (zero-diff)
    assert.equal(
      B.serialize(B.upsertDate(B.readDoc(path), '2026-08-11', recB)),
      readFileSync(path, 'utf8'),
    );

    // 기존 날짜 덮어쓰기는 그 날짜만 바뀐다
    const overwritten = B.upsertDate(B.readDoc(path), '2026-08-10', recB);
    assert.deepEqual(overwritten.series['2026-08-10'], recB);
    assert.deepEqual(overwritten.series['2026-08-12'], before.series['2026-08-12']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MS-1: 스키마 버전이 다르면 읽기를 거부한다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'msb-ktb-'));
  const path = join(dir, 'nodes.json');
  try {
    writeFileSync(path, JSON.stringify({ schema_version: 1, nodes: B.NODES, series: {} }), 'utf8');
    assert.throws(() => B.readDoc(path), /스키마 버전 불일치/);
    assert.deepEqual(B.readDoc(join(dir, 'none.json')), B.emptyDoc());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('MS-1: 커밋된 data/msb-ktb-nodes.json 이 스키마 v2 다', () => {
  const doc = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'msb-ktb-nodes.json'), 'utf8'));
  assert.equal(doc.schema_version, 2);
  assert.deepEqual(doc.nodes, B.NODES);
  assert.deepEqual(doc.pairs, B.PAIRS);
  assert.ok(doc.series && typeof doc.series === 'object');
});

// ── 9. 실데이터 앵커 (원본 xlsx 가 있을 때만) ───────────────────────────────
const ANCHOR_XLSX = join(__dirname, '..', 'data', 'raw', '국고통안.xlsx');
const ANCHOR_DATE = '2026-08-12';
const anchorSkip = existsSync(ANCHOR_XLSX)
  ? false
  : `실데이터 미배치 — ${ANCHOR_XLSX} 를 두면 실행됩니다(유료 민평이라 커밋 금지, .gitignore 대상)`;
if (anchorSkip) console.error(`ℹ MS-1 실데이터 앵커 skip: ${anchorSkip}`);

test('MS-1: 실데이터 앵커 (2026-08-12)', { skip: anchorSkip }, t => {
  const near = (actual, expected, tol, label) => {
    assert.notEqual(actual, null, `${label} 이 null`);
    assert.ok(Math.abs(actual - expected) <= tol, `${label}: ${actual} (기대 ${expected} ±${tol})`);
  };

  const { series, stats } = B.buildSeries(B.readAoa(ANCHOR_XLSX));
  t.diagnostic(`종목 ${stats.bonds} / raw ${stats.rawDays}일 → valid ${stats.validDays}일 / 계보 ${JSON.stringify(stats.lineage)}`);

  near(stats.validDays, B.EXPECT.validDays, B.EXPECT.tol, '유효일수');
  assert.equal(B.checkDayCount(stats).ok, true, B.checkDayCount(stats).message);

  const rec = series[ANCHOR_DATE];
  assert.ok(rec, `${ANCHOR_DATE} 레코드 없음 (마지막 일자: ${Object.keys(series).slice(-1)[0]})`);

  const at = n => B.NODES.indexOf(n);
  near(rec.liq.msb[at(1.0)], -16.5, 1.5, 'liq.msb @1.0');
  near(rec.liq.ktb[at(1.0)], -3.2, 1.5, 'liq.ktb @1.0');
  // 교차 축(통안↔국고) 고정용 — liq 앵커만으로는 검증되지 않는 축이다.
  near(rec.sp.M2_K3[at(1.75)], 5.81, 0.30, 'sp.M2_K3 @1.75');
  near(rec.sp.M2_K2[at(1.75)], 2.41, 0.30, 'sp.M2_K2 @1.75');
  near(rec.sp.M3_K3[at(2.50)], 6.06, 0.30, 'sp.M3_K3 @2.50');
  near(rec.liq.delta[at(1.0)], -13.29, 0.30, 'liq.delta @1.0');
});
