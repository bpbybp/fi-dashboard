// CS-1 빌더 파싱·계산 테스트 — node --test (인자 없이 자동탐색).
//
// 검사 대상은 js/cs1/cs1-parse.js 의 순수부다. 실제 xlsx 는 유료 소스라 레포에 없고
// (.gitignore: *.xlsx) 매일 바뀌므로, 소형 인메모리 픽스처로 **구조 불변식**을 고정한다.
// 실데이터 정합은 별도로 확인했다 — CS-1 산출물(yield 시트 경로)과 기존 credit-spread
// (spread 시트 경로)는 완전히 독립인데 662,046셀 전량 일치했다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CROSS_PAIRS, KTB_CODE, VS,
  buildSpreads, colToIdx, extractBlocks, findLayout, parseTenor, serialize, serialToISO, toBp1,
} from '../js/cs1/cs1-parse.js';

// ── 픽스처 조립 ───────────────────────────────────────────────────────────────
// 실제 소스를 흉내낸다: 수식 행 + 만기 라벨 행 + 데이터 행. 열 배치는 호출자가 정한다.
// 열 인덱스를 하드코딩하지 않는다는 규칙을 검증하려면 배치를 마음대로 흔들 수 있어야 한다.

const idxToCol = (n) => { let s = '', k = n + 1; while (k > 0) { const r = (k - 1) % 26; s = String.fromCharCode(65 + r) + s; k = Math.floor((k - 1) / 26); } return s; };

/**
 * @param {object} p
 * @param {Array} p.order        [{ code, title?, tenors:[라벨], vals:[행][만기] }] — 배치 순서
 * @param {number[]} p.serials   데이터 행의 일자 Excel 시리얼
 * @param {boolean} [p.useRanges]      수식에 출력 범위를 넣을지 (false = 범위 없는 퇴화 입력)
 * @param {boolean} [p.firstAbsorbsDate] 첫 블록 수식을 일자 열에 얹고 범위에 일자 열을 포함
 *                                       (실제 국고 블록이 A18:L18 로 12칸인 상황 재현)
 * @param {Array} [p.blankRows]  데이터 사이에 끼워 넣을 잡음 행
 */
function makeSheet({ order, serials, useRanges = true, firstAbsorbsDate = true, blankRows = [] }) {
  const labelRow = ['일자'];
  const layout = [];               // [{ spec, cols:[열인덱스] }]
  for (const spec of order) {
    const cols = [];
    for (const t of spec.tenors) { cols.push(labelRow.length); labelRow.push(t); }
    layout.push({ spec, cols });
  }

  const formulaRow = [];
  layout.forEach(({ spec, cols }, i) => {
    const absorbs = i === 0 && firstAbsorbsDate;
    const at = absorbs ? 0 : cols[0];
    const from = absorbs ? 0 : cols[0];
    const to = cols[cols.length - 1];
    const rng = useRanges ? `${idxToCol(from)}18:${idxToCol(to)}18` : '';
    const title = spec.title ? `,Title=${spec.title}` : '';
    formulaRow[at] = `_xll.IMDH("IR","${spec.code}",${rng},$B$2,$B$3,"Per=D,Pos=20,Orient=V${title},DtFmt=1")`;
  });

  const aoa = [['머리글'], [], labelRow];   // 수식 행은 값 AOA 에선 의미 없는 자리
  const formulaRows = [];
  formulaRows[1] = formulaRow;              // 수식 행 = 인덱스 1, 라벨 행 = 인덱스 2 (위치 가정 없음 확인용)

  serials.forEach((serial, r) => {
    const row = [serial];
    for (const { spec, cols } of layout) cols.forEach((c, j) => { row[c] = spec.vals[r][j]; });
    aoa.push(row);
  });
  for (const b of blankRows) aoa.push(b);
  return { formulaRows, aoa };
}

