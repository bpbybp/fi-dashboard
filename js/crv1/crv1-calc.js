// crv1-calc.js — CRV-1(국고 커브 RV) 계산 레이어. 순수 함수, DOM 의존 없음.
//   입력은 data/ktb-curve.js 의 window.KTB_CURVE({grid, rows}) 형태 그대로. 신규 페처 없음.
//
// bpbybp 규약대로 **측정만** 한다 — 싸다/비싸다 판정도, 밴드도, 시그널도 내지 않는다.
// 산출은 "지금 커브가 중립 대비 어디에 있는가"와 "그 위치가 최근 250영업일 범위의 어디인가"뿐이다.
//
// [노드] 0.5 · 1 · 1.5 · 2 · 2.5 · 3 · 5 · 10 · 20 · 30 · 50 (11개). 전부 KTB_CURVE.grid 의
//   관측 노드라 보간 없음. 단기를 0.5년 단위로 훑는 이유는 1~3년 안에서 조합이 3개(1/2/3 ·
//   2/3/5 · 3/5/10)뿐이면 그 구간의 굴곡이 뭉개져서 보이지 않기 때문이다.
//   50Y 는 2016-10-11 부터 관측 개시 → 그 이전 행은 50Y 가 null 이고, 50Y 를 쓰는 조합만
//   null(flag:'missing')이 된다. 나머지 조합은 정상 산출된다(행 전체를 버리지 않는다).
//   조합 목록은 NODES 에서 파생한다 — 노드를 바꾸면 조합·표·테스트가 한 번에 따라온다.
//
// [지표 1] 구간 비중 — 인접 3점(s,m,l) 6조합. 중간 만기가 양끝 사이 어디에 놓였는가.
//   ratio   = (y_m − y_s) / (y_l − y_s) × 100                     [%]
//   neutral = 'duration' → (D_m − D_s) / (D_l − D_s) × 100        [%]  (기본)
//             'time'     → (m − s) / (l − s) × 100                [%]
//   gap     = ratio − neutral                                     [%p]
//   · 분모 |y_l − y_s| < 5bp 이면 ratio·gap null + flag:'tight'.
//     근거: 분모가 0 에 가까우면 ratio 가 발산해 숫자가 의미를 잃는다. neutral 은 금리를
//     쓰지 않으므로 tight 여도 그대로 낸다(참조용).
//   · 중립 기준을 duration 으로 두는 이유: 시간 중립은 3Y↔10Y 처럼 볼록한 구간에서
//     구조적으로 어긋난다. 다만 어느 쪽도 정답이 아니라 **기준의 선택**이라 인자로 연다.
//
// [지표 2] 듀레이션당 기울기 — 인접 2점 7조합.
//   slope = (y_next − y_cur) × 100 / (D_next − D_cur)             [bp / duration-year]
//   · D_next − D_cur ≤ 0 이면 null + flag:'degenerate'. 정상 커브에선 발생하지 않는
//     방어 코드다(듀레이션은 만기에 단조증가). 0 나눗셈으로 Infinity 를 흘리지 않는다.
//
// [지표 3] 250일 위치 — gap·slope 각각에 대해 최근 250영업일 창의 min/max 와 현재값 위치(0~1).
//   · pos = (cur − min) / (max − min). 창 안 유효 관측 < 2 이거나 max === min 이면 null.
//   · 데이터가 250행 미만이면 **가용 행수로 계산**하고 결과의 window 에 실제 행수를 적는다
//     (부분 창 금지 규약을 쓰는 z250 과 다르다 — 여기 pos 는 분포 가정이 없는 순수 min/max
//     위치라 표본이 적으면 좁을 뿐 왜곡되지 않는다. 대신 표본수를 감추지 않고 노출한다).
//   · 창 안에서 그 조합이 null 인 날(50Y 미관측 등)은 표본에서 빠진다 → range.n 에 기록.
//
// [반올림] ratio·neutral·gap·slope 는 **산출 시점에 소수 2자리**로 고정한다(CS-1 과 같은 규약).
//   min/max/pos 가 전부 같은 반올림 값 위에서 계산되므로 "현재값 = 최대인데 pos 가 0.998"
//   같은 불일치가 생기지 않는다. pos 는 소수 3자리.
//
// [산출 형태] 날짜별 전 시계열이 아니라 **최신일 스냅샷 + 250일 창 통계**만 반환한다.
//   화면이 필요로 하는 것이 현재 위치이고, 전 구간을 들고 다니면 8노드 × 2,600행의
//   듀레이션을 매번 다시 계산하게 된다.

import { modDur } from './crv1-dur.js';

