// CRV-1 화면 조립 테스트 — node --test (인자 없이 자동탐색).
//
// DOM 을 건드리는 initCrv1() 은 다루지 않는다(모듈 최상위에 DOM 접근이 없어 import 가능).
// 여기서 고정하는 것은 **표시 규약**이다 — 값이 없는 이유가 화면에서 사라지지 않는가,
// 정렬이 값과 일치하는가, 토글이 실제로 재계산을 태우는가, 표본이 모자란 사실이 드러나는가.
// 계산 자체는 tests/crv1-calc.test.mjs 가 고정한다. 이 파일은 산식을 다시 검증하지 않는다.
//
// [노드 비의존] 합성 커브는 노드 키로 짓고 행 수도 TRIPLES/PAIRS 에서 끌어온다.
//   노드 목록이 바뀌어도 이 파일이 통째로 깨지지 않게 하려는 것이다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NODES, PAIRS, TRIPLES, WINDOW } from '../js/crv1/crv1-calc.js';
import {
  DEFAULT_BASIS, NEUTRAL_BASES,
  barHTML, buildView, flagLabel, pairLabel, renderTables, slopeRowHTML, sortSlopes,
  tripleLabel, weightRowHTML, windowLabel,
} from '../js/crv1/crv1-ui.js';

const GRID = [...NODES];
const row = (d, v) => [d, ...v];
const vals = (m) => NODES.map((n) => (n in m ? m[n] : null));
const byKey = (arr, k) => arr.find((it) => it.key === k);
/** 한 행(tr) HTML 안의 <td> 내용만 순서대로 뽑는다. */
const tds = (html) => [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);

// 2026-08-25 실제 커브.
const REAL = {
  0.5: 3.086, 1: 3.418, 1.5: 3.551, 2: 3.690, 2.5: 3.727, 3: 3.826,
  5: 4.033, 10: 4.318, 20: 4.575, 30: 4.629, 50: 4.589,
};
const REALV = vals(REAL);
const realView = (basis) => buildView({ grid: GRID, rows: [row('2026-08-25', REALV)] }, basis);

// ── 1. tight → "—" 렌더 + neutral 은 유지 ────────────────────────────────────
test('tight 행 — 비중·갭·레인지바는 "—", 중립은 표시 유지', () => {
  const view = buildView({
    grid: GRID,
    rows: [row('2026-08-25', vals({
      0.5: 3.00, 1: 3.005, 1.5: 3.01, 2: 3.02, 2.5: 3.03, 3: 3.04,
      5: 3.10, 10: 3.20, 20: 3.30, 30: 3.40, 50: 3.50,
    }))],
  });
  const it = byKey(view.weights, '1.5-2-2.5'); // 3.03 − 3.01 = 2bp
  assert.equal(it.flag, 'tight');

  const cells = tds(weightRowHTML(it));
  assert.equal(cells.length, 5, '비중·중립·갭·위치·사유 5칸');
  assert.match(cells[0], /class="nil">—</, '비중 —');
  assert.match(cells[2], /class="nil">—</, '갭 —');
  assert.match(cells[3], /class="nil">—</, '레인지바 자리 —');
  assert.doesNotMatch(cells[3], /<div class="rb"/, 'tight 행엔 막대를 그리지 않는다');

  // 중립은 금리를 쓰지 않으므로 살아 있어야 한다 — 참조용
  assert.doesNotMatch(cells[1], /—/, '중립은 — 가 아니어야 한다');
  assert.match(cells[1], new RegExp(String(it.neutral).replace('.', '\\.')));
  assert.match(cells[4], /역전\/압축/, '사유 라벨');
});

