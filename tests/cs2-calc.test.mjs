// CS-2 크레딧 스프레드 추이 — 계산·계열 구성 테스트. node --test (인자 없이 자동탐색).
//
// 초점은 세 가지다: (1) 이동평균이 부분 창에서 값을 내지 않는가, (2) 역사적 평균의 표본
// 구간이 달력 기준으로 정확한가, (3) A − B 가 결측을 채우지 않는가. 셋 중 하나라도 틀리면
// 선은 그럴듯하게 그려지는데 숫자가 조용히 틀린다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  HIST_WINDOWS, MA_WINDOWS, VIEW_WINDOWS, WINDOW_LABEL,
  diffSeries, lastValidIndex, legValues, movingAverage, sectorList, seriesId,
  changeOver, heatT, rangeWithPad, ratioOf, shiftMonths, sparkPath, spreadLabels, startIndexFor, windowStats,
  yearMask, yearlyMeans,
} from '../js/cs2/cs2-calc.js';
import {
  EXCLUDE_YEAR, HEAT_KINDS, MODES, OV_DEFAULT_TENORS, TB_MAX_ALPHA, buildLine, defaultState, heatBg, histLabelOf,
  histStats, isPair, matrixHTML, mergeState, overviewCellHTML, overviewHTML, statsHTML, tableData, yearTableHTML,
} from '../js/cs2/cs2-ui.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

const DOC = {
  meta: {
    benchmark: '국고채권', tenors: ['1년', '3년'],
    seriesOrder: ['카드채AA+_vs_국고채권', '여전채AA-_vs_국고채권', '산금채AAA_vs_은행채AAA'],
  },
  dates: ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07'],
  series: {
    '카드채AA+_vs_국고채권': { '1년': [20, 21, 22, 23], '3년': [30, 31, null, 33] },
    '여전채AA-_vs_국고채권': { '1년': [40, 40, 40, 40], '3년': [55.5, null, 57, 58.2] },
    '산금채AAA_vs_은행채AAA': { '1년': [-1, -1, -1, -1], '3년': [-2, -2, -2, -2] },
  },
};

// ── 다리·차 ──────────────────────────────────────────────────────────────────

test('sectorList — 국고 대비 시리즈만, 소스 순서 유지(섹터 간 페어 제외)', () => {
  assert.deepEqual(sectorList(DOC.meta), ['카드채AA+', '여전채AA-']);
  assert.equal(seriesId('카드채AA+', '국고채권'), '카드채AA+_vs_국고채권');
});

test('legValues — 없는 섹터·만기는 null', () => {
  assert.deepEqual(legValues(DOC, '카드채AA+', '1년'), [20, 21, 22, 23]);
  assert.equal(legValues(DOC, '카드채AA+', '10년'), null);
  assert.equal(legValues(DOC, '없는섹터', '1년'), null);
});

test('diffSeries — A − B, 한쪽이라도 결측이면 그 날은 비운다', () => {
  const a = DOC.series['카드채AA+_vs_국고채권']['3년'];
  const b = DOC.series['여전채AA-_vs_국고채권']['3년'];
  assert.deepEqual(diffSeries(a, b), [-25.5, null, null, -25.2]);
});

test('diffSeries — 부동소수 찌꺼기 없이 소수 1자리', () => {
  assert.deepEqual(diffSeries([0.3], [0.1]), [0.2]);
  assert.deepEqual(diffSeries([29.1], [27.8]), [1.3]);
});

// ── 이동평균 ─────────────────────────────────────────────────────────────────

test('movingAverage — 창이 다 차기 전에는 값을 내지 않는다', () => {
  const ma = movingAverage([1, 2, 3, 4, 5], 3);
  assert.deepEqual(ma.slice(0, 2), [null, null]);
  near(ma[2], 2); near(ma[3], 3); near(ma[4], 4);
});

test('movingAverage — 창 안에 결측이 하나라도 있으면 null, 결측이 빠져나가면 복귀', () => {
  const ma = movingAverage([1, 2, null, 4, 5, 6], 2);
  assert.deepEqual([ma[0], ma[2], ma[3]], [null, null, null]);
  near(ma[1], 1.5); near(ma[4], 4.5); near(ma[5], 5.5);
});

