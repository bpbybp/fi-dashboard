// st1-curve.js — ST-1 등급별 커브 적합 + 잔차 (Phase 5).
//
// 정체: 원장의 호가 행들 → **계보별 로그 커브 1개와 각 점의 잔차 bp**.
//       측정만 한다. 싸다·비싸다는 여기서도 화면에서도 말하지 않는다 —
//       잔차 숫자와 좌표만 내고, 그 숫자를 어떻게 읽을지는 사람의 몫이다.
//
// ── 순수 함수만 ─────────────────────────────────────────────────────────
//   DOM·localStorage·fetch 접근 0. `js/st1-parser.js` 에서 todayLocal 만 빌려온다
//   (날짜 규약의 단일 근원 — 파서는 읽기만 하고 수정하지 않는다).
//
// ── 왜 2파라미터 로그 모델인가 ──────────────────────────────────────────
//   r = a + b·ln(τ) 뿐이다. **넬슨-시겔을 쓰지 않는다.**
//   단기물 스팬(1M~1Y)에서는 험프항 β2 와 감쇠 τ 가 서로를 흉내내 식별이 안 된다.
//   그 상태로 적합하면 끝단이 발산하고, 신규 점 하나에 곡선 전체가 요동친다.
//   하루 몇 건씩 손으로 쌓는 데이터에 4~6 파라미터는 과적합이다.
//
// ── 왜 계보를 등급이 아니라 kind+grade 로 가르는가 ──────────────────────
//   예담(예담CP)은 등급이 A1 로 찍혀도 **실질 크레딧이 은행**이다. 회사채 A1 과
//   한 곡선에 섞으면 적합선이 오염되고, 그 오염된 선에 대한 잔차는 아무 의미가 없다.
//   그래서 예담은 등급과 무관하게 자기 계보를 갖는다.

import { todayLocal } from './st1-parser.js';

// ── 상수 ─────────────────────────────────────────────────────────────────

const MS_DAY = 86400000;

/**
 * 적합에 필요한 최소 유효점. 파라미터가 2개(a·b)라 3점이 자유도 1의 하한이다.
 * 2점이면 잔차가 정의상 0이라 σ 를 낼 수 없고, 선은 그어지지만 아무것도 말해주지 않는다.
 */
export const MIN_FIT_POINTS = 3;

/** 시간 가중 반감기(주). 2주면 4주 전 점의 영향이 1/4 로 준다. */
export const DEFAULT_HALF_LIFE_WEEKS = 2;

/** 적합에 넣을 최대 경과 주수. 그보다 오래된 호가는 다른 시장의 기록이다. */
export const DEFAULT_MAX_WEEKS = 8;

/** 계보 표시 순서. UI 가 토글·정렬에 쓰는 단일 근원. */
export const SERIES_ORDER = ['예담', 'CP-A1', 'CP-A2', 'OTHER'];

/** A2 계열 — 등급 세부(+/-)는 계보를 가르지 않는다. 점이 너무 적어 셋으로 쪼개면 전부 적합 불가가 된다. */
const A2_GRADES = new Set(['A2+', 'A2', 'A2-']);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const YM_RE = /^(\d{4})-(\d{2})$/;

/**
 * 유한한 수만 통과시킨다. 아니면 null.
 *
 * ⚠️ `Number.isFinite(Number(v))` 로 줄여 쓰면 안 된다. `Number(null)` 은 **0** 이고
 * `Number('')`·`Number(false)` 도 0 이라, 금리를 안 적은 행(rate: null)이 "0.00% 호가"
 * 로 둔갑해 적합선을 통째로 끌어내린다. 빈 값과 0 은 다른 것이다.
 */