/** 픽스처 → buildSpreads 결과 (한 줄로 쓰기 위한 래퍼). */
function run(sheet, opts = {}) {
  const layout = findLayout(sheet);
  const { blocks, skipped } = extractBlocks({
    formulaRow: layout.formulaRow, labelRow: layout.labelRow, codeNames: opts.codeNames,
  });
  const built = buildSpreads({ blocks, rows: sheet.aoa.slice(layout.labelRowIdx + 1), ...opts });
  return { layout, blocks, skipped, built };
}

const T3 = ['3월이하(당일)', '1년이하(당일)', '3년이하(당일)'];
const KTB = (vals) => ({ code: KTB_CODE, title: '국고채권', tenors: T3, vals });
const SER = [42006, 42007];

// ── 1) 동적 매핑: 열 순서를 흔들어도 결과 동일 ────────────────────────────────

test('동적 매핑 — 블록 배치를 바꿔도 시리즈 값이 동일하다', () => {
  const ktb = KTB([[1.0, 1.1, 1.2], [1.01, 1.11, 1.21]]);
  const a = { code: 'BONDAVG16', title: '산금채AAA', tenors: T3, vals: [[1.05, 1.16, 1.28], [1.06, 1.17, 1.29]] };
  const b = { code: 'BONDAVG20', title: '은행채AAA', tenors: T3, vals: [[1.09, 1.21, 1.35], [1.10, 1.22, 1.36]] };

  const base = run(makeSheet({ order: [ktb, a, b], serials: SER })).built;

  // 국고를 가운데로, 뒤로, 그리고 수식 범위를 아예 없앤 경우까지.
  const variants = [
    makeSheet({ order: [a, ktb, b], serials: SER, firstAbsorbsDate: false }),
    makeSheet({ order: [b, a, ktb], serials: SER, firstAbsorbsDate: false }),
    makeSheet({ order: [ktb, b, a], serials: SER }),
    makeSheet({ order: [a, b, ktb], serials: SER, useRanges: false, firstAbsorbsDate: false }),
  ];
  for (const [i, v] of variants.entries()) {
    const got = run(v).built;
    assert.deepEqual(got.dates, base.dates, `variant ${i}: 일자`);
    assert.deepEqual(got.tenors, base.tenors, `variant ${i}: 만기`);
    for (const id of base.seriesOrder) {
      assert.ok(got.series[id], `variant ${i}: ${id} 누락`);
      assert.deepEqual(got.series[id], base.series[id], `variant ${i}: ${id} 값 불일치`);
    }
  }
});

test('동적 매핑 — 국고 블록 범위에 낀 일자 열은 만기로 잡히지 않는다', () => {
  const { blocks } = run(makeSheet({ order: [KTB([[1, 1.1, 1.2], [1, 1.1, 1.2]])], serials: SER }));
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].c0, 0, '국고 범위는 일자 열(0)부터 시작한다');
  assert.deepEqual(blocks[0].cols.map((c) => c.tenor), ['3월', '1년', '3년'], '만기는 3개뿐');
});

test('동적 매핑 — 수식 행·라벨 행 위치를 가정하지 않는다', () => {
  const { layout } = run(makeSheet({ order: [KTB([[1, 1, 1], [1, 1, 1]])], serials: SER }));
  assert.equal(layout.formulaRowIdx, 1);   // 17행이 아니라 픽스처가 둔 자리
  assert.equal(layout.labelRowIdx, 2);
});

// ── 2) 스프레드 산술과 반올림 시점 ────────────────────────────────────────────

test('스프레드 = (시리즈 − 국고) × 100, 계산 시점 1자리 반올림', () => {
  const ktb = KTB([[1.0, 1.0, 1.0]]);
  //                3월: +23.4567bp → 23.5 (버림 아님) / 1년: 정확히 −5bp / 3년: 0
  const x = { code: 'BONDAVG16', title: '산금채AAA', tenors: T3, vals: [[1.234567, 0.95, 1.0]] };
  const { built } = run(makeSheet({ order: [ktb, x], serials: [42006] }));
  const s = built.series['산금채AAA' + VS + '국고채권'];
  assert.equal(s['3월'][0], 23.5);
  assert.equal(s['1년'][0], -5);
  assert.equal(s['3년'][0], 0);
  assert.ok(Object.is(s['3년'][0], 0), '−0 이 아니라 0 이어야 한다');
});

