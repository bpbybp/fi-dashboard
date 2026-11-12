// cs2-calc.js — CS-2 크레딧 스프레드 추이 화면이 쓰는 계산. 전부 순수 함수(DOM·fetch 없음).
//
// 입력은 data/cs1/spreads.json 그대로다(국고 동일만기 대비 bp 시계열, 섹터×만기).
// 이 모듈은 새 데이터를 만들지 않는다 — 다리(leg) 하나를 고르거나, 두 다리의 차(A − B)를
// 만들고, 그 한 줄에 대해 이동평균과 기간 통계를 낸다.
//
// [측정 전용] 평균 대비 위·아래, 백분위는 위치만 말한다. 판정 문구·임계값·밴드는 없다.
//
// [결측 규약] 보간하지 않는다. 한쪽 다리가 비면 차도 빈다. 이동평균은 창 N개가 전부
//   유효 관측일 때만 값을 낸다(부분 창 금지 — 창 앞머리에서 짧은 평균이 진짜 N일 평균처럼
//   보이는 것을 막는다).

/** 이동평균 창(영업일). 화면 토글 순서 그대로. */
export const MA_WINDOWS = [20, 60, 120, 200];

/** 역사적 평균 기간. 달력 기준(마지막 관측일에서 N년 전 같은 날 이후). */
export const HIST_WINDOWS = ['2y', '3y', '5y', '10y', 'max'];

/** 차트에 보이는 기간. 기본 1y. */
export const VIEW_WINDOWS = ['3m', '6m', '1y', '2y', '3y', '5y', '10y', 'max'];

export const WINDOW_LABEL = {
  '3m': '3M', '6m': '6M', '1y': '1Y', '2y': '2Y', '3y': '3Y', '5y': '5Y', '10y': '10Y', max: 'MAX',
};

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round1 = (v) => Math.round(v * 10) / 10;

/** 국고 대비 시리즈 id. spreads.json 의 seriesOrder 규칙과 같다. */
export function seriesId(sector, benchmark) {
  return `${sector}_vs_${benchmark}`;
}

/** 고를 수 있는 섹터 = 국고 대비 시리즈가 있는 섹터(소스 순서 유지). */
export function sectorList(meta) {
  const suffix = '_vs_' + meta.benchmark;
  return meta.seriesOrder.filter((id) => id.endsWith(suffix)).map((id) => id.slice(0, -suffix.length));
}

/** 한 다리(섹터·만기)의 국고 대비 bp 시계열. 없으면 null. */
export function legValues(doc, sector, tenor) {
  const s = doc.series[seriesId(sector, doc.meta.benchmark)];
  const arr = s && s[tenor];
  return Array.isArray(arr) ? arr : null;
}

/**
 * 두 다리의 차 A − B (bp, 소수 1자리). 어느 한쪽이 결측이면 그 날은 null.
 * 두 다리의 만기가 달라도 그대로 뺀다 — 각 다리는 자기 만기 국고 대비 스프레드이므로
 * 결과는 "스프레드의 차"이지 수익률 차가 아니다(만기가 같을 때만 둘이 일치한다).
 */
export function diffSeries(a, b) {
  const n = Math.min(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = isNum(a[i]) && isNum(b[i]) ? round1(a[i] - b[i]) : null;
  return out;
}

/**
 * 후행 단순이동평균. out[i] = values[i−n+1..i] 의 평균, 창 전체가 유효 관측일 때만.
 * 누적합이 아니라 창 합을 굴린다(결측 개수를 같이 세어 부분 창을 걸러낸다).
 */
export function movingAverage(values, n) {
  const out = new Array(values.length).fill(null);
  if (!(n >= 1)) return out;
  let sum = 0, bad = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isNum(v)) sum += v; else bad++;
    if (i >= n) {
      const old = values[i - n];
      if (isNum(old)) sum -= old; else bad--;
    }
    if (i >= n - 1 && bad === 0) out[i] = sum / n;
  }
  return out;
}

/** 'YYYY-MM-DD' 에서 달력으로 months 개월 전. 말일 넘침은 그 달 말일로 당긴다(3/31 − 1M → 2/28). */
export function shiftMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12), nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const p2 = (x) => String(x).padStart(2, '0');
  return `${ny}-${p2(nm + 1)}-${p2(Math.min(d, lastDay))}`;
}

const WINDOW_MONTHS = { '3m': 3, '6m': 6, '1y': 12, '2y': 24, '3y': 36, '5y': 60, '10y': 120 };

