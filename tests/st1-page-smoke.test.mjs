// ST-1 페이지 로직 스모크 — node --test.
//
// 왜 필요한가: Phase 2 에서 바뀐 것의 절반이 **DOM 경로**다(섹터 select 의 활성/비활성,
// 계보 토글의 동적 재생성, 차트 패널 그룹, 원장의 섹터 열). 순수 함수 테스트는 이 배선을
// 한 줄도 건드리지 않아서, 여기서 깨지면 화면만 조용히 죽는다.
//
// 브라우저 없이 document/localStorage/fetch 스텁으로 `initSt1()` 을 실제로 돌린다.
// 스텁 패턴은 `tests/diffusion-page-smoke.test.mjs` 를 따른다(원본 무수정).
//
// 범위: 배선과 런타임 오류만 본다. 값의 정합성은 st1-ui/st1-curve 단위 테스트 소관이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

/** select 로 만들어야 하는 id — st1-ui.js 가 tagName 으로 이벤트 종류를 가른다. */
const SELECT_IDS = new Set([
  'st1-f-sector', 'st1-fl-kind', 'st1-fl-sector', 'st1-fl-grade', 'st1-cv-weeks', 'st1-cv-half',
]);

function makeEl(id) {
  return {
    id,
    tagName: SELECT_IDS.has(id) ? 'SELECT' : 'INPUT',
    value: '', disabled: false, title: '', textContent: '', hidden: false,
    className: '', dataset: {}, style: {},
    _html: '',
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    _on: {},
    addEventListener(t, f) { (this._on[t] ||= []).push(f); },
    fire(t, ev = {}) { for (const f of this._on[t] || []) f(ev); },
    querySelectorAll() { return []; },
    focus() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0, bottom: 0 }; },
  };
}

function installDom() {
  const els = new Map();
  const get = (id) => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  globalThis.document = {
    getElementById: get,
    documentElement: { dataset: {} },
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), click() {} }),
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
  };
  // 확정분은 없는 셈 친다 — 404 는 ST-1 에서 정상 경로다.
  globalThis.fetch = async () => ({ ok: false });
  globalThis.confirm = () => false;
  globalThis.Blob = class { constructor() {} };
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  return { get, store };
}

const BOND_LINE = 'KB국민카드 AA+ 카드채 27/6 3.62%';

test('페이지 스모크 — 채권 입력부터 차트·원장까지 배선이 살아 있다', async () => {
  const { get } = installDom();
  const { initSt1 } = await import('../js/st1-ui.js');

  await initSt1();

  // ── 초기 상태 ──────────────────────────────────────────────────────────
  const sector = get('st1-f-sector');
  assert.ok(sector.disabled, '종류가 비었는데 섹터 칸이 열려 있다');
  assert.ok(sector.innerHTML.includes('여전채'), '섹터 선택지가 안 채워졌다');
  assert.ok(get('st1-fl-sector').innerHTML.includes('섹터 전체'), '섹터 필터가 안 채워졌다');
  assert.ok(get('st1-f-kind-list').innerHTML.includes('채권'), '종류 datalist 에 채권이 없다');
  assert.ok(get('st1-f-grade-list').innerHTML.includes('AA0'), '등급 datalist 에 장기 등급이 없다');

  // ── 채권 한 줄 타이핑 ──────────────────────────────────────────────────
  const line = get('st1-line');
  line.value = BOND_LINE;
  line.fire('input');

  assert.equal(get('st1-f-kind').value, '채권');
  assert.equal(sector.value, '여전채', '파서가 읽은 섹터가 칸에 안 내려왔다');
  assert.equal(sector.disabled, false, '채권인데 섹터 칸이 잠겨 있다');
  assert.equal(get('st1-f-grade').value, 'AA+');

  // ── 기록 ───────────────────────────────────────────────────────────────
  get('st1-record').fire('click');
  assert.match(get('st1-notice').textContent, /기록 1건/, get('st1-notice').textContent);

  // 원장 — 섹터 열이 실제로 그려진다(필터만 있고 열이 없으면 무엇을 거르는지 안 보인다).
  const tbody = get('st1-tbody').innerHTML;
  assert.ok(tbody.includes('여전채'), '원장에 섹터가 안 보인다');
  assert.ok(tbody.includes('KB국민카드'));

  // 차트 — 채권은 별도 패널 그룹, 제목은 계보 키 그대로.
  const charts = get('st1-charts').innerHTML;
  assert.ok(charts.includes('chart-group'), '패널 그룹이 안 생겼다');
  assert.ok(charts.includes('채권-여전채-AA+'), '채권 계보 패널이 없다');
  assert.ok(charts.includes('<div class="cg-label">채권</div>'), '채권 그룹 라벨이 없다');
  assert.ok(!charts.includes('<div class="cg-label">단기물</div>'),
    '점이 0개인 단기물 그룹까지 그려졌다');

  // 계보 토글 — 채권 계보는 기록이 생겨야 나타난다(init 때 한 번 짓고 말면 영영 안 생긴다).
  assert.ok(get('st1-cv-series').innerHTML.includes('data-series="채권-여전채-AA+"'),
    '채권 계보 토글이 안 생겼다');

  // ── 종류를 되돌리면 섹터를 버린다 ──────────────────────────────────────
  const kind = get('st1-f-kind');
  kind.value = 'CP';
  kind.fire('input');
  assert.ok(sector.disabled, 'CP 인데 섹터 칸이 열려 있다');
  assert.equal(sector.value, '', '종류를 되돌렸는데 섹터가 남았다');
});