test('movingAverage — 굴린 합이 직접 계산과 일치(누적 오차 점검)', () => {
  const v = Array.from({ length: 600 }, (_, i) => Math.round((40 + 15 * Math.sin(i / 17) + (i % 7) * 0.3) * 10) / 10);
  for (const n of MA_WINDOWS) {
    const ma = movingAverage(v, n);
    for (const i of [n - 1, 300, 599]) {
      const direct = v.slice(i - n + 1, i + 1).reduce((s, x) => s + x, 0) / n;
      near(ma[i], direct, 1e-7);
    }
    assert.equal(ma[n - 2], null);
  }
});

test('movingAverage — 길이가 창보다 짧으면 전부 null', () => {
  assert.deepEqual(movingAverage([1, 2], 20), [null, null]);
});

// ── 달력 구간 ────────────────────────────────────────────────────────────────

test('shiftMonths — 해 넘김·말일 당김', () => {
  assert.equal(shiftMonths('2026-11-11', 12), '2025-11-11');
  assert.equal(shiftMonths('2026-01-15', 3), '2025-10-15');
  assert.equal(shiftMonths('2026-03-31', 1), '2026-02-28');
  assert.equal(shiftMonths('2024-02-29', 12), '2023-02-28');
  assert.equal(shiftMonths('2026-11-11', 120), '2016-11-11');
});

test('startIndexFor — N년 전 같은 날 이후 첫 관측, max 는 0', () => {
  const dates = ['2023-11-10', '2024-11-08', '2024-11-11', '2024-11-12', '2025-11-11', '2026-11-11'];
  assert.equal(startIndexFor(dates, '1y'), 4, '2025-11-11 포함');
  assert.equal(startIndexFor(dates, '2y'), 2, '2024-11-11 포함 · 2024-11-08 제외');
  assert.equal(startIndexFor(dates, '3y'), 1);
  assert.equal(startIndexFor(dates, '5y'), 0, '이력이 더 짧으면 처음부터');
  assert.equal(startIndexFor(dates, 'max'), 0);
});

test('기간 키 — 화면 토글 전부에 라벨이 있다', () => {
  for (const k of [...VIEW_WINDOWS, ...HIST_WINDOWS]) assert.ok(WINDOW_LABEL[k], k);
  assert.deepEqual(HIST_WINDOWS, ['2y', '3y', '5y', '10y', 'max']);
  assert.deepEqual(MA_WINDOWS, [20, 60, 120, 200]);
  assert.ok(VIEW_WINDOWS.includes('1y'));
});

// ── 구간 통계 ────────────────────────────────────────────────────────────────

test('windowStats — 평균·범위·표본수, 결측 건너뜀', () => {
  const s = windowStats([10, null, 20, 30], 0, 3);
  assert.equal(s.n, 3);
  near(s.mean, 20); assert.equal(s.min, 10); assert.equal(s.max, 30);
  assert.equal(s.minIdx, 0); assert.equal(s.maxIdx, 3);
  assert.equal(s.last, 30); near(s.gap, 10);
  near(s.sd, 10); near(s.z, 1);
});

test('windowStats — 백분위: 최저 근처 0, 최고 근처 100, 동률은 절반', () => {
  near(windowStats([1, 2, 3, 4, 5], 0, 4).pct, 90);   // 아래 4 + 자기 0.5 → 4.5/5
  near(windowStats([5, 4, 3, 2, 1], 0, 4).pct, 10);
  near(windowStats([3, 3, 3, 3], 0, 3).pct, 50);
});

test('windowStats — 구간 밖은 보지 않는다', () => {
  const s = windowStats([100, 1, 2, 3], 1, 3);
  near(s.mean, 2); assert.equal(s.max, 3); assert.equal(s.n, 3);
});

test('windowStats — 빈 구간·평평한 구간', () => {
  assert.equal(windowStats([null, null], 0, 1).mean, null);
  const flat = windowStats([7, 7, 7], 0, 2);
  assert.equal(flat.z, null, 'σ=0 이면 z 를 내지 않는다');
  near(flat.gap, 0);
});

test('lastValidIndex — 뒤에서부터 첫 유효 관측', () => {
  assert.equal(lastValidIndex([1, 2, null]), 1);
  assert.equal(lastValidIndex([null]), -1);
});