/**
 * 기간 키 → 시작 인덱스(endIdx 기준 달력 N개월 전 같은 날 이후 첫 관측). 'max' 는 0.
 * 이력이 기간보다 짧으면 0 이 된다 — 그때 실제 표본 길이는 windowStats 의 n·from 으로 드러난다.
 */
export function startIndexFor(dates, key, endIdx = dates.length - 1) {
  if (key === 'max' || !dates.length) return 0;
  const months = WINDOW_MONTHS[key];
  if (!months) return 0;
  const cutoff = shiftMonths(dates[endIdx], months);
  let lo = 0, hi = endIdx; // 첫 dates[i] >= cutoff
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] < cutoff) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** idx 이하에서 가장 가까운 유효 관측 인덱스. 없으면 -1. */
export function lastValidIndex(values, idx = values.length - 1) {
  for (let i = Math.min(idx, values.length - 1); i >= 0; i--) if (isNum(values[i])) return i;
  return -1;
}

/**
 * [from, to] 구간 통계. 결측은 건너뛴다. skip[i] 가 참인 날도 표본에서 뺀다(특정 연도 제외용) —
 * 단 last 는 표본 포함 여부와 무관하게 to 시점 값이다(현재값은 제외 대상이 아니다).
 * @returns {{ n, mean, sd, min, max, minIdx, maxIdx, last, gap, pct, z }}
 *   last = to 시점 값(결측이면 null) · gap = last − mean
 *   pct  = 구간 표본 중 last 보다 작은 비율(동률은 절반) × 100 — 0 이면 구간 최저, 100 이면 최고
 *   z    = (last − mean) / 표본표준편차(ddof=1). 표본 2개 미만이거나 σ=0 이면 null
 */
export function windowStats(values, from, to, skip = null) {
  const lo = Math.max(0, from), hi = Math.min(to, values.length - 1);
  let n = 0, sum = 0, min = null, max = null, minIdx = -1, maxIdx = -1;
  for (let i = lo; i <= hi; i++) {
    const v = values[i];
    if (!isNum(v) || (skip && skip[i])) continue;
    n++; sum += v;
    if (min === null || v < min) { min = v; minIdx = i; }
    if (max === null || v > max) { max = v; maxIdx = i; }
  }
  const empty = { n: 0, mean: null, sd: null, min: null, max: null, minIdx: -1, maxIdx: -1, last: null, gap: null, pct: null, z: null };
  if (!n) return empty;
  const mean = sum / n;
  let ss = 0, below = 0, equal = 0;
  const last = isNum(values[hi]) ? values[hi] : null;
  for (let i = lo; i <= hi; i++) {
    const v = values[i];
    if (!isNum(v) || (skip && skip[i])) continue;
    ss += (v - mean) * (v - mean);
    if (last !== null) { if (v < last) below++; else if (v === last) equal++; }
  }
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : null;
  return {
    n, mean, sd, min, max, minIdx, maxIdx, last,
    gap: last === null ? null : last - mean,
    pct: last === null ? null : ((below + equal / 2) / n) * 100,
    z: last !== null && sd > 0 ? (last - mean) / sd : null,
  };
}

/**
 * 끝점 라벨 세로 배치. 라벨끼리 minGap(px) 미만으로 붙으면 위아래로 밀어 띄운다.
 * @param {Array<{y:number}>} items  y = 플롯 영역 위에서부터의 픽셀(0 = 맨 위)
 * @returns 같은 순서의 배치 y 배열. 영역 [0, height] 안에 가둔다.
 */
export function spreadLabels(items, minGap, height) {
  const order = items.map((it, i) => ({ i, y: it.y })).sort((p, q) => p.y - q.y);
  for (let k = 1; k < order.length; k++) {
    if (order[k].y - order[k - 1].y < minGap) order[k].y = order[k - 1].y + minGap;
  }
  // 아래로 넘치면 전체를 끌어올리고, 다시 위에서부터 간격을 지킨다.
  const over = order.length ? order[order.length - 1].y - height : 0;
  if (over > 0) {
    for (const o of order) o.y -= over;
    for (let k = order.length - 2; k >= 0; k--) {
      if (order[k + 1].y - order[k].y < minGap) order[k].y = order[k + 1].y - minGap;
    }
  }
  const out = new Array(items.length);
  for (const o of order) out[o.i] = o.y;
  return out;
}