function num(v) {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM-DD' → UTC epoch ms. UTC 로 고정해 DST·시간대가 하루를 먹지 않게 한다. */
function dayMs(s) {
  const m = DATE_RE.exec(String(s ?? ''));
  if (!m) return null;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return Date.UTC(Number(m[1]), mo - 1, d);
}

/** 'YYYY-MM' → 그 달 **15일**의 UTC epoch ms. 연-월만 아는 만기의 중앙값 근사다. */
function ymMidMs(s) {
  const m = YM_RE.exec(String(s ?? ''));
  if (!m) return null;
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  return Date.UTC(Number(m[1]), mo - 1, 15);
}

// ── 좌표 ─────────────────────────────────────────────────────────────────

/**
 * **기록 시점** 잔존일수. 기준일은 오늘이 아니라 `row.date` 다.
 *
 * ⚠️ 여기가 이 파일에서 가장 조용히 틀리기 쉬운 곳이다. 오늘을 기준으로 잡으면
 * 3주 전에 적은 6개월물이 5개월물 자리로 밀려 찍힌다. 점들이 통째로 왼쪽으로
 * 끌려가면서 적합선의 기울기가 실제보다 눕고, 그 선에 대한 잔차는 전부 틀린다.
 * 호가는 **적힌 날의 잔존만기**에 대한 가격이다.
 *
 * @returns {number|null} 일수(양수). 만기가 지났거나 날짜를 못 읽으면 null.
 */
export function residualDays(row) {
  if (!row) return null;
  const base = dayMs(row.date);
  if (base == null) return null;
  const mat = dayMs(row.maturity_date) ?? ymMidMs(row.maturity_ym);
  if (mat == null) return null;
  const d = (mat - base) / MS_DAY;
  return d > 0 ? d : null;
}

/**
 * 계보 판정. 이 함수가 어떤 점들이 한 곡선에 올라탈지를 정한다.
 * @returns {'예담'|'CP-A1'|'CP-A2'|'OTHER'}
 */
export function seriesKey(row) {
  if (!row) return 'OTHER';
  const kind = String(row.kind ?? '').trim();
  // 예담이 먼저다 — 등급을 보기 전에 갈라야 A1 예담이 회사채 A1 로 새지 않는다.
  if (kind === '예담') return '예담';
  if (kind === 'CP') {
    const g = String(row.grade ?? '').trim().toUpperCase();
    if (g === 'A1') return 'CP-A1';
    if (A2_GRADES.has(g)) return 'CP-A2';
  }
  return 'OTHER';
}

/**
 * refDate 기준 경과 주수(내림). 0 = 당주.
 *
 * 미래 일자 행은 0 으로 접는다. 음수를 그대로 두면 `0.5 ** 음수` 가 1 을 넘어
 * 아직 오지 않은 호가가 오늘 호가보다 무겁게 적합에 실린다.
 *
 * @returns {number|null} 주수. 날짜를 못 읽으면 null.
 */
export function weekAge(row, refDate) {
  if (!row) return null;
  const t = dayMs(row.date);
  const ref = dayMs(refDate);
  if (t == null || ref == null) return null;
  const w = Math.floor((ref - t) / MS_DAY / 7);
  return w > 0 ? w : 0;
}

// ── 적합 ─────────────────────────────────────────────────────────────────

/** 반감기 감쇠. halfLife 가 유한 양수가 아니면(= 가중없음) 1 이다. */
function decayWeight(age, halfLifeWeeks) {
  if (!Number.isFinite(halfLifeWeeks) || halfLifeWeeks <= 0) return 1;
  if (!Number.isFinite(age)) return 1;
  return 0.5 ** (Math.max(0, age) / halfLifeWeeks);
}

/** 점의 가중치. 명시된 weight 가 이기고, 없으면 weekAge 에서 만든다. */
function pointWeight(p, halfLifeWeeks) {
  if (p && Number.isFinite(p.weight) && p.weight >= 0) return p.weight;
  return decayWeight(p ? p.weekAge : undefined, halfLifeWeeks);
}

/**
 * 가중 최소제곱 로그 적합 — r = a + b·ln(τ).
 *
 * @param {Array<{tau:number, rate:number, weight?:number, weekAge?:number}>} points
 * @param {{halfLifeWeeks?: number|null}} [opts] weight 가 없는 점의 감쇠 반감기.
 *        null·0·Infinity = 가중없음.
 * @returns {{ok:false,n:number}|{ok:true,a:number,b:number,n:number,sigma:number,predict:(t:number)=>number|null}}
 *          sigma 는 **% 단위**다(bp 아님) — 표시할 때 ×100 한다.
 */
export function fitLog(points, opts = {}) {
  const halfLife = opts.halfLifeWeeks === undefined ? DEFAULT_HALF_LIFE_WEEKS : opts.halfLifeWeeks;

  const use = [];
  for (const p of Array.isArray(points) ? points : []) {
    if (!p) continue;
    const tau = num(p.tau);
    const rate = num(p.rate);
    // τ ≤ 0 은 ln 이 정의되지 않는다. 만기가 지난 점은 애초에 좌표가 없다.
    if (tau == null || tau <= 0 || rate == null) continue;
    const w = pointWeight(p, halfLife);
    if (!Number.isFinite(w) || w <= 0) continue;
    use.push({ x: Math.log(tau), y: rate, w });
  }

  const n = use.length;
  // 선을 만들지 않는다. 억지로 그은 선은 "없음" 보다 나쁘다 — 잔차에 근거가 생겨버린다.
  if (n < MIN_FIT_POINTS) return { ok: false, n };

  let Sw = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
  for (const { x, y, w } of use) {
    Sw += w; Sx += w * x; Sy += w * y; Sxx += w * x * x; Sxy += w * x * y;
  }

  const denom = Sw * Sxx - Sx * Sx;
  // 잔존일수가 사실상 한 점에 몰리면 기울기가 정의되지 않는다(수직선). 점 개수와 무관하게 포기한다.
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-12) return { ok: false, n };

  const b = (Sw * Sxy - Sx * Sy) / denom;
  const a = (Sy - b * Sx) / Sw;

  let sse = 0;
  for (const { x, y, w } of use) {
    const e = y - (a + b * x);
    sse += w * e * e;
  }
  // 가중치는 **상대값**이다. 그대로 나누면 반감기를 바꿨을 뿐인데 σ 가 따라 움직인다.
  // 합이 n 이 되도록 정규화한 뒤 자유도(n−2)로 나눈다. 3점 적합의 밴드가 넓게 나오는 것은
  // 왜곡이 아니라 정직한 결과다 — 점 3개로 그은 선을 믿지 말라는 뜻이다.
  const sigma = Math.sqrt((n * sse) / (Sw * (n - 2)));

  const predict = (tau) => {
    const t = num(tau);
    return t != null && t > 0 ? a + b * Math.log(t) : null;
  };

  return { ok: true, a, b, n, sigma, predict };
}