// ── 끝점 라벨 배치 ───────────────────────────────────────────────────────────

test('spreadLabels — 겹치면 최소 간격으로 띄우고 순서를 지킨다', () => {
  const out = spreadLabels([{ y: 100 }, { y: 102 }, { y: 101 }], 15, 400);
  assert.equal(out[0], 100);
  assert.ok(out[2] - out[0] >= 15 && out[1] - out[2] >= 15, JSON.stringify(out));
});

test('spreadLabels — 아래로 넘치면 영역 안으로 끌어올린다', () => {
  const out = spreadLabels([{ y: 395 }, { y: 398 }, { y: 399 }], 15, 400);
  assert.ok(Math.max(...out) <= 400, JSON.stringify(out));
  const sorted = [...out].sort((a, b) => a - b);
  assert.ok(sorted[1] - sorted[0] >= 15 && sorted[2] - sorted[1] >= 15, JSON.stringify(out));
});

test('spreadLabels — 떨어져 있으면 건드리지 않는다', () => {
  assert.deepEqual(spreadLabels([{ y: 10 }, { y: 200 }], 15, 400), [10, 200]);
});

// ── 계열 구성(화면 상태 → 한 줄) ─────────────────────────────────────────────

test('buildLine — 단일 모드는 국고 대비 스프레드 그대로', () => {
  const st = defaultState(DOC.meta);
  assert.equal(isPair(st), false);
  assert.equal(st.a.sector, '카드채AA+');
  assert.equal(st.a.tenor, '3년');
  const line = buildLine(DOC, st);
  assert.deepEqual(line.values, [30, 31, null, 33]);
  assert.equal(line.title, '카드채AA+ 3년 − 국고채권 3년');
  assert.equal(line.legB, null);
});

test('buildLine — 쌍 모드는 A − B, 만기가 달라도 스프레드끼리 뺀다', () => {
  const st = defaultState(DOC.meta);
  st.b = { sector: '여전채AA-', tenor: '3년' };
  const line = buildLine(DOC, st);
  assert.equal(line.title, '카드채AA+ 3년 − 여전채AA- 3년');
  assert.deepEqual(line.values, [-25.5, null, null, -25.2]);

  st.a.tenor = '1년';
  assert.deepEqual(buildLine(DOC, st).values, [-35.5, null, -35, -35.2]);
});

test('buildLine — 없는 다리는 값 없이 누락 이름을 돌려준다', () => {
  const st = defaultState(DOC.meta);
  st.a.tenor = '10년';
  const line = buildLine(DOC, st);
  assert.equal(line.values, null);
  assert.equal(line.missing, '카드채AA+ 10년');
});

test('mergeState — 소스에 없는 섹터·만기·기간은 무시하고 기본값 유지', () => {
  const st = mergeState(defaultState(DOC.meta), {
    a: { sector: '사라진섹터', tenor: '1년' }, b: { sector: '여전채AA-', tenor: '99년' },
    view: '7y', hist: '10y', ma: { 20: false, 200: true, 999: true }, showMean: false,
  }, DOC.meta);
  assert.deepEqual(st.a, { sector: '카드채AA+', tenor: '1년' });
  assert.deepEqual(st.b, { sector: '여전채AA-', tenor: '3년' });
  assert.equal(st.view, '1y');
  assert.equal(st.hist, '10y');
  assert.deepEqual(st.ma, { 20: false, 60: true, 120: false, 200: true });
  assert.equal(st.showMean, false);
  assert.deepEqual(mergeState(defaultState(DOC.meta), null, DOC.meta), defaultState(DOC.meta));
});

test('statsHTML — 현재·전일 Δ 는 직전 유효 관측 기준, 값은 데이터에서 온다', () => {
  const st = defaultState(DOC.meta);
  const line = buildLine(DOC, st);                    // [30, 31, null, 33]
  const hist = windowStats(line.values, 0, 3);
  const html = statsHTML(line, hist, '5Y', DOC.dates);
  assert.ok(html.includes('33.0'), html);
  assert.ok(html.includes('전일 Δ +2.0'), '결측일을 건너뛴 직전 관측(31) 대비');
  assert.ok(html.includes('5Y 평균') && html.includes('31.3'), html);
  assert.ok(html.includes('2026-01-07'));
});

