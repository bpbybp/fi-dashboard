// CRV-1 이력(Phase 4) 테스트 — node --test (인자 없이 자동탐색).
//
// 고정하려는 불변식은 넷이다.
//   1) 이력은 crv1-calc 의 단일 일자 산출과 **날짜별로 같다**. history() 가 weightsAt() 을
//      그대로 부르므로 지금은 설계상 참이다 — 이 테스트는 나중에 누가 history 안에 보정·
//      평활·보간을 끼워 넣는 것을 막는 회귀 감시다(표와 차트가 같은 날 다른 숫자를 내면
//      화면에서 어느 쪽이 맞는지 판별할 방법이 없다).
//   2) 값이 없는 날은 통계에서 빠지고, **빠진 이유가 압축·결측으로 나뉘어 센다.**
//      합쳐서 '제외 N일' 로만 내면 5bp 압축(시장 상태)과 미관측(데이터 부재)이 뭉개진다.
//   3) 창을 바꾸면 평균이 실제로 달라진다 — 슬라이스가 되지 않고 전 구간이 새면 못 잡는다.
//   4) 중립 기준 토글은 neutral·gap 만 바꾸고 ratio 는 건드리지 않는다. ratio 는 금리만
//      쓰는 값이라 중립 선택과 무관해야 한다.
//
// [노드 비의존] 합성 커브를 NODES 순서 배열로 하드코딩하지 않고 노드 키로 짓는다
//   (crv1-calc.test.mjs·crv1-ui.test.mjs 와 같은 방식). 노드 목록이 바뀌어도 통째로 깨지지 않는다.
//
// 실데이터(data/ktb-curve.js)는 구조 스모크에만 쓴다. 값 앵커를 걸면 커브 갱신마다 깨진다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  NODES, TRIPLES, nodeColumns, pickNodes, nodeDurations, weightsAt,
} from '../js/crv1/crv1-calc.js';
import {
  WINDOWS, WINDOW_LABEL, DEFAULT_WINDOW, history, stats, slice, windowRows,
} from '../js/crv1/crv1-history.js';

const GRID = [...NODES];
const DAY = 86400000;
const date = (i) => new Date(Date.UTC(2020, 0, 1) + i * DAY).toISOString().slice(0, 10);
const row = (i, y) => [date(i), ...NODES.map((n) => (n in y ? y[n] : null))];
const byKey = (arr, k) => arr.find((it) => it.key === k);

/** 단조 상승 직선 커브. 어느 3점을 잡아도 양끝 차이가 10bp 이상이라 tight 에 걸리지 않는다. */
const LINEAR = () => Object.fromEntries(NODES.map((n) => [n, 1 + 0.1 * n]));
/** 오목(√) 커브 — 직선과 ratio 가 다르다. 창 비교용 두 번째 형상. */
const SQRT = () => Object.fromEntries(NODES.map((n) => [n, 1 + 0.4 * Math.sqrt(n)]));
/** 완전 평탄 커브 — 모든 조합의 양끝 차이가 0 이라 전부 tight 가 된다. */
const FLAT = () => Object.fromEntries(NODES.map((n) => [n, 2]));

const curveOf = (shapes) => ({ grid: GRID, rows: shapes.map((y, i) => row(i, y)) });

// ── 1. crv1-calc 단일 일자와의 일치 (회귀 감시) ───────────────────────────────

test('이력 = 날짜별 weightsAt — 조합 순서·키·네 배열이 전부 일치한다', () => {
  const shapes = Array.from({ length: 10 }, (_, i) => {
    const y = LINEAR();
    for (const n of NODES) y[n] += i * 0.01;     // 날마다 평행이동 → 날짜별로 값이 달라진다
    return y;
  });
  const curve = curveOf(shapes);

  for (const basis of ['duration', 'time']) {
    const h = history(curve, { neutral: basis });
    assert.equal(h.neutral, basis);
    assert.deepEqual(h.dates, curve.rows.map((r) => r[0]));
    assert.equal(h.series.length, TRIPLES.length);

    const cols = nodeColumns(GRID);
    curve.rows.forEach((r, i) => {
      const y = pickNodes(r, cols);
      const ref = weightsAt(y, nodeDurations(y), { neutral: basis });
      h.series.forEach((s, j) => {
        assert.equal(s.key, ref[j].key, `조합 순서가 어긋났다 (i=${i}, j=${j})`);
        assert.equal(s.ratio[i], ref[j].ratio, `${s.key} ratio @${h.dates[i]}`);
        assert.equal(s.neutral[i], ref[j].neutral, `${s.key} neutral @${h.dates[i]}`);
        assert.equal(s.gap[i], ref[j].gap, `${s.key} gap @${h.dates[i]}`);
        assert.equal(s.flag[i], ref[j].flag, `${s.key} flag @${h.dates[i]}`);
      });
    });
  }
});