/**
 * CRV-1 이 쓰는 만기 노드(년). **이 배열이 노드의 단일 근원이다** — 조합은 전부 여기서
 * 파생되므로 노드를 바꿀 때 고칠 곳은 이 한 줄이다.
 * 전부 KTB_CURVE.grid 에 실재하는 관측 노드라 보간이 끼지 않는다.
 * 단기는 0.5년 단위로 훑고 3년 위로는 관측 노드 간격을 그대로 따른다
 * (0.25·0.75 는 쓰지 않는다 — 격자에는 있지만 0.5년 단위 관찰이 목적이다).
 */
export const NODES = [0.5, 1, 1.5, 2, 2.5, 3, 5, 10, 20, 30, 50];

/** 구간 비중 조합 — 인접 3점 [short, mid, long]. NODES 에서 자동 파생(n−2 개). */
export const TRIPLES = NODES.slice(0, -2).map((_, i) => NODES.slice(i, i + 3));

/** 듀레이션당 기울기 조합 — 인접 2점 [cur, next]. NODES 에서 자동 파생(n−1 개). */
export const PAIRS = NODES.slice(0, -1).map((_, i) => NODES.slice(i, i + 2));

/** 구간 비중 분모 하한(bp). |y_l − y_s| 가 이 미만이면 ratio 를 내지 않는다. */
export const TIGHT_BP = 5;

/** 위치(pos) 산출 창 길이(영업일). 데이터가 부족하면 가용 행수로 줄어든다. */
export const WINDOW = 250;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);

// 부동소수 여유. (3.85−3.80)×100 이 4.999999… 로 떨어져 정확히 5bp 인 커브가 tight 로
// 잘못 걸리는 것을 막는다. 5bp 는 tight 가 아니고, 5bp 미만이 tight 다.
const EPS_BP = 1e-9;

/**
 * grid 에서 NODES 의 열 인덱스를 찾는다. rows 의 각 행은 [date, v0, v1, …] 이므로
 * 값 인덱스는 grid 인덱스 + 1 이다. 노드가 하나라도 없으면 던진다 — 조용히 null 을
 * 흘리면 커브가 통째로 비어도 화면이 정상인 척하게 된다.
 * @param {number[]} grid
 * @returns {Map<number, number>} node → row 내 값 인덱스
 */
export function nodeColumns(grid) {
  const map = new Map();
  for (const n of NODES) {
    const gi = grid.indexOf(n);
    if (gi < 0) throw new Error(`crv1: grid 에 ${n}Y 노드가 없습니다 (grid=${grid.join(',')})`);
    map.set(n, gi + 1);
  }
  return map;
}

/**
 * 한 행 → { node: yield|null }. 값이 수치가 아니면(null·undefined·NaN) null 로 통일한다.
 * @param {Array} row  [dateISO, …values]
 * @param {Map<number,number>} cols  nodeColumns 결과
 */
export function pickNodes(row, cols) {
  const y = {};
  for (const n of NODES) { const v = row[cols.get(n)]; y[n] = isNum(v) ? v : null; }
  return y;
}

/**
 * 노드별 수정듀레이션. 금리가 null 인 노드는 듀레이션도 null(액면채 가정상 이표율을
 * 모르면 듀레이션이 정의되지 않는다).
 * @param {Record<number, number|null>} y
 */
export function nodeDurations(y) {
  const D = {};
  for (const n of NODES) D[n] = y[n] == null ? null : modDur(n, y[n]);
  return D;
}

/**
 * 구간 비중 6조합. 반환 [{ key, s, m, l, ratio, neutral, gap, flag }].
 * flag: null | 'missing'(입력 결측) | 'degenerate'(중립 분모 ≤0) | 'tight'(금리 분모 <5bp)
 * @param {Record<number, number|null>} y
 * @param {Record<number, number|null>} D
 * @param {{neutral?: 'duration'|'time'}} [opts]
 */
export function weightsAt(y, D, { neutral = 'duration' } = {}) {
  if (neutral !== 'duration' && neutral !== 'time') {
    throw new Error(`crv1: neutral 은 'duration' | 'time' 만 됩니다 (받은 값: ${neutral})`);
  }
  return TRIPLES.map(([s, m, l]) => {
    const base = { key: `${s}-${m}-${l}`, s, m, l, ratio: null, neutral: null, gap: null, flag: null };

    if (y[s] == null || y[m] == null || y[l] == null) return { ...base, flag: 'missing' };

    // 중립 — 금리를 쓰지 않으므로 tight 와 무관하게 먼저 낸다.
    let nv = null;
    if (neutral === 'time') {
      nv = (m - s) / (l - s) * 100;
    } else {
      if (D[s] == null || D[l] == null || D[m] == null) return { ...base, flag: 'missing' };
      const dd = D[l] - D[s];
      if (!(dd > 0)) return { ...base, flag: 'degenerate' }; // 듀레이션 비단조 — 방어
      nv = (D[m] - D[s]) / dd * 100;
    }
    const neutralV = round2(nv);

    const spreadBp = (y[l] - y[s]) * 100;
    if (Math.abs(spreadBp) < TIGHT_BP - EPS_BP) {
      return { ...base, neutral: neutralV, flag: 'tight' }; // ratio·gap 은 내지 않는다
    }

    const ratioV = round2((y[m] - y[s]) / (y[l] - y[s]) * 100);
    return { ...base, ratio: ratioV, neutral: neutralV, gap: round2(ratioV - neutralV) };
  });
}