test('단기 tight — 0.5~1.5 가 3bp 여도 인근 단기 행은 정상 렌더된다', () => {
  const view = buildView({
    grid: GRID,
    rows: [row('2026-08-25', vals({
      0.5: 3.000, 1: 3.015, 1.5: 3.030, 2: 3.200, 2.5: 3.400, 3: 3.600,
      5: 3.800, 10: 4.000, 20: 4.200, 30: 4.400, 50: 4.600,
    }))],
  });
  const html = renderTables(view).weights;
  assert.equal((html.match(/역전\/압축/g) || []).length, 1, 'tight 라벨은 한 행뿐');

  const dead = tds(weightRowHTML(byKey(view.weights, '0.5-1-1.5')));
  assert.match(dead[0], /class="nil">—</);
  assert.doesNotMatch(dead[1], /—/, '중립은 남는다');

  for (const k of ['1-1.5-2', '1.5-2-2.5', '2-2.5-3']) {
    const c = tds(weightRowHTML(byKey(view.weights, k)));
    assert.doesNotMatch(c[0], /class="nil"/, `${k} 비중`);
    assert.match(c[3], /<div class="rb"/, `${k} 레인지바`);
    assert.equal(c[4], '', `${k} 사유 라벨 없음`);
  }
});

test('flag 라벨 어휘가 flag 별로 고정', () => {
  assert.equal(flagLabel('tight'), '역전/압축');
  assert.equal(flagLabel('missing'), '결측');
  assert.equal(flagLabel('degenerate'), '퇴화');
  assert.equal(flagLabel(null), '');
});

test('missing 행 — 50Y 결측이면 결측 라벨, 나머지 8행은 정상 렌더', () => {
  const view = buildView({ grid: GRID, rows: [row('2016-05-02', vals({ ...REAL, 50: null }))] });
  const dead = tds(weightRowHTML(byKey(view.weights, '20-30-50')));
  assert.match(dead[4], /결측/);
  assert.match(dead[0], /class="nil">—</);
  // 중립도 비어야 한다 — tight 와 달리 입력 자체가 없으면 듀레이션이 정의되지 않는다.
  // (자리표시 래퍼 없이 곧바로 — 로 찍힌다. 화면에 보이는 글자는 tight 행과 같다.)
  assert.equal(dead[1], '—', '중립도 결측(입력이 없으면 듀레이션도 없다)');

  const alive = view.weights.filter((w) => w.key !== '20-30-50');
  assert.equal(alive.length, TRIPLES.length - 1);
  for (const it of alive) {
    const c = tds(weightRowHTML(it));
    assert.doesNotMatch(c[0], /class="nil"/, `${it.key} 비중`);
    assert.match(c[3], /<div class="rb"/, `${it.key} 레인지바`);
    assert.equal(c[4], '', `${it.key} 사유 라벨 없음`);
  }
});

// ── 2. 내림차순 정렬 (음수 포함, null 최하단) ────────────────────────────────
test('기울기 정렬 — 값 내림차순, 음수 포함, null 최하단', () => {
  const mk = (key, slope) => ({ key, s: 1, l: 2, slope, flag: slope == null ? 'missing' : null, range: {} });
  const src = [mk('a', 5.18), mk('b', null), mk('c', 29.06), mk('d', -1.17), mk('e', 0), mk('f', null), mk('g', 12.33)];
  const out = sortSlopes(src);
  assert.deepEqual(out.map((x) => x.key), ['c', 'g', 'a', 'e', 'd', 'b', 'f']);
  assert.deepEqual(out.slice(0, 5).map((x) => x.slope), [29.06, 12.33, 5.18, 0, -1.17]);
  assert.equal(out[5].slope, null);
  assert.equal(out[6].slope, null);
});

test('기울기 정렬 — 원본 배열을 변형하지 않고, null 끼리는 원래 순서 유지', () => {
  const mk = (key, slope) => ({ key, slope });
  const src = [mk('x', null), mk('y', 3), mk('z', null)];
  const before = src.map((x) => x.key);
  const out = sortSlopes(src);
  assert.deepEqual(src.map((x) => x.key), before, '원본 불변');
  assert.deepEqual(out.map((x) => x.key), ['y', 'x', 'z'], 'null 끼리는 안정');
});