test('series[i].dates 는 상위 dates 와 같은 배열 참조다 — 조합마다 복제하지 않는다', () => {
  const h = history(curveOf([LINEAR(), LINEAR()]));
  for (const s of h.series) assert.equal(s.dates, h.dates);
});

test('빈 입력·격자 결측은 조용히 넘어가지 않고 던진다', () => {
  assert.throws(() => history({ grid: GRID, rows: [] }), /rows/);
  assert.throws(() => history(null), /curve/);
  assert.throws(() => history({ grid: [1, 2, 3], rows: [row(0, LINEAR())] }), /노드가 없습니다/);
});

// ── 2. 제외 — 압축·결측을 나눠 센다 ───────────────────────────────────────────

test('tight 일자는 ratio·gap 이 null + flag 이고 평균·n 에서 빠진다', () => {
  // 10일 중 index 3 만 평탄 커브 → 모든 조합이 tight.
  const shapes = Array.from({ length: 10 }, (_, i) => (i === 3 ? FLAT() : LINEAR()));
  const h = history(curveOf(shapes));

  for (const s of h.series) {
    assert.equal(s.ratio[3], null, `${s.key} tight 일자에 ratio 가 남았다`);
    assert.equal(s.gap[3], null, `${s.key} tight 일자에 gap 이 남았다`);
    assert.equal(s.flag[3], 'tight');
    assert.notEqual(s.neutral[3], null, '중립은 금리를 쓰지 않으므로 tight 여도 남는다');

    const st = stats(s.ratio, 'all', s.flag);
    assert.equal(st.used, 10);
    assert.equal(st.n, 9);
    assert.equal(st.excluded, 1);
    assert.equal(st.tight, 1);
    assert.equal(st.missing, 0);
    assert.equal(st.other, 0);

    // 평균이 null 을 0 으로 세지 않았는지 직접 확인한다.
    const obs = s.ratio.filter((v) => v != null);
    assert.equal(st.n, obs.length);
    const mean = obs.reduce((a, b) => a + b, 0) / obs.length;
    assert.ok(Math.abs(st.mean - mean) < 5e-3, `${st.mean} ≉ ${mean}`);
  }
});

test('압축과 결측을 합치지 않고 따로 센다', () => {
  // index 3 평탄(tight, 전 조합) · index 7·8 은 마지막 노드만 결측(missing, 그 노드를 쓰는 조합만).
  const last = NODES[NODES.length - 1];
  const shapes = Array.from({ length: 10 }, (_, i) => {
    if (i === 3) return FLAT();
    const y = LINEAR();
    if (i === 7 || i === 8) delete y[last];
    return y;
  });
  const h = history(curveOf(shapes));

  const tailKey = TRIPLES[TRIPLES.length - 1].join('-');   // 마지막 노드를 쓰는 유일한 조합
  const tail = byKey(h.series, tailKey);
  assert.equal(tail.flag[3], 'tight');
  assert.equal(tail.flag[7], 'missing');
  assert.equal(tail.flag[8], 'missing');

  const stTail = stats(tail.ratio, 'all', tail.flag);
  assert.equal(stTail.used, 10);
  assert.equal(stTail.n, 7);
  assert.equal(stTail.excluded, 3);
  assert.equal(stTail.tight, 1, '압축이 결측으로 합쳐졌다');
  assert.equal(stTail.missing, 2, '결측이 압축으로 합쳐졌다');
  assert.equal(stTail.tight + stTail.missing + stTail.other, stTail.excluded);

  // 결측이 행 전체를 오염시키지 않는다 — 다른 조합은 압축 1일만 빠진다.
  const head = h.series[0];
  const stHead = stats(head.ratio, 'all', head.flag);
  assert.equal(stHead.n, 9);
  assert.equal(stHead.tight, 1);
  assert.equal(stHead.missing, 0);
});