// ── 전체 조망 ────────────────────────────────────────────────────────────────

test('sparkPath — 양 끝이 상자 양 끝에 닿고, 높은 값이 위(y 작음)', () => {
  const d = sparkPath([0, 10], 0, 1, { w: 100, h: 40, lo: 0, hi: 10 });
  assert.equal(d, 'M0.0 40.0L100.0 0.0');
});

test('sparkPath — 결측에서 선을 끊는다(이어 긋지 않는다)', () => {
  const d = sparkPath([1, null, 3, 4], 0, 3, { w: 90, h: 10, lo: 0, hi: 10 });
  assert.equal((d.match(/M/g) || []).length, 2, d);
});

test('sparkPath — 솎아도 마지막 점은 남는다', () => {
  const v = Array.from({ length: 1000 }, (_, i) => i);
  const d = sparkPath(v, 0, 999, { w: 100, h: 40, lo: 0, hi: 999, maxPts: 50 });
  assert.ok(d.endsWith('L100.0 0.0'), d.slice(-30));
  assert.ok((d.match(/[ML]/g) || []).length <= 52);
});

test('sparkPath — 구간·범위가 성립하지 않으면 빈 문자열', () => {
  assert.equal(sparkPath([1], 0, 0, { w: 1, h: 1, lo: 0, hi: 1 }), '');
  assert.equal(sparkPath([1, 1], 0, 1, { w: 1, h: 1, lo: 1, hi: 1 }), '');
});

test('rangeWithPad — 구간 안 값과 추가 값(평균)을 함께 덮는다', () => {
  const r = rangeWithPad([[100, 10, 20]], 1, 2, [30], 0);
  assert.deepEqual(r, [10, 30]);
  assert.deepEqual(rangeWithPad([[5, 5]], 0, 1, [], 0.08), [4, 6]);
  assert.equal(rangeWithPad([[null]], 0, 0), null);
});

test('overviewCellHTML — 현재값·평균 대비·백분위가 데이터에서 온다', () => {
  const st = defaultState(DOC.meta);
  st.view = 'max'; st.hist = 'max'; st.ma = { 20: false, 60: false, 120: false, 200: false };
  const html = overviewCellHTML([20, 21, 22, 23], DOC.dates, st, '카드채AA+', '1년');
  assert.ok(html.includes('data-sector="카드채AA+"') && html.includes('data-tenor="1년"'));
  assert.ok(html.includes('<span class="v">23.0</span>'), html);
  assert.ok(html.includes('<span class="g">+1.5</span>'), '평균 21.5 대비');
  assert.ok(html.includes('MAX(22제외) 88%') || html.includes('MAX 88%'), html);   // (3 + 0.5) / 4
  assert.ok(html.includes('class="mean"') && html.includes('class="main"'));
  st.showMean = false;
  assert.ok(!overviewCellHTML([20, 21, 22, 23], DOC.dates, st, 'x', 'y').includes('class="mean"'));
  assert.ok(overviewCellHTML(null, DOC.dates, st, 'x', 'y').includes('class="nil"'));
});

test('overviewHTML — 섹터 수 × 만기 수만큼 칸이 깔린다', () => {
  const st = defaultState(DOC.meta);
  let { head, body } = overviewHTML(DOC, st);
  assert.equal((body.match(/<td/g) || []).length, 2 * 2, '기본 만기 중 소스에 있는 1년·3년');
  assert.ok(head.includes('<th>1년</th>') && head.includes('<th>3년</th>'));
  assert.deepEqual(OV_DEFAULT_TENORS, ['1년', '2년', '3년', '5년']);

  const doc = JSON.parse(readFileSync(join(ROOT, 'data', 'cs1', 'spreads.json'), 'utf8'));
  const s2 = defaultState(doc.meta); s2.ovAll = true; s2.view = 'max';
  ({ body } = overviewHTML(doc, s2));
  assert.equal((body.match(/<td data-sector/g) || []).length, sectorList(doc.meta).length * doc.meta.tenors.length);
});

// ── 평균 대비 표 ─────────────────────────────────────────────────────────────

