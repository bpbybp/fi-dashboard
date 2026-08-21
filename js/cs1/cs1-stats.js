// cs1-stats.js — CS-1 화면이 쓰는 통계. 전부 순수 함수.
//
// 산출물(data/cs1/spreads.json)에는 원시 bp 스프레드 시계열만 들어 있고, 현재값·전일 Δ·
// YTD 범위·250일 범위·z250 은 전부 여기서 클라이언트가 계산한다. 빌더가 통계까지 구워두면
// 창(window)을 바꿔볼 수 없고, 산출물이 특정 화면의 결정에 묶인다.
//
// [복제 사유] z250 의 정본은 js/msb-ktb.js 의 rollingZ(window=250, minPeriods=120, ddof=1)
//   이지만 공유 파일을 건드리지 않는다는 규약에 따라 같은 규칙을 여기에 복제한다.
//   원본과 다른 점은 창 전체가 아니라 한 지점만 계산한다는 것뿐이다 — 231개 시계열 × 2,866일에
//   대해 전 구간 롤링 z 를 돌리면 브라우저에서 1억 회 이상 연산이 되어 화면이 멎는다.
//   수식(표본표준편차 ddof=1 · 유효관측 minPeriods 미만이면 null · σ=0 이면 null)은 동일하다.

/** z 창 길이(영업일). msb-ktb.js Z_WINDOW 와 같은 값. */
export const Z_WINDOW = 250;
/** 창 안 최소 유효 관측수. 이보다 적으면 z 를 내지 않는다. msb-ktb.js Z_MIN_PERIODS 와 같은 값. */
export const Z_MIN_PERIODS = 120;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** idx 이하에서 가장 가까운 비null 인덱스. 없으면 -1. */
export function lastValidIndex(values, idx = values.length - 1) {
  for (let i = Math.min(idx, values.length - 1); i >= 0; i--) if (isNum(values[i])) return i;
  return -1;
}

/**
 * 한 지점의 z. 창 = [idx−window+1, idx] 안의 비null 관측.
 * 유효 관측이 minPeriods 미만이거나 σ=0 이면 null(억지로 내지 않는다).
 */
export function zAt(values, idx, { window = Z_WINDOW, minPeriods = Z_MIN_PERIODS } = {}) {
  const v = values[idx];
  if (!isNum(v)) return null;
  const win = [];
  for (let j = Math.max(0, idx - window + 1); j <= idx; j++) if (isNum(values[j])) win.push(values[j]);
  if (win.length < minPeriods) return null;
  const mean = win.reduce((s, x) => s + x, 0) / win.length;
  const varr = win.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (win.length - 1);
  const sd = Math.sqrt(varr);
  if (!(sd > 0)) return null;
  return (v - mean) / sd;
}

/**
 * [from, to] 구간의 min·max·유효관측수. 결측은 건너뛴다(보간하지 않는다).
 * 유효 관측이 없으면 { min:null, max:null, n:0 }.
 */
export function rangeOf(values, from, to) {
  let min = null, max = null, n = 0;
  const lo = Math.max(0, from), hi = Math.min(to, values.length - 1);
  for (let i = lo; i <= hi; i++) {
    const v = values[i];
    if (!isNum(v)) continue;
    n++;
    if (min === null || v < min) min = v;
    if (max === null || v > max) max = v;
  }
  return { min, max, n };
}

/**
 * asof 와 같은 해의 첫 인덱스(YTD 시작). dates 는 오름차순 'YYYY-MM-DD'.
 * 해가 바뀐 직후엔 표본이 며칠뿐이라 범위 바가 사실상 한 점이 된다 — 그건 그대로 보여준다
 * (표본이 적다고 작년 구간을 끌어와 섞으면 'YTD'가 아니게 된다).
 */
export function ytdStartIndex(dates, asofIdx = dates.length - 1) {
  if (!dates.length) return 0;
  const year = String(dates[Math.min(asofIdx, dates.length - 1)]).slice(0, 4);
  let i = asofIdx;
  while (i > 0 && String(dates[i - 1]).slice(0, 4) === year) i--;
  return i;
}

/**
 * 범위 바에서 현재값의 가로 위치(%). 0 = min 끝, 100 = max 끝.
 * min===max(구간 내내 한 값)면 눈금이 없으므로 가운데(50)에 둔다.
 * 값이나 범위가 없으면 null → 마커를 그리지 않는다.
 */
export function markerPct(v, min, max) {
  if (!isNum(v) || !isNum(min) || !isNum(max)) return null;
  if (max === min) return 50;
  const p = ((v - min) / (max - min)) * 100;
  return Math.max(0, Math.min(100, p));
}

/**
 * 한 셀의 표시값 전부. values = 한 페어·한 만기의 bp 시계열.
 * @returns {{ value, delta, ytd:{min,max,n}, ytdPct, win:{min,max,n}, z, asofIdx }}
 *   value  = 최종 관측(그 날이 결측이면 그 이전 최근 관측)
 *   delta  = 그 관측 − 직전 유효 관측 (영업일 격자이므로 통상 전일). 직전이 없으면 null.
 */
export function cellStats(values, dates, { window = Z_WINDOW } = {}) {
  const empty = { value: null, delta: null, ytd: { min: null, max: null, n: 0 }, ytdPct: null, win: { min: null, max: null, n: 0 }, z: null, asofIdx: -1 };
  if (!Array.isArray(values) || !values.length) return empty;

  const i = lastValidIndex(values);
  if (i < 0) return empty;

  const prev = lastValidIndex(values, i - 1);
  const value = values[i];
  const ytd = rangeOf(values, ytdStartIndex(dates, i), i);
  const win = rangeOf(values, i - window + 1, i);

  return {
    value,
    delta: prev >= 0 ? Math.round((value - values[prev]) * 10) / 10 : null,
    ytd, ytdPct: markerPct(value, ytd.min, ytd.max),
    win, z: zAt(values, i, { window }),
    asofIdx: i,
  };
}