test('실데이터 형상 — 기울기는 내림차순, 상단 표는 만기 오름차순 고정', () => {
  const view = realView();
  const v = view.slopes.map((x) => x.slope).filter((s) => s != null);
  for (let i = 1; i < v.length; i++) assert.ok(v[i - 1] >= v[i], `${v[i - 1]} < ${v[i]}`);
  assert.deepEqual(view.weights.map((w) => w.key),
    TRIPLES.map(([s, m, l]) => `${s}-${m}-${l}`), '상단은 정렬하지 않는다');
});

test('정렬 — 단기가 장기와 섞여도 값 순서만 따른다 (구간 길이로 묶지 않는다)', () => {
  const view = realView();
  const keys = view.slopes.map((x) => x.key);
  // 실커브에서 2-2.5(8.13)는 3-5(12.33)보다 아래로 내려간다 — 단기라고 위에 붙지 않는다.
  assert.ok(keys.indexOf('3-5') < keys.indexOf('2-2.5'),
    `단기 2-2.5 가 값과 무관하게 앞에 옴: ${keys.join(' > ')}`);
  assert.equal(keys[keys.length - 1], '30-50', '유일한 음수가 최하단');
});

// ── 3. 토글 전환 시 neutral·gap 재계산 반영 ─────────────────────────────────
test('중립 기준 토글 — duration ↔ time 에서 neutral·gap 이 바뀌고 비중은 그대로', () => {
  const d = realView('duration');
  const t = realView('time');

  const dw = byKey(d.weights, '3-5-10');
  const tw = byKey(t.weights, '3-5-10');
  assert.equal(dw.ratio, tw.ratio, '비중은 금리만 쓰므로 기준과 무관');
  assert.notEqual(dw.neutral, tw.neutral, '중립이 바뀌어야 한다');
  assert.notEqual(dw.gap, tw.gap, '갭이 따라 바뀌어야 한다');
  assert.equal(t.neutral, 'time');
  assert.equal(d.neutral, 'duration');

  // 시간 중립 3/5/10 = (5−3)/(10−3) = 28.57%, 듀레이션 중립은 그보다 크다(볼록 구간)
  assert.ok(Math.abs(tw.neutral - 28.57) < 0.01, `time neutral=${tw.neutral}`);
  assert.ok(dw.neutral > tw.neutral);
});

test('중립 기준 토글 — 렌더된 HTML 에도 바뀐 값이 실린다', () => {
  const hd = renderTables(realView('duration')).weights;
  const ht = renderTables(realView('time')).weights;
  assert.notEqual(hd, ht, '토글이 표를 실제로 다시 그린다');
  assert.match(ht, /28\.57/, '시간 중립 3/5/10 값이 표에 있다');
  assert.doesNotMatch(hd, /28\.57/);

  // 250일 창 통계도 기준에 따라 다시 계산된다(갭 창이므로).
  const rows = Array.from({ length: 30 }, (_, i) =>
    row(`d${i}`, REALV.map((v, j) => v + i * 0.002 * (j + 1))));
  const rd = byKey(buildView({ grid: GRID, rows }, 'duration').weights, '5-10-20').range;
  const rt = byKey(buildView({ grid: GRID, rows }, 'time').weights, '5-10-20').range;
  assert.notDeepEqual(rd, rt, '창 min/max 도 기준을 따라간다');
});

test('중립 기준 토글 — 0.5 가 낀 단기 조합도 기준을 따라 바뀐다', () => {
  const dw = byKey(realView('duration').weights, '0.5-1-1.5');
  const tw = byKey(realView('time').weights, '0.5-1-1.5');
  assert.ok(Math.abs(tw.neutral - 50) < 0.01, `등간격이라 시간 중립은 50 (${tw.neutral})`);
  assert.notEqual(dw.neutral, tw.neutral);
  assert.notEqual(dw.gap, tw.gap);
});

test('중립 기준 — 기본은 듀레이션, 토글 어휘는 2종 고정', () => {
  assert.equal(DEFAULT_BASIS, 'duration');
  assert.deepEqual(NEUTRAL_BASES.map((b) => b.key), ['duration', 'time']);
  assert.deepEqual(NEUTRAL_BASES.map((b) => b.label), ['듀레이션', '시간']);
});