/**
 * 잔차 — (실제금리 − 적합값) × 100, bp.
 * 부호는 실제가 위면 양수다. 그 이상은 말하지 않는다.
 * @returns {number|null} 적합선이 없거나 좌표를 못 만들면 null.
 */
export function residualBp(row, fit) {
  if (!row || !fit || !fit.ok) return null;
  const tau = residualDays(row);
  if (tau == null) return null;
  const rate = num(row.rate);
  if (rate == null) return null;
  const p = fit.predict(tau);
  return p == null ? null : (rate - p) * 100;
}

/**
 * 원장 → 계보별 { points, fit }.
 *
 * 좌표를 못 만드는 행(만기 없음·만기 지남·금리 없음)은 조용히 빠진다 — 원장에는
 * 남아 있고 여기서만 안 쓰는 것이다. 결과에는 **점이 1개 이상인 계보만** 담긴다.
 *
 * @param {object[]} rows
 * @param {{refDate?:string, maxWeeks?:number|null, halfLifeWeeks?:number|null}} [opts]
 *        maxWeeks null·Infinity = 전체 기간.
 * @returns {Record<string,{points:object[], fit:object}>}
 */
export function buildSeries(rows, opts = {}) {
  const refDate = opts.refDate ?? todayLocal();
  const maxWeeks = opts.maxWeeks === undefined ? DEFAULT_MAX_WEEKS : opts.maxWeeks;
  const halfLifeWeeks = opts.halfLifeWeeks === undefined ? DEFAULT_HALF_LIFE_WEEKS : opts.halfLifeWeeks;

  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const tau = residualDays(row);
    if (tau == null) continue;
    const rate = num(row.rate);
    if (rate == null) continue;
    const age = weekAge(row, refDate);
    if (age == null) continue;
    if (Number.isFinite(maxWeeks) && age > maxWeeks) continue;

    const k = seriesKey(row);
    if (!out[k]) out[k] = { points: [], fit: null };
    out[k].points.push({ tau, rate, weekAge: age, weight: decayWeight(age, halfLifeWeeks), row });
  }

  for (const k of Object.keys(out)) {
    // 잔존일수 오름차순. 적합에는 영향이 없지만 렌더가 순서를 다시 정렬하지 않아도 되게 한다.
    out[k].points.sort((p, q) => p.tau - q.tau);
    out[k].fit = fitLog(out[k].points, { halfLifeWeeks });
  }
  return out;
}