test('flag 를 주지 않으면 사유 불명(other)으로 세고 제외 합계는 맞춘다', () => {
  const st = stats([1, null, 3, null, 5], 'all');
  assert.equal(st.n, 3);
  assert.equal(st.excluded, 2);
  assert.equal(st.tight, 0);
  assert.equal(st.missing, 0);
  assert.equal(st.other, 2);
});

test('전부 null 인 창은 숫자를 지어내지 않는다', () => {
  const st = stats([null, null, null], 'all', ['tight', 'missing', 'tight']);
  assert.equal(st.mean, null);
  assert.equal(st.sd, null);
  assert.equal(st.z, null);
  assert.equal(st.current, null);
  assert.equal(st.n, 0);
  assert.equal(st.excluded, 3);
  assert.equal(st.tight, 2);
  assert.equal(st.missing, 1);
});

test('관측 1개면 sd·z 를 내지 않는다 — 산포를 말할 표본이 없다', () => {
  const st = stats([null, null, 4.2], 'all', ['tight', 'tight', null]);
  assert.equal(st.n, 1);
  assert.equal(st.mean, 4.2);
  assert.equal(st.sd, null);
  assert.equal(st.z, null);
  assert.equal(st.current, 4.2);
});

test('창 내내 같은 값이면 z 를 내지 않는다 — 0 으로 나누지 않는다', () => {
  const st = stats([3, 3, 3, 3], 'all');
  assert.equal(st.sd, 0);
  assert.equal(st.z, null);
});

test('현재값은 창의 마지막 값이고, 그날이 결측이면 null 이다', () => {
  assert.equal(stats([1, 2, 3], 'all').current, 3);
  assert.equal(stats([1, 2, null], 'all', [null, null, 'tight']).current, null);
});

// ── 3. 창 ────────────────────────────────────────────────────────────────────

test('window=250 과 all 의 평균이 다르다 — 창 밖 구간이 새어 들어오지 않는다', () => {
  // 앞 50일은 √ 형상, 뒤 250일은 직선. 250일 창은 직선 구간만 본다.
  const shapes = Array.from({ length: 300 }, (_, i) => (i < 50 ? SQRT() : LINEAR()));
  const h = history(curveOf(shapes));

  let differed = 0;
  for (const s of h.series) {
    const w250 = stats(s.ratio, 250, s.flag);
    const wAll = stats(s.ratio, 'all', s.flag);
    assert.equal(w250.used, 250);
    assert.equal(wAll.used, 300);
    assert.equal(w250.n, 250, '합성 커브에는 제외 일자가 없다');
    assert.equal(wAll.n, 300);
    // 250일 창은 형상이 하루도 안 바뀌므로 산포가 0 이다.
    assert.equal(w250.sd, 0, `${s.key} 창 밖 √ 구간이 250일 창에 섞였다`);
    assert.ok(wAll.sd > 0, `${s.key} 전체 창에는 두 형상이 다 들어 있어야 한다`);
    if (w250.mean !== wAll.mean) differed++;
  }
  assert.ok(differed > 0, '어느 조합에서도 평균이 달라지지 않았다 — 창이 먹히지 않는다');
});

test('창이 데이터보다 길면 가용 행수로 줄고 그 사실을 used 에 적는다', () => {
  const h = history(curveOf(Array.from({ length: 30 }, () => LINEAR())));
  const s = h.series[0];
  assert.equal(stats(s.ratio, 250, s.flag).used, 30);
  assert.equal(stats(s.ratio, 750, s.flag).used, 30);
  assert.equal(stats(s.ratio, 'all', s.flag).used, 30);
  assert.equal(windowRows(30, 250), 30);
  assert.equal(windowRows(2629, 250), 250);
  assert.equal(windowRows(2629, 'all'), 2629);
  assert.throws(() => windowRows(10, 0), /window/);
  assert.throws(() => windowRows(10, -5), /window/);
});