const DOC22 = {
  meta: { benchmark: '국고채권', tenors: ['3년'], seriesOrder: ['은행채AAA_vs_국고채권'] },
  dates: ['2021-06-01', '2021-12-01', '2022-06-01', '2022-12-01', '2023-06-01', '2023-12-01', '2024-06-03', '2024-06-04',
    '2024-06-05', '2024-06-07', '2024-06-10', '2024-06-11'],
  series: { '은행채AAA_vs_국고채권': { '3년': [10, 20, 100, 120, 30, 40, 20, 22, 24, 26, 28, 30] } },
};

test('windowStats — skip 인 날은 표본에서 빠지되 현재값은 그대로', () => {
  const v = [10, 100, 20, 30];
  const s = windowStats(v, 0, 3, [false, true, false, false]);
  assert.equal(s.n, 3); near(s.mean, 20); assert.equal(s.max, 30); assert.equal(s.last, 30);
  const last = windowStats(v, 0, 3, [false, false, false, true]);
  assert.equal(last.last, 30, '마지막 날이 제외 대상이어도 현재값은 읽는다');
  near(last.mean, 130 / 3);
});

test('yearMask·yearlyMeans — 해 단위로 묶는다, 결측은 세지 않는다', () => {
  assert.deepEqual(yearMask(['2021-12-31', '2022-01-03', '2023-01-02'], '2022'), [false, true, false]);
  const ym = yearlyMeans([10, null, 30, 50], ['2021-01-04', '2021-01-05', '2021-01-06', '2022-01-03']);
  assert.deepEqual(ym, [{ year: '2021', mean: 20, n: 2 }, { year: '2022', mean: 50, n: 1 }]);
});

test('ratioOf — 평균이 0 이하면 배율을 내지 않는다', () => {
  near(ratioOf(42.5, 18), 42.5 / 18);
  assert.equal(ratioOf(10, 0), null);
  assert.equal(ratioOf(10, -5), null);
  assert.equal(ratioOf(null, 5), null);
});

test('changeOver — 전주비는 5영업일 전 대비, 결측이면 null', () => {
  assert.equal(changeOver([1, 2, 3, 4, 5, 6.5], 5, 5), 5.5);
  assert.equal(changeOver([null, 2, 3, 4, 5, 6], 5, 5), null);
  assert.equal(changeOver([1, 2], 1, 5), null);
});

test('heatT — 배율은 로그 대칭(2배 = +1, 0.5배 = −1), 범위 밖은 자른다', () => {
  near(heatT('ratio', { ratio: 2 }), 1); near(heatT('ratio', { ratio: 0.5 }), -1);
  near(heatT('ratio', { ratio: 1 }), 0); near(heatT('ratio', { ratio: 8 }), 1);
  near(heatT('gap', { gap: -5 }, 20), -0.25); near(heatT('gap', { gap: 99 }, 20), 1);
  near(heatT('pct', { pct: 75 }), 0.5);
  assert.equal(heatT('ratio', { ratio: null }), null);
  assert.equal(heatT('off', { ratio: 2 }), null);
});

test('heatBg — 평균이면 투명, 넓은 쪽 호박·좁은 쪽 청록, 농도 상한', () => {
  assert.equal(heatBg('off', { ratio: 2 }, 1), null);
  assert.ok(heatBg('ratio', { ratio: 1 }, 1).endsWith(', 0)'));
  assert.equal(heatBg('ratio', { ratio: 4 }, 1), `rgba(217, 144, 42, ${TB_MAX_ALPHA})`);
  assert.equal(heatBg('ratio', { ratio: 0.25 }, 1), `rgba(56, 178, 172, ${TB_MAX_ALPHA})`);
});

test('histStats — 2022 제외가 평균을 바꾸고, 끄면 원래대로', () => {
  const st = defaultState(DOC22.meta); st.hist = 'max';
  const v = DOC22.series['은행채AAA_vs_국고채권']['3년'];
  assert.equal(st.ex2022, true, '기본은 2022 제외');
  const ex = histStats(v, DOC22.dates, st);
  assert.equal(ex.n, 10); near(ex.mean, 25); assert.equal(ex.max, 40);
  st.ex2022 = false;
  const all = histStats(v, DOC22.dates, st);
  assert.equal(all.n, 12); near(all.mean, 470 / 12); assert.equal(all.max, 120);
});