// ── 4. 250행 미만이면 window 가 화면에 표기 ─────────────────────────────────
test('250행 미만 — windowLabel 에 실제 행수(n=226)가 찍히고 부족 사실을 밝힌다', () => {
  const rows = Array.from({ length: 226 }, (_, i) => row(`d${i}`, REALV.map((v) => v + i * 0.001)));
  const view = buildView({ grid: GRID, rows });
  assert.equal(view.window, 226);
  const label = windowLabel(view);
  assert.match(label, /n=226/);
  assert.match(label, /250 미만/, '표본이 모자란 사실을 감추지 않는다');
  assert.match(label, /226행/);
});

test('250행 이상 — windowLabel 은 n=250 만 찍고 군더더기를 붙이지 않는다', () => {
  const rows = Array.from({ length: 400 }, (_, i) => row(`d${i}`, REALV.map((v) => v + i * 0.001)));
  const view = buildView({ grid: GRID, rows });
  assert.equal(view.window, WINDOW);
  assert.equal(windowLabel(view), '창 n=250');
  assert.doesNotMatch(windowLabel(view), /미만/);
});

test('행별 표본수도 레인지바에 함께 찍힌다 (창 안 결측 노출)', () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    row(`d${i}`, vals({ ...REAL, 50: i < 4 ? null : 4.95 + i * 0.01 })));
  const html = renderTables(buildView({ grid: GRID, rows })).weights;
  assert.match(html, /n=8/, '20/30/50 은 앞 4일 결측이라 표본 8');
  assert.match(html, /n=12/, '결측 없는 조합은 표본 12');
});

// ── 레인지바 ────────────────────────────────────────────────────────────────
test('레인지바 — 끝값 숫자·마커 위치·표본수가 모두 실린다', () => {
  const html = barHTML({ min: -15.81, max: 43.57, pos: 0.529, n: 250 }, '%p');
  assert.match(html, /<span class="e">-15\.8<\/span>/, 'min 끝값');
  assert.match(html, /<span class="e">43\.6<\/span>/, 'max 끝값');
  assert.match(html, /left:52\.9%/, '마커 위치는 calc 의 pos 를 그대로 쓴다');
  assert.match(html, /n=250/);
});

test('레인지바 — pos 가 끝점이면 0%·100%', () => {
  assert.match(barHTML({ min: 0, max: 8, pos: 1, n: 250 }, 'bp/dur'), /left:100\.0%/);
  assert.match(barHTML({ min: 0, max: 8, pos: 0, n: 250 }, 'bp/dur'), /left:0\.0%/);
});

test('레인지바 — pos 없으면 마커 없는 흐린 트랙, 범위 자체가 없으면 —', () => {
  const noPos = barHTML({ min: 5, max: 5, pos: null, n: 3 }, '%p');
  assert.match(noPos, /class="bar empty"/);
  assert.doesNotMatch(noPos, /left:/, '마커를 억지로 찍지 않는다');
  assert.match(noPos, /<span class="e">5\.0<\/span>/, '범위는 남긴다');

  const none = barHTML({ min: null, max: null, pos: null, n: 0 }, '%p');
  assert.match(none, /class="rb none"/);
  assert.doesNotMatch(none, /<div class="bar/);
});

// ── 표기·구조 ───────────────────────────────────────────────────────────────
test('행 라벨 — 3점은 "/" 로 묶고 2점 구간은 "–" 로 잇는다 (0.5 도 그대로)', () => {
  assert.equal(tripleLabel({ s: 3, m: 5, l: 10 }), '3/5/10Y');
  assert.equal(tripleLabel({ s: 0.5, m: 1, l: 1.5 }), '0.5/1/1.5Y');
  assert.equal(pairLabel({ s: 30, l: 50 }), '30–50Y');
  assert.equal(pairLabel({ s: 0.5, l: 1 }), '0.5–1Y');
});

test('갭·기울기는 부호를 명시한다 (+/−)', () => {
  const view = realView();
  const pos = tds(weightRowHTML(byKey(view.weights, '0.5-1-1.5')));
  assert.match(pos[2], /^\+\d/, '양수 갭엔 + 를 붙인다');
  const neg = tds(slopeRowHTML(byKey(view.slopes, '30-50')));
  assert.match(neg[0], /^-\d/, '음수 기울기는 - 로 읽힌다');
});

test('renderTables — 상단 9행·하단 10행, 판단 어휘·화살표가 섞이지 않는다', () => {
  const t = renderTables(realView());
  assert.equal((t.weights.match(/<tr/g) || []).length, 9);
  assert.equal((t.slopes.match(/<tr/g) || []).length, 10);
  assert.equal((t.weights.match(/<tr/g) || []).length, TRIPLES.length);
  assert.equal((t.slopes.match(/<tr/g) || []).length, PAIRS.length);
  for (const bad of ['싸', '비싸', '매수', '매도', '↑', '↓', '→', '주목', '추천']) {
    assert.ok(!t.weights.includes(bad) && !t.slopes.includes(bad), `판단 어휘 '${bad}' 노출`);
  }
});

test('HTML 이스케이프 — flag 사유 툴팁에 원문이 그대로 새지 않는다', () => {
  const html = weightRowHTML({
    key: 'x', s: 1, m: 2, l: 3, ratio: null, neutral: 50, gap: null, flag: 'tight',
    range: { min: null, max: null, pos: null, n: 0 },
  });
  assert.doesNotMatch(html, /title="[^"]*"[^"]*"/, '따옴표가 속성을 깨지 않는다');
});