test('섹터 간 페어는 원수익률 차에서 한 번만 반올림한다 (이중 반올림 회피)', () => {
  // x−국고 = 10.04bp → 10.0 / y−국고 = 4.96bp → 5.0 / x−y = 5.08bp → 5.1
  // 이미 반올림된 두 값을 빼면 10.0 − 5.0 = 5.0 이 되어 0.1bp 어긋난다.
  const ktb = KTB([[1.0, 1.0, 1.0]]);
  const x = { code: 'BONDAVG20', title: '은행채AAA', tenors: T3, vals: [[1.1004, 1.1004, 1.1004]] };
  const y = { code: 'BONDAVG09', title: '공사채AAA', tenors: T3, vals: [[1.0496, 1.0496, 1.0496]] };
  const { built } = run(makeSheet({ order: [ktb, x, y], serials: [42006] }));

  assert.equal(built.series['은행채AAA' + VS + '국고채권']['3월'][0], 10);
  assert.equal(built.series['공사채AAA' + VS + '국고채권']['3월'][0], 5);
  assert.equal(built.series['은행채AAA' + VS + '공사채AAA']['3월'][0], 5.1, '원값 1회 반올림이면 5.1 (이중 반올림이면 5.0)');
});

test('지정된 섹터 간 페어만 생성한다', () => {
  const ktb = KTB([[1, 1, 1]]);
  const mk = (code, title) => ({ code, title, tenors: T3, vals: [[1.1, 1.1, 1.1]] });
  const { built } = run(makeSheet({
    order: [ktb, mk('BONDAVG16', '산금채AAA'), mk('BONDAVG18', '중금채AAA'), mk('BONDAVG20', '은행채AAA'), mk('BONDAVG09', '공사채AAA')],
    serials: [42006],
  }));
  const cross = built.seriesOrder.filter((id) => !id.endsWith(VS + '국고채권'));
  assert.deepEqual(cross, CROSS_PAIRS.map((p) => p.x + VS + p.y));
  assert.equal(built.seriesOrder.length, 4 + CROSS_PAIRS.length, 'vs-국고 4 + 섹터간 5');
  assert.equal(built.crossMissing.length, 0);
});

test('섹터 간 페어의 한쪽이 소스에 없으면 생략하고 기록한다 (중단 없음)', () => {
  const ktb = KTB([[1, 1, 1]]);
  const only = { code: 'BONDAVG20', title: '은행채AAA', tenors: T3, vals: [[1.1, 1.1, 1.1]] };
  const { built } = run(makeSheet({ order: [ktb, only], serials: [42006] }));
  assert.deepEqual(built.seriesOrder, ['은행채AAA' + VS + '국고채권']);
  assert.equal(built.crossMissing.length, CROSS_PAIRS.length);
  assert.ok(built.crossMissing.every((m) => m.missing.length > 0));
});

// ── 3) 미지 BONDAVG 코드 — 실패하지 않고 그대로 수록 ──────────────────────────

test('미지 BONDAVG 코드는 중단 없이 코드 이름으로 수록된다', () => {
  const ktb = KTB([[1.0, 1.0, 1.0]]);
  const unknown = { code: 'BONDAVG99', tenors: T3, vals: [[1.5, 1.5, 1.5]] }; // Title= 없음
  const { built, blocks } = run(makeSheet({ order: [ktb, unknown], serials: [42006] }));
  assert.equal(blocks.length, 2);
  assert.equal(built.sectors[1], 'BONDAVG99', 'Title·index 둘 다 없으면 코드가 이름');
  assert.equal(built.series['BONDAVG99' + VS + '국고채권']['3월'][0], 50);
  assert.equal(built.codes['BONDAVG99'], 'BONDAVG99');
});