test('slice 는 창 길이만큼 꼬리를 자른다 — 날짜와 값이 같은 길이로 맞는다', () => {
  const h = history(curveOf(Array.from({ length: 40 }, () => LINEAR())));
  const s = h.series[0];
  for (const w of WINDOWS) {
    const d = slice(s.dates, w);
    const v = slice(s.ratio, w);
    assert.equal(d.length, v.length);
    assert.equal(d.length, stats(s.ratio, w, s.flag).used);
    assert.equal(d[d.length - 1], s.dates[s.dates.length - 1], '창은 언제나 최신일에서 끝난다');
  }
});

test('WINDOWS 세 선택지에 라벨이 다 있고 기본은 250일이다', () => {
  assert.deepEqual(WINDOWS, [250, 750, 'all']);
  for (const w of WINDOWS) assert.ok(WINDOW_LABEL[w], `${w} 라벨 누락`);
  assert.equal(DEFAULT_WINDOW, 250);
});

// ── 4. 중립 기준 토글 ─────────────────────────────────────────────────────────

test('듀레이션→시간 전환 시 neutral·gap 은 바뀌고 ratio 는 그대로다', () => {
  const shapes = Array.from({ length: 12 }, (_, i) => {
    const y = LINEAR();
    for (const n of NODES) y[n] += i * 0.02;
    return y;
  });
  const curve = curveOf(shapes);
  const hd = history(curve, { neutral: 'duration' });
  const ht = history(curve, { neutral: 'time' });

  let neutralChanged = 0;
  for (let i = 0; i < hd.series.length; i++) {
    const a = hd.series[i], b = ht.series[i];
    assert.equal(a.key, b.key);
    assert.deepEqual(a.ratio, b.ratio, `${a.key} ratio 가 중립 기준에 따라 흔들렸다`);
    assert.deepEqual(a.flag, b.flag, `${a.key} flag 가 중립 기준에 따라 흔들렸다`);
    if (JSON.stringify(a.neutral) !== JSON.stringify(b.neutral)) {
      neutralChanged++;
      assert.notDeepEqual(a.gap, b.gap, `${a.key} neutral 이 바뀌었는데 gap 이 그대로다`);
    }
  }
  assert.ok(neutralChanged > 0, '토글해도 neutral 이 하나도 안 바뀌었다');
});

test('시간 중립은 상수 시계열, 듀레이션 중립은 날마다 움직인다', () => {
  const shapes = Array.from({ length: 12 }, (_, i) => {
    const y = LINEAR();
    for (const n of NODES) y[n] += i * 0.05;     // 금리 수준만 옮긴다 → 시간 비율은 불변
    return y;
  });
  const curve = curveOf(shapes);

  for (const s of history(curve, { neutral: 'time' }).series) {
    assert.equal(new Set(s.neutral).size, 1, `${s.key} 시간 중립이 날마다 달라졌다`);
  }
  const moved = history(curve, { neutral: 'duration' }).series
    .filter((s) => new Set(s.neutral).size > 1).length;
  assert.ok(moved > 0, '듀레이션 중립이 금리 수준 변화에 전혀 반응하지 않았다');
});

// ── 실데이터 구조 스모크 ──────────────────────────────────────────────────────

test('실데이터 — 이력 길이·조합 수·배열 길이가 맞물린다', (t) => {
  const p = fileURLToPath(new URL('../data/ktb-curve.js', import.meta.url));
  if (!existsSync(p)) return t.skip('data/ktb-curve.js 없음');
  const sandbox = {};
  new Function('window', readFileSync(p, 'utf8'))(sandbox);
  const curve = sandbox.KTB_CURVE;
  assert.ok(curve && curve.rows.length > 0);

  const h = history(curve);
  assert.equal(h.dates.length, curve.rows.length);
  assert.equal(h.series.length, TRIPLES.length);
  for (const s of h.series) {
    for (const arr of [s.ratio, s.neutral, s.gap, s.flag]) assert.equal(arr.length, h.dates.length);
    const st = stats(s.ratio, 250, s.flag);
    assert.equal(st.n + st.excluded, st.used);
    assert.equal(st.tight + st.missing + st.other, st.excluded);
    // ratio 와 gap 은 같은 날 함께 살거나 함께 죽는다(gap = ratio − neutral).
    for (let i = 0; i < s.ratio.length; i++) {
      assert.equal(s.ratio[i] == null, s.gap[i] == null, `${s.key} @${h.dates[i]} ratio·gap 결측이 어긋났다`);
    }
  }
});