test('histLabelOf — 제외가 표본에 실제로 걸릴 때만 꼬리표', () => {
  const st = defaultState(DOC22.meta);
  st.hist = 'max'; assert.equal(histLabelOf(st, DOC22.dates), 'MAX(22제외)');
  st.hist = '5y'; assert.equal(histLabelOf(st, DOC22.dates), '5Y(22제외)');
  st.ex2022 = false; assert.equal(histLabelOf(st, DOC22.dates), '5Y');
  st.ex2022 = true; assert.equal(histLabelOf(st, ['2025-01-02', '2026-11-11']), '5Y', '이력에 2022년이 없으면 붙이지 않는다');
});

test('tableData·matrixHTML·yearTableHTML — 배율·bp 차·전주비·연도 평균이 데이터에서 온다', () => {
  const st = defaultState(DOC22.meta); st.hist = 'max'; st.a.sector = '은행채AAA';
  const data = tableData(DOC22, st);
  const c = data.cells['은행채AAA']['3년'];
  assert.equal(c.cur, 30); near(c.mean, 25); near(c.ratio, 1.2); near(c.gap, 5);
  assert.equal(c.wow, 10, '30 − 20 (5영업일 전)');
  near(data.gapScale, 5);

  const mx = matrixHTML(DOC22, st, data);
  assert.ok(mx.body.includes('<div class="r">1.20</div>'), mx.body);
  assert.ok(mx.body.includes('+5.0 ·'), mx.body);
  assert.ok(mx.body.includes('class="picked"') && mx.body.includes('data-pick="은행채AAA"'));
  assert.ok(mx.body.includes('background:rgba(217, 144, 42'), '1배 초과는 넓은 쪽 색');
  st.heat = 'off';
  assert.ok(!matrixHTML(DOC22, st, data).body.includes('background:'), '색 끄면 배경 없음');

  const yt = yearTableHTML(DOC22, st, '은행채AAA', data);
  assert.ok(yt.head.includes(`${EXCLUDE_YEAR}*`) && yt.head.includes('MAX(22제외) 평균'), yt.head);
  for (const y of ['2021', '2022', '2023', '2024']) assert.ok(yt.head.includes(`>${y}`), y);
  assert.ok(yt.body.includes('<td>15.0</td>'), '2021 평균');
  assert.ok(yt.body.includes('<td class="ex">110.0</td>'), '제외한 해도 숫자는 남긴다');
  assert.ok(yt.body.includes('<td>25.0</td>') && yt.body.includes('>1.20</td>') && yt.body.includes('<td>+10.0</td>'));
});

test('mergeState — 모드·색 기준·제외·표 섹터 검증', () => {
  const st = mergeState(defaultState(DOC.meta), { mode: 'table', heat: 'gap', ex2022: false, tbSector: '여전채AA-' }, DOC.meta);
  assert.deepEqual([st.mode, st.heat, st.ex2022, st.tbSector], ['table', 'gap', false, '여전채AA-']);
  const bad = mergeState(defaultState(DOC.meta), { mode: 'x', heat: 'y', ex2022: 1, tbSector: '없음' }, DOC.meta);
  assert.deepEqual([bad.mode, bad.heat, bad.ex2022, bad.tbSector], ['detail', 'ratio', true, '']);
  assert.deepEqual(MODES, ['detail', 'overview', 'table']);
  assert.ok(HEAT_KINDS.includes('off'));
});

test('실데이터 — 표 전체가 계산되고 배율은 양수', () => {
  const doc = JSON.parse(readFileSync(join(ROOT, 'data', 'cs1', 'spreads.json'), 'utf8'));
  const st = defaultState(doc.meta); st.hist = 'max';
  const data = tableData(doc, st);
  let n = 0;
  for (const sec of sectorList(doc.meta)) for (const t of doc.meta.tenors) {
    const c = data.cells[sec][t];
    assert.ok(c && c.ratio > 0 && c.n > 2000, `${sec} ${t}`);
    n++;
  }
  assert.equal(n, 176);
  assert.ok(data.gapScale > 0);
  st.ex2022 = false;
  const all = tableData(doc, st);
  assert.ok(all.cells['은행채AAA']['1년'].mean > data.cells['은행채AAA']['1년'].mean, '2022년을 넣으면 평균이 올라간다');
  const yt = yearTableHTML(doc, st, '은행채AAA', all);
  assert.equal((yt.body.match(/<tr data-sector/g) || []).length, doc.meta.tenors.length);
});