test('Title= 이 없으면 index 시트 이름을 쓴다', () => {
  const ktb = KTB([[1.0, 1.0, 1.0]]);
  const u = { code: 'BONDAVG77', tenors: T3, vals: [[1.1, 1.1, 1.1]] };
  const { built } = run(makeSheet({ order: [ktb, u], serials: [42006] }), { codeNames: { BONDAVG77: '정금채' } });
  assert.ok(built.series['정금채' + VS + '국고채권'], 'index 시트 이름으로 수록');
});

test('표시명이 겹치면 코드를 덧붙여 구분한다 (덮어쓰기 금지)', () => {
  const ktb = KTB([[1.0, 1.0, 1.0]]);
  const a = { code: 'BONDAVG20', title: '은행채AAA', tenors: T3, vals: [[1.1, 1.1, 1.1]] };
  const b = { code: 'BONDAVG21', title: '은행채AAA', tenors: T3, vals: [[1.2, 1.2, 1.2]] };
  const { built } = run(makeSheet({ order: [ktb, a, b], serials: [42006] }));
  assert.deepEqual(built.sectors, ['국고채권', '은행채AAA', '은행채AAA(BONDAVG21)']);
  assert.equal(built.series['은행채AAA' + VS + '국고채권']['3월'][0], 10);
  assert.equal(built.series['은행채AAA(BONDAVG21)' + VS + '국고채권']['3월'][0], 20);
});

test('국고 블록이 없으면 명시적으로 실패한다', () => {
  const a = { code: 'BONDAVG16', title: '산금채AAA', tenors: T3, vals: [[1.1, 1.1, 1.1]] };
  assert.throws(
    () => run(makeSheet({ order: [a], serials: [42006] })),
    (e) => e.message.includes(KTB_CODE) && e.message.includes('BONDAVG16'),
    '국고 코드와 발견된 코드 목록이 메시지에 있어야 한다',
  );
});

// ── 4) 결측 null 전파 — 채우지 않는다 ─────────────────────────────────────────

test('결측은 null 로 전파된다 (보간·0 대체 없음)', () => {
  const ktb = KTB([[1.0, 1.0, 1.0], [null, 1.0, 1.0], [1.0, 1.0, 1.0]]);
  const x = {
    code: 'BONDAVG16', title: '산금채AAA', tenors: T3,
    vals: [[1.1, null, 1.1], [1.1, 1.1, 1.1], [undefined, '#N/A', 1.1]],
  };
  const { built } = run(makeSheet({ order: [ktb, x], serials: [42006, 42007, 42008] }));
  const s = built.series['산금채AAA' + VS + '국고채권'];
  assert.deepEqual(s['3월'], [10, null, null], '시리즈 결측·국고 결측·undefined 모두 null');
  assert.deepEqual(s['1년'], [null, 10, null], '문자열(#N/A)도 null');
  assert.deepEqual(s['3년'], [10, 10, 10], '온전한 만기는 영향 없음');
});

test('섹터 간 페어도 한쪽만 결측이면 null', () => {
  const ktb = KTB([[1.0, 1.0, 1.0]]);
  const x = { code: 'BONDAVG20', title: '은행채AAA', tenors: T3, vals: [[1.1, null, 1.1]] };
  const y = { code: 'BONDAVG09', title: '공사채AAA', tenors: T3, vals: [[1.2, 1.2, null]] };
  const { built } = run(makeSheet({ order: [ktb, x, y], serials: [42006] }));
  const s = built.series['은행채AAA' + VS + '공사채AAA'];
  assert.equal(s['3월'][0], -10);
  assert.equal(s['1년'][0], null);
  assert.equal(s['3년'][0], null);
});

test('한 섹터에만 있는 만기는 다른 섹터에서 null 열이 된다', () => {
  const ktb = KTB([[1.0, 1.0, 1.0]]);
  const short = { code: 'BONDAVG16', title: '산금채AAA', tenors: ['3월이하(당일)', '1년이하(당일)'], vals: [[1.1, 1.1]] };
  const { built } = run(makeSheet({ order: [ktb, short], serials: [42006] }));
  const s = built.series['산금채AAA' + VS + '국고채권'];
  assert.deepEqual(built.tenors, ['3월', '1년', '3년'], '만기 축은 국고 기준');
  assert.deepEqual(s['3년'], [null], '미제공 만기는 null 열');
});