// ── 페이지 배선 ─────────────────────────────────────────────────────────────
test('crv1.html — UI 가 쓰는 DOM id 가 전부 존재하고 데이터·모듈이 연결돼 있다', (t) => {
  const p = fileURLToPath(new URL('../crv1.html', import.meta.url));
  if (!existsSync(p)) return t.skip('crv1.html 없음');
  const html = readFileSync(p, 'utf8');
  for (const id of ['crv1-status', 'crv1-app', 'crv1-wbody', 'crv1-sbody',
    'crv1-asof', 'crv1-window', 'crv1-basis', 'crv1-neutral-col']) {
    assert.ok(html.includes(`id="${id}"`), `#${id} 누락`);
  }
  assert.match(html, /<script src="data\/ktb-curve\.js"><\/script>/, 'classic script 로 커브 로드');
  assert.match(html, /js\/crv1\/crv1-ui\.js/, 'UI 모듈 연결');
  assert.match(html, /js\/nav\.js/, '공통 내비 연결');
  assert.match(html, /data-basis="duration"[\s\S]*data-basis="time"/, '토글 2종');
  assert.match(html, /액면채 가정 수정듀레이션 \(반기복리\)\. 초장기 구간은 이표-금리 괴리 시 오차 가능\./);
});

// nav.js 는 import 시 renderNav() 부작용이 document 를 요구한다 → hub-smoke.test.mjs 와 같은
// 최소 셰임을 깔고 로드한다(테스트 파일마다 별도 프로세스라 전역 오염이 번지지 않는다).
async function loadNavItems() {
  const el = () => ({ innerHTML: '', appendChild() {}, setAttribute() {}, style: {}, textContent: '' });
  globalThis.window = globalThis;
  globalThis.document = {
    readyState: 'complete', getElementById: () => el(), createElement: () => el(),
    head: { appendChild() {} }, body: { insertBefore() {}, firstChild: null }, addEventListener() {},
  };
  globalThis.location = { pathname: '/crv1.html' };
  return (await import('../js/nav.js')).NAV_ITEMS;
}

test('js/nav.js — CRV-1 이 NAV_ITEMS 에 1행 등록돼 있다', async () => {
  const NAV_ITEMS = await loadNavItems();
  const item = NAV_ITEMS.find((i) => i.file === 'crv1.html');
  assert.ok(item, 'crv1.html 항목 없음');
  assert.equal(item.id, 'crv1');
  assert.ok(item.title && item.desc, 'title·desc 필요');
  assert.equal(NAV_ITEMS.filter((i) => i.file === 'crv1.html').length, 1, '중복 등록 금지');
});