// ── 실데이터 스모크 ──────────────────────────────────────────────────────────

test('실데이터 — 사용 예(카드채AA+ 3년 − 여전채AA- 3년)가 끝까지 계산된다', () => {
  const doc = JSON.parse(readFileSync(join(ROOT, 'data', 'cs1', 'spreads.json'), 'utf8'));
  const st = defaultState(doc.meta);
  st.b = { sector: '여전채AA-', tenor: '3년' };
  const line = buildLine(doc, st);
  assert.equal(line.values.length, doc.dates.length);
  const end = lastValidIndex(line.values);
  assert.ok(end >= 0);
  // 차 = 두 다리의 차(소수 1자리)
  near(line.values[end], Math.round((line.legA[end] - line.legB[end]) * 10) / 10);

  for (const key of HIST_WINDOWS) {
    const from = startIndexFor(doc.dates, key, end);
    const s = windowStats(line.values, from, end);
    assert.ok(s.n > 200, `${key} 표본 ${s.n}`);
    assert.ok(s.min <= s.mean && s.mean <= s.max, key);
    assert.ok(s.pct >= 0 && s.pct <= 100, key);
  }
  // 기간이 길수록 표본이 줄지 않는다
  const ns = HIST_WINDOWS.map((k) => windowStats(line.values, startIndexFor(doc.dates, k, end), end).n);
  for (let i = 1; i < ns.length; i++) assert.ok(ns[i] >= ns[i - 1], ns.join(','));

  for (const n of MA_WINDOWS) {
    const ma = movingAverage(line.values, n);
    assert.ok(lastValidIndex(ma) >= 0, `MA${n}`);
  }
});

test('실데이터 — 모든 섹터×만기 다리가 선택 가능하다', () => {
  const doc = JSON.parse(readFileSync(join(ROOT, 'data', 'cs1', 'spreads.json'), 'utf8'));
  const sectors = sectorList(doc.meta);
  assert.ok(sectors.length >= 10);
  for (const s of sectors) for (const t of doc.meta.tenors) {
    assert.ok(legValues(doc, s, t), `${s} ${t}`);
  }
});

// ── 페이지 배선 ──────────────────────────────────────────────────────────────

test('cs2.html — 스크립트가 찾는 id 가 전부 마크업에 있다', () => {
  const html = readFileSync(join(ROOT, 'cs2.html'), 'utf8');
  const ui = readFileSync(join(ROOT, 'js', 'cs2', 'cs2-ui.js'), 'utf8');
  const ids = new Set([...ui.matchAll(/(?:\$\(|getElementById\(|Plotly\.(?:react|purge)\()'(cs2-[a-z-]+)'/g)].map((m) => m[1]));
  assert.ok(ids.size >= 15, `id ${ids.size}개 — 추출 규칙 확인`);
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `마크업에 #${id} 없음`);
  assert.ok(html.includes('vendor/plotly.min.js'));
});

test('nav — cs2 가 모듈 목록에 등록돼 있다', () => {
  const nav = readFileSync(join(ROOT, 'js', 'nav.js'), 'utf8');
  assert.ok(/id: 'cs2'[^\n]*file: 'cs2\.html'/.test(nav));
});

// ── 판단어 금지(cs1 과 같은 목록) ────────────────────────────────────────────

const BANNED = ['싸다', '비싸다', 'cheap', 'rich', '매력적', '저평가', '고평가', '매수', '매도'];

test('판단어 금지 — cs2 소스 어디에도 가치 판정어가 없다', () => {
  const files = readdirSync(join(ROOT, 'js', 'cs2')).filter((f) => f.endsWith('.js'))
    .map((f) => `js/cs2/${f}`).concat('cs2.html');
  assert.ok(files.length >= 3);
  const hits = [];
  for (const rel of files) {
    readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/).forEach((line, i) => {
      for (const w of BANNED) if (line.includes(w)) hits.push(`${rel}:${i + 1} "${w}"`);
    });
  }
  assert.deepEqual(hits, []);
});