test('데이터가 아닌 행(빈 행·문자열 A열)은 제외된다', () => {
  const ktb = KTB([[1.0, 1.0, 1.0], [1.0, 1.0, 1.0]]);
  const sheet = makeSheet({ order: [ktb], serials: SER, blankRows: [[], ['합계', 1, 2, 3], [null], [1, 9, 9, 9]] });
  const { built } = run(sheet);
  assert.equal(built.dates.length, 2, '시리얼 하한 미만(1)·빈 행·문자열 행 제외');
  assert.deepEqual(built.dates, ['2015-01-02', '2015-01-03']);
});

// ── 보조 유틸 ─────────────────────────────────────────────────────────────────

test('만기 라벨 정규화', () => {
  assert.deepEqual(parseTenor('3월이하(당일)'), { label: '3월', years: 0.25 });
  assert.deepEqual(parseTenor('1.5년이하(당일)'), { label: '1.5년', years: 1.5 });
  assert.deepEqual(parseTenor('10년이하(당일)'), { label: '10년', years: 10 });
  assert.equal(parseTenor('일자'), null);
  assert.equal(parseTenor(''), null);
  assert.equal(parseTenor(null), null);
  assert.equal(parseTenor('0년'), null);
});

test('열 문자 → 인덱스', () => {
  assert.equal(colToIdx('A'), 0);
  assert.equal(colToIdx('L'), 11);
  assert.equal(colToIdx('M'), 12);
  assert.equal(colToIdx('AI'), 34);
  assert.equal(colToIdx('GF'), 187);
});

test('Excel 시리얼 → ISO', () => {
  assert.equal(serialToISO(42006), '2015-01-02');
  assert.equal(serialToISO(46254), '2026-08-20');
});

test('toBp1 — 결측 전파와 부호', () => {
  assert.equal(toBp1(1.1, 1.0), 10);
  assert.equal(toBp1(1.0, 1.1), -10);
  assert.equal(toBp1(null, 1.0), null);
  assert.equal(toBp1(1.0, undefined), null);
  assert.equal(toBp1('1.1', 1.0), null);
  assert.equal(toBp1(NaN, 1.0), null);
  assert.ok(Object.is(toBp1(1.0, 1.0), 0), '동일값은 +0');
});

// ── 직렬화 ───────────────────────────────────────────────────────────────────

test('직렬화 — 유효 JSON, 수치 배열은 한 줄, 값 왕복 보존', () => {
  const ktb = KTB([[1.0, 1.0, 1.0], [1.0, 1.0, 1.0]]);
  const x = { code: 'BONDAVG16', title: '산금채AAA', tenors: T3, vals: [[1.1, null, 1.1], [1.2, 1.2, 1.2]] };
  const { built } = run(makeSheet({ order: [ktb, x], serials: SER }));
  const doc = {
    meta: { tenors: built.tenors, seriesOrder: built.seriesOrder },
    dates: built.dates, series: built.series,
  };
  const text = serialize(doc);
  const back = JSON.parse(text);
  assert.deepEqual(back.dates, built.dates);
  assert.deepEqual(back.series, built.series, '왕복 후 값 보존(null 포함)');

  // 만기별 배열이 정확히 한 줄씩 — 여러 줄로 풀리면 파일이 수십 MB가 되고 diff 가 안 읽힌다.
  const lines = text.split('\n');
  for (const id of built.seriesOrder) {
    for (const t of built.tenors) {
      const want = `      ${JSON.stringify(t)}: ${JSON.stringify(built.series[id][t])}`;
      assert.ok(lines.some((l) => l === want || l === want + ','), `${id}/${t} 가 한 줄이 아니다`);
    }
  }
  assert.ok(lines.some((l) => l.startsWith('  "dates": [') && l.endsWith('],')), 'dates 도 한 줄');
  assert.ok(text.endsWith('\n'), '개행으로 끝난다');
});
