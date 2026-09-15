// 페이지 로직 스모크 — node --test. 브라우저 없이 inflation-diffusion.html의 인라인
// 모듈 스크립트를 실제 픽스처 + document/Plotly 스텁으로 실행해 런타임 오류·와이어링을 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── DOM/Plotly 스텁 ──
function makeEl(id) {
  return {
    id, _html: '', className: '', textContent: '', dataset: {}, style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); } },
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
    addEventListener() {}, querySelectorAll() { return []; },
  };
}

// 픽스처·페이지 스크립트는 import 대신 매 실행마다 fresh eval (ESM 모듈 캐시 회피).
function runFresh(code, ...args) {
  // eslint-disable-next-line no-new-func
  return new Function(...args.map((a) => a[0]), code)(...args.map((a) => a[1]));
}

function runPage(mode = 'fixture', hash = '') {
  globalThis.window = {};
  // 픽스처 로드 (window.FENRIR_FIXTURE 채움) — 파일 텍스트를 window 인자로 실행.
  const fixtureFiles = [
    'inflation-diffusion-us.fixture.js', 'inflation-diffusion-kr.fixture.js',
    'inflation-diffusion-eu.fixture.js', 'inflation-diffusion-au.fixture.js',
    'inflation-diffusion-jp.fixture.js', 'trimmed-us.fixture.js',
  ];
  for (const f of fixtureFiles) {
    runFresh(readFileSync(join(ROOT, 'tests', 'fixtures', f), 'utf8'), ['window', globalThis.window]);
  }
  // 'real' 모드: 실데이터가 있는 상황 시뮬레이션 — 픽스처 payload를 FENRIR_SERIES로 승격.
  if (mode === 'real') window.FENRIR_SERIES = { ...window.FENRIR_FIXTURE };

  const els = new Map();
  const plotly = { calls: [] };
  globalThis.document = {
    getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); },
  };
  globalThis.Plotly = { react(elId, traces) { plotly.calls.push({ elId, n: traces.length }); }, newPlot() {} };
  globalThis.location = { hash };
  globalThis.history = { replaceState() {} };

  // HTML에서 인라인 <script type="module"> 본문 추출 (src 있는 nav 태그 제외).
  const html = readFileSync(join(ROOT, 'inflation-diffusion.html'), 'utf8');
  const blocks = [...html.matchAll(/<script type="module"(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length >= 1, '인라인 모듈 스크립트 미발견');
  const code = blocks[blocks.length - 1][1];
  // 페이지 로직은 import/export가 없어 일반 함수로 fresh 실행 (globals: window/document/Plotly).
  runFresh(code);
  return { els, plotly };
}

test('페이지 로직: 픽스처로 오류 없이 렌더 + 배지·판정표·차트·상세 채움', async () => {
  const { els, plotly } = await runPage();

  // 배지: 픽스처 사용이므로 show
  assert.ok(els.get('sample-badge').classList.contains('show'), '샘플 배지 표시 안됨');

  // 국가 탭 5개 (US·KR·EU·AU·JP)
  const tabs = els.get('country-tabs').innerHTML;
  assert.equal((tabs.match(/<button/g) || []).length, 5, '국가 탭 5개가 아님');
  for (const lbl of ['미국', '한국', '유럽', '호주', '일본']) assert.ok(tabs.includes(lbl), `탭 누락: ${lbl}`);

  // 한 줄 결론: 채워지고 % 포함, 신호등 클래스 배정
  const line = els.get('v-line').innerHTML;
  assert.match(line, /뚜렷이 오르는 중/);
  assert.match(line, /%/);
  assert.match(els.get('v-light').className, /light (red|yellow|green)/);

  // 판정표: 4셀, 정확히 1개 active(on)
  const matrix = els.get('matrix').innerHTML;
  const cellCount = (matrix.match(/class="cell/g) || []).length;
  assert.equal(cellCount, 4, '판정표 셀이 4개가 아님');
  const onCount = (matrix.match(/class="cell on /g) || []).length;
  assert.equal(onCount, 1, '활성 셀이 정확히 1개가 아님');
  // 4개 라벨 존재
  for (const lbl of ['진짜 뜨겁다', '겉만 뜨겁다', '속은 아직 뜨겁다', '진짜 식었다']) {
    assert.ok(matrix.includes(lbl), `라벨 누락: ${lbl}`);
  }

  // 차트: breadth react 1회 + spark 3회
  assert.ok(plotly.calls.some((c) => c.elId === 'chart-breadth'), 'breadth 차트 미호출');
  const sparks = plotly.calls.filter((c) => String(c.elId).startsWith('spark-')).length;
  assert.equal(sparks, 3, 'trimmed 스파크라인 3개가 아님');

  // trimmed 카드 3개
  assert.equal((els.get('trim-grid').innerHTML.match(/trim-card/g) || []).length, 3);

  // 상세: 상승/하락 목록 채움
  assert.match(els.get('up-list').innerHTML, /mrow/);
  assert.match(els.get('down-list').innerHTML, /mrow/);

  // 메타 푸터 + [샘플] 표기
  assert.match(els.get('meta-foot').textContent, /US-CPI .*품목/);
  assert.match(els.get('meta-foot').textContent, /\[샘플\]/);
});

// 크래프트 데이터를 FENRIR_SERIES에 주입해 페이지 실행(픽스처 미로드) → 문구 분기 직접 구동.
function runWithData(seriesByKey, hash = '') {
  globalThis.window = { FENRIR_SERIES: seriesByKey };
  const els = new Map();
  globalThis.document = { getElementById(id) { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); } };
  globalThis.Plotly = { react() {}, newPlot() {} };
  globalThis.location = { hash };
  globalThis.history = { replaceState() {} };
  const html = readFileSync(join(ROOT, 'inflation-diffusion.html'), 'utf8');
  const code = [...html.matchAll(/<script type="module"(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  runFresh(code);
  return els;
}

// ge2 시계열 → US-CPI payload (11개월 A + 최신 B → diff=11(B-A)/12로 분기 제어).
function usPayloadFromGe2(vals) {
  const series = vals.map((v, i) => ({
    period: `2025-${String(i + 1).padStart(2, '0')}`, headline_yoy: 3, core_yoy: 2.5, core_yoy_intl: null,
    weighted: { ge0: 92, ge2: v, ge25: v * 0.8, ge3: v * 0.6 },
    unweighted: { ge0: 92, ge2: v, ge25: v * 0.8, ge3: v * 0.6 },
    z: { ge0: 0, ge2: 0, ge25: 0, ge3: 0 },
  }));
  return { meta: { country: 'US-CPI', item_count: 1, weight_coverage: 1, last_updated: series.at(-1).period,
      window: { start: '2025-01', end: series.at(-1).period }, source: 'bls', port_ref: 'test' },
    series, detail: [{ period: series.at(-1).period, items: [{ code: 'A', name: 'A', weight: 1, yoy: 3 }] }] };
}

test('한 줄 결론 3분기 문구 (넓게/좁게/비슷 — 조사 정확)', () => {
  const a = 50;
  const cases = [
    { b: 62, re: /평소\([\d.]+%\)보다 <b[^>]*>넓게 퍼져 있음<\/b>/, label: '넓게' },   // diff≈+11 → red
    { b: 38, re: /평소\([\d.]+%\)보다 <b[^>]*>좁게 퍼져 있음<\/b>/, label: '좁게' },   // diff≈-11 → green
    { b: 51, re: /평소\([\d.]+%\)와 <b[^>]*>비슷한 수준<\/b>/, label: '비슷' },        // diff≈+0.9 → yellow
  ];
  for (const c of cases) {
    const vals = [a, a, a, a, a, a, a, a, a, a, a, c.b]; // 11×A + B
    const els = runWithData({ 'inflation-diffusion-us-cpi': usPayloadFromGe2(vals) });
    const line = els.get('v-line').innerHTML;
    assert.match(line, c.re, `${c.label}: 기대 문구 불일치 — ${line}`);
    assert.doesNotMatch(line, /보다\s*<b[^>]*>비슷/, `${c.label}: '보다 비슷' 비문`);
    assert.doesNotMatch(line, /와\s*<b[^>]*>(넓게|좁게)/, `${c.label}: '와 넓게/좁게' 비문`);
  }
});

test('5탭 한 줄 결론 문구: 조사 분기 정확, 비문 없음', async () => {
  const cases = [['US', '미국'], ['KR', '한국'], ['EU', '유럽'], ['AU', '호주'], ['JP', '일본']];
  for (const [id, name] of cases) {
    const { els } = await runPage('fixture', '#' + id);
    const line = els.get('v-line').innerHTML;
    assert.ok(line.includes(`지금 ${name} 물가는`), `${id}: 국가명 문구 없음 — ${line}`);
    // 세 유효 패턴 중 정확히 하나
    const valid = [/평소\([\d.]+%\)보다 <b[^>]*>넓게 퍼져 있음<\/b>/,
                   /평소\([\d.]+%\)보다 <b[^>]*>좁게 퍼져 있음<\/b>/,
                   /평소\([\d.]+%\)와 <b[^>]*>비슷한 수준<\/b>/];
    const hits = valid.filter((re) => re.test(line)).length;
    assert.equal(hits, 1, `${id}: 유효 문구 패턴 정확히 1개 아님 (${hits}) — ${line}`);
    // 비문 방지: "보다 비슷", "보다 좁아져" 등이 없어야
    assert.doesNotMatch(line, /보다\s*<b[^>]*>비슷/, `${id}: '보다 비슷' 비문 — ${line}`);
    assert.doesNotMatch(line, /보다\s*<b[^>]*>좁아져/, `${id}: '보다 좁아져' 구문 — ${line}`);
  }
});

test('실데이터 비-US 탭(trimmed 없음)도 배지 숨김 — toggle(force=undefined) 회귀', async () => {
  for (const id of ['KR', 'EU', 'JP', 'AU']) {
    const { els } = await runPage('real', '#' + id);
    assert.ok(!els.get('sample-badge').classList.contains('show'), `${id}: 실데이터인데 샘플 배지 표시`);
  }
});

test('임계값 토글: 확장 키 있는 US → 4버튼 활성·기본 2%·판정 안내 없음, 타국 탭은 숨김', async () => {
  const { els } = await runPage('real', '#US');
  const bar = els.get('thr-bar').innerHTML;
  assert.equal((bar.match(/<button/g) || []).length, 4);
  assert.doesNotMatch(bar, /disabled/);
  assert.match(bar, /data-thr="ge2" class="active"/);
  assert.equal(els.get('thr-note').textContent, '');
  assert.match(els.get('thr-label').textContent, /기준 2% 이상/);
  const kr = (await runPage('real', '#KR')).els;
  assert.equal(kr.get('thr-bar').innerHTML, '');
  assert.equal(kr.get('thr-label').textContent, '');
});

test('임계값 토글: 확장 키 없는 기존 US 파일 → 버튼 비활성 + 안내, 판정 문구 정상', () => {
  const vals = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 62];
  const els = runWithData({ 'inflation-diffusion-us-cpi': usPayloadFromGe2(vals) });
  const bar = els.get('thr-bar').innerHTML;
  assert.equal((bar.match(/<button[^>]* disabled/g) || []).length, 4);
  assert.match(bar, /2% 기준만 있음/);
  assert.match(els.get('v-line').innerHTML, /넓게 퍼져 있음/);
});

test('실데이터 존재 시: 배지 자동 숨김 + [샘플] 표기 없음', async () => {
  const { els } = await runPage('real');
  const badge = els.get('sample-badge'); // 실데이터면 페이지가 배지를 건드리지 않음(부재=숨김)
  assert.ok(!badge || !badge.classList.contains('show'), '실데이터인데 샘플 배지가 표시됨');
  assert.doesNotMatch(els.get('meta-foot').textContent, /\[샘플\]/);
  // 렌더 자체는 정상
  assert.match(els.get('v-line').innerHTML, /뚜렷이 오르는 중/);
});