/**
 * 미니 차트(스파크라인)용 SVG path. [from, to] 구간을 w×h 상자에 편다.
 * 결측에서는 선을 끊는다(M 으로 다시 시작) — 이어 그으면 보간한 것처럼 보인다.
 * 점이 maxPts 보다 많으면 일정 간격으로 솎되 마지막 점은 반드시 남긴다(끝점이 현재값이므로).
 * 솎는 것은 그림뿐이다 — 칸에 적는 숫자는 전부 원 시계열에서 계산한다.
 * @returns path 문자열. 그릴 점이 없으면 ''.
 */
export function sparkPath(values, from, to, { w, h, lo, hi, maxPts = 240 }) {
  const span = to - from;
  if (!(span > 0) || !(hi > lo)) return '';
  const stride = Math.max(1, Math.ceil((span + 1) / maxPts));
  let d = '', pen = false;
  const put = (i) => {
    const v = values[i];
    if (!isNum(v)) { pen = false; return; }
    const x = ((i - from) / span) * w, y = ((hi - v) / (hi - lo)) * h;
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  };
  let i = from;
  for (; i <= to; i += stride) put(i);
  if (i - stride !== to) put(to);
  return d;
}

/** 여러 계열·단일 값들의 공통 y 범위 [lo, hi] (여백 pad 비율). 평평하면 ±1. 값이 없으면 null. */
export function rangeWithPad(arrays, from, to, extra = [], pad = 0.08) {
  let lo = Infinity, hi = -Infinity;
  for (const arr of arrays) {
    for (let i = Math.max(0, from); i <= to && i < arr.length; i++) {
      const v = arr[i];
      if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
  }
  for (const v of extra) if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
  if (!Number.isFinite(lo)) return null;
  const m = hi > lo ? (hi - lo) * pad : 1;
  return [lo - m, hi + m];
}

/** 날짜별 "이 해에 속하나" 표. 평균 표본에서 한 해를 통째로 뺄 때 windowStats 의 skip 으로 넘긴다. */
export function yearMask(dates, year) {
  const y = String(year);
  return dates.map((d) => String(d).slice(0, 4) === y);
}

/**
 * 연도별 산술평균. @returns [{ year:'2015', mean, n }, …] (오름차순, 관측이 있는 해만)
 * 마지막 해는 진행 중이므로 그 해 평균은 연초~마지막 관측일 평균이다.
 */
export function yearlyMeans(values, dates) {
  const out = [];
  let cur = null;
  for (let i = 0; i < dates.length && i < values.length; i++) {
    const v = values[i];
    if (!isNum(v)) continue;
    const y = String(dates[i]).slice(0, 4);
    if (!cur || cur.year !== y) { cur = { year: y, sum: 0, n: 0 }; out.push(cur); }
    cur.sum += v; cur.n++;
  }
  return out.map((o) => ({ year: o.year, mean: o.sum / o.n, n: o.n }));
}

/**
 * 현재값 ÷ 평균. 평균이 0 이하면 배율이 뜻을 잃으므로 null
 * (스프레드가 음수이거나 0 근처인 계열 — 두 섹터 간 차 등 — 에는 쓰지 않는다).
 */
export function ratioOf(last, mean) {
  return isNum(last) && isNum(mean) && mean > 0 ? last / mean : null;
}

/** idx 시점 값 − lag 영업일 전 값(bp, 소수 1자리). 둘 중 하나라도 결측이면 null. 전주비 = lag 5. */
export function changeOver(values, idx, lag = 5) {
  const a = values[idx], b = values[idx - lag];
  return isNum(a) && isNum(b) ? round1(a - b) : null;
}

/**
 * 색 농도용 위치값 t ∈ [−1, 1]. 0 = 평균과 같음, +1 = 넓은 쪽 끝, −1 = 좁은 쪽 끝.
 *   ratio : log2(배율) — 2배에서 +1, 0.5배에서 −1 (배율은 곱셈 척도라 로그로 대칭을 맞춘다)
 *   gap   : (현재 − 평균) / scale — scale 은 화면에 깔린 칸 중 가장 큰 |bp 차|
 *   pct   : (백분위 − 50) / 50
 * 연속값이다. 구간·임계값을 두지 않는다.
 */
export function heatT(kind, { ratio, gap, pct }, scale = 1) {
  let t = null;
  if (kind === 'ratio') t = isNum(ratio) && ratio > 0 ? Math.log2(ratio) : null;
  else if (kind === 'gap') t = isNum(gap) && scale > 0 ? gap / scale : null;
  else if (kind === 'pct') t = isNum(pct) ? (pct - 50) / 50 : null;
  return t === null ? null : Math.max(-1, Math.min(1, t));
}