/**
 * 듀레이션당 기울기 7조합. 반환 [{ key, s, l, slope, flag }].
 * flag: null | 'missing' | 'degenerate'(D_next − D_cur ≤ 0)
 */
export function slopesAt(y, D) {
  return PAIRS.map(([s, l]) => {
    const base = { key: `${s}-${l}`, s, l, slope: null, flag: null };
    if (y[s] == null || y[l] == null || D[s] == null || D[l] == null) return { ...base, flag: 'missing' };
    const dd = D[l] - D[s];
    if (!(dd > 0)) return { ...base, flag: 'degenerate' };
    return { ...base, slope: round2((y[l] - y[s]) * 100 / dd) };
  });
}

/**
 * 값 배열 → { min, max, pos, n }. null 은 표본에서 제외.
 * 유효 표본 < 2 이거나 max === min 이면 pos = null(폭이 0인 창에 위치를 매기지 않는다).
 * @param {Array<number|null>} vals  창 안 값(마지막 원소가 현재값)
 * @param {number|null} cur          현재값
 */
export function rangePos(vals, cur) {
  const obs = vals.filter(isNum);
  if (obs.length === 0) return { min: null, max: null, pos: null, n: 0 };
  const min = Math.min(...obs);
  const max = Math.max(...obs);
  const pos = (!isNum(cur) || obs.length < 2 || max === min) ? null : round3((cur - min) / (max - min));
  return { min: round2(min), max: round2(max), pos, n: obs.length };
}

/**
 * 최신일 스냅샷 + 창 통계.
 *
 * @param {{grid: number[], rows: Array}} curve  window.KTB_CURVE 형태
 * @param {{neutral?: 'duration'|'time', window?: number}} [opts]
 * @returns {{
 *   date: string, neutral: string, window: number, rowsAvailable: number,
 *   nodes: Record<number, number|null>, durations: Record<number, number|null>,
 *   weights: Array, slopes: Array
 * }}  weights[i].range / slopes[i].range 는 각각 gap / slope 의 창 통계.
 */
export function snapshot(curve, opts = {}) {
  const { neutral = 'duration', window: win = WINDOW } = opts;
  if (!curve || !Array.isArray(curve.grid) || !Array.isArray(curve.rows) || curve.rows.length === 0) {
    throw new Error('crv1: curve 는 {grid:[], rows:[…]} 형태여야 하고 rows 가 비면 안 됩니다');
  }
  const cols = nodeColumns(curve.grid);
  const rowsAvailable = curve.rows.length;
  const used = Math.min(win, rowsAvailable);       // 250 미만이면 가용 행수로
  const slice = curve.rows.slice(rowsAvailable - used);

  // 창 전 구간의 gap·slope 를 모아 min/max 를 낸다. 마지막 행이 최신일이다.
  const gapCols = new Map(TRIPLES.map(([s, m, l]) => [`${s}-${m}-${l}`, []]));
  const slopeCols = new Map(PAIRS.map(([s, l]) => [`${s}-${l}`, []]));
  let lastW = null, lastS = null;

  for (const row of slice) {
    const y = pickNodes(row, cols);
    const D = nodeDurations(y);
    const w = weightsAt(y, D, { neutral });
    const sl = slopesAt(y, D);
    for (const it of w) gapCols.get(it.key).push(it.gap);
    for (const it of sl) slopeCols.get(it.key).push(it.slope);
    lastW = w; lastS = sl;
  }

  const last = slice[slice.length - 1];
  const yLast = pickNodes(last, cols);
  const dLast = nodeDurations(yLast);

  return {
    date: last[0],
    neutral,
    window: used,            // 실제 사용 행수 — 250 미만이면 그 값이 그대로 들어간다
    rowsAvailable,
    nodes: yLast,
    durations: Object.fromEntries(NODES.map((n) => [n, dLast[n] == null ? null : round3(dLast[n])])),
    weights: lastW.map((it) => ({ ...it, range: rangePos(gapCols.get(it.key), it.gap) })),
    slopes: lastS.map((it) => ({ ...it, range: rangePos(slopeCols.get(it.key), it.slope) })),
  };
}
