// onoff-curve.js — on/off 커브 단면 계산 엔진. 순수 함수, DOM·파일 I/O 접근 금지.
// 입력은 항상 data/onoff-bonds.js 의 window.ONOFF_BONDS 형태:
//   { updated, anchorNote, anchorLog, bonds:[{ tag, tenor, maturity, coupon, first, last, series }] }
//   series = [['YYYY-MM-DD', 상대금리bp], …]  ※ 원본 % 수익률은 이 계보에 존재하지 않는다(라이선스).
//
// [상대금리의 사용 제약] series 값은 앵커 전환 누적 오프셋을 포함한다. 같은 일자 안에서는 전 종목에
// 같은 오프셋이 실려 있어 종목 간 차이가 소거되지만, 서로 다른 일자의 레벨을 직접 비교하면 안 된다.
// 이 모듈의 모든 산출물은 '같은 일자 안의 종목 간 차이'만 쓴다.
//
// [프리미엄 정의 — 실측으로 확정된 것]
//   2Y 지표물: 좌우 인접 경과물 선형보간 대비 잔차(내삽). 곡률 편향 없음.
//   3Y 지표물: 잔존창 상단을 넘어가 외삽이 불가피하다. 선형 외삽은 커브 오목성 때문에
//     구조적 음수 편향을 낳으므로(프리미엄 없는 경과물 끝점에도 같은 부호·자릿수로 나타남),
//     같은 계산을 경과물 최장 종목에 적용한 위약 잔차를 빼서 상쇄한다.
//       R = (지표물 − 준거) − 기울기 × 잔존차(년)
//       W = (경과물 최장 − 그 직전) − 기울기' × 잔존차(년)
//       P = R − W
//     R·W·P 를 모두 반환한다 — P 만 보면 편향 상쇄가 어디서 왔는지 알 수 없기 때문.
//
// [의도적으로 만들지 않은 것] 세대 밴드·퍼센타일·판정 문구·매매신호. 세대 간 분산이 신호의
// 4~10배라 밴드가 의미를 갖지 못한다. 이 모듈은 측정값만 낸다.

export const WINDOW_MIN_M = 12;   // 잔존창 하한(개월)
export const WINDOW_MAX_M = 36;   // 잔존창 상한(개월)
export const SLOPE_MAX_M = 30;    // 기울기 추정에 쓰는 경과물 잔존 상한(개월)
export const MIN_FIT_BONDS = 3;   // 경과물 최소 개수 — 미만이면 잔차 산출 불가

const monthIndex = ym => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));
// 잔존만기(개월) = 만기월 − 관측월. 원본에 만기'일'이 없어 월 단위가 상한이다.
export const residualMonths = (maturity, date) => monthIndex(maturity) - monthIndex(date.slice(0, 7));
const round2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

// 1차 최소자승. 점 2개 미만이거나 x 가 전부 같으면 null.
function linfit(pts) {
  const n = pts.length;
  if (n < 2) return null;
  const Sx = pts.reduce((a, p) => a + p.x, 0), Sy = pts.reduce((a, p) => a + p.y, 0);
  const Sxx = pts.reduce((a, p) => a + p.x * p.x, 0), Sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
  const den = n * Sxx - Sx * Sx;
  if (Math.abs(den) < 1e-12) return null;
  const slope = (n * Sxy - Sx * Sy) / den;
  return { slope, intercept: (Sy - slope * Sx) / n, n };
}

// 좌우 인접 2점 선형보간 대비 편차(bp). 대상점은 보간에 쓰지 않는다(leave-one-out).
function interpResidual(center, left, right) {
  if (!left || !right || right.x - left.x <= 0) return null;
  const w = (right.x - center.x) / (right.x - left.x);
  return round2(center.y - (w * left.y + (1 - w) * right.y));
}

// 전 종목의 일자 합집합(오름차순). 화면·시계열 함수의 축.
export function allDates(dataset) {
  const s = new Set();
  for (const b of dataset.bonds) for (const r of b.series) s.add(r[0]);
  return [...s].sort();
}

// --- 단면 ---
// 지표물 판정: tenor 계열별로 first 가 가장 늦은 종목(그날 관측된 종목 중). 계열당 1개.
//   잔존창 밖이면 isOnTheRun 은 true 지만 role 은 'excluded' 이고 잔차를 내지 않는다.
//   신규 3Y 는 발행 직후 잔존 37~38개월이라 이 상태가 14~48영업일 이어진다(측정 공백).
export function snapshot(dataset, date) {
  const obs = [];
  for (const b of dataset.bonds) {
    const hit = b.series.find(r => r[0] === date);
    if (!hit) continue;
    const m = residualMonths(b.maturity, date);
    obs.push({
      tag: b.tag, tenor: b.tenor, maturity: b.maturity, coupon: b.coupon,
      residualMonths: m, relativeYield: hit[1],
      x: m / 12, y: hit[1], first: b.first,
      inWindow: m >= WINDOW_MIN_M && m <= WINDOW_MAX_M,
    });
  }
  obs.sort((a, b) => a.x - b.x);

  const onTag = new Set();
  for (const t of ['2Y', '3Y']) {
    const c = obs.filter(p => p.tenor === t);
    if (c.length) onTag.add(c.reduce((a, p) => (a === null || p.first > a.first ? p : a), null).tag);
  }
  for (const p of obs) {
    p.isOnTheRun = onTag.has(p.tag);
    p.role = !p.inWindow ? 'excluded' : (p.isOnTheRun ? 'onTheRun' : 'fit');
  }

  const win = obs.filter(p => p.inWindow);
  const fit = obs.filter(p => p.role === 'fit');
  const onOf = t => obs.find(p => p.role === 'onTheRun' && p.tenor === t) || null;

  // 인접 기울기 — 잔존창 안 전 종목(지표물 포함) 만기 오름차순
  const slopes = [];
  for (let i = 0; i < win.length - 1; i++) {
    const a = win[i], b = win[i + 1];
    if (b.x - a.x <= 0) continue;
    slopes.push({ from: a.tag, to: b.tag, bpPerYear: round2((b.y - a.y) / (b.x - a.x)),
                  midMonths: (a.residualMonths + b.residualMonths) / 2 });
  }
  // 구간 기울기 — 쌍의 잔존 중점으로 배정, 같은 구간에 여럿이면 평균. 없으면 null.
  const seg = (lo, hi) => {
    const v = slopes.filter(z => z.midMonths >= lo && z.midMonths < hi).map(z => z.bpPerYear);
    return v.length ? round2(v.reduce((a, b) => a + b, 0) / v.length) : null;
  };
  const segments = { m12_18: seg(12, 18), m18_24: seg(18, 24), m24_30: seg(24, 30), m30_36: seg(30, 36) };

  const fitLine = linfit(fit);
  const residuals = [];
  const detail = { insufficientFit: fit.length < MIN_FIT_BONDS, fitCount: fit.length };

  if (fit.length >= MIN_FIT_BONDS) {
    // 경과물: 내부점만 국소보간, 경계점은 null(보간 불가)
    for (let i = 0; i < fit.length; i++) {
      const v = (i === 0 || i === fit.length - 1) ? null : interpResidual(fit[i], fit[i - 1], fit[i + 1]);
      residuals.push({ tag: fit[i].tag, method: 'localInterp', value: v });
    }
    // 2Y 지표물: 좌우 경과물 선형보간
    const on2 = onOf('2Y');
    if (on2) {
      const L = fit.filter(p => p.x < on2.x).slice(-1)[0] || null;
      const R = fit.filter(p => p.x > on2.x)[0] || null;
      const v = interpResidual(on2, L, R);
      residuals.push({ tag: on2.tag, method: 'localInterp', value: v });
      detail.on2 = { tag: on2.tag, left: L ? L.tag : null, right: R ? R.tag : null };
    }
    // 3Y 지표물: R / W / P
    const on3 = onOf('3Y');
    if (on3) {
      const f30 = fit.filter(p => p.residualMonths >= WINDOW_MIN_M && p.residualMonths <= SLOPE_MAX_M);
      const ref = fit.filter(p => p.tenor === '3Y')
                     .reduce((a, p) => (a === null || p.first > a.first ? p : a), null);
      const slR = linfit(f30);
      let R = null, W = null;
      if (ref && slR) R = round2((on3.y - ref.y) - slR.slope * (on3.residualMonths - ref.residualMonths) / 12);
      // 위약: 경과물(12~30M) 최장 종목에 같은 식을 적용 — 프리미엄이 없어야 할 대조군
      let plTag = null;
      if (f30.length >= MIN_FIT_BONDS) {
        const target = f30[f30.length - 1], rest = f30.slice(0, -1), ref2 = rest[rest.length - 1];
        const slW = linfit(rest);
        if (slW) {
          W = round2((target.y - ref2.y) - slW.slope * (target.residualMonths - ref2.residualMonths) / 12);
          plTag = target.tag;
          detail.placebo = { tag: target.tag, ref: ref2.tag, slope: round2(slW.slope),
                             gapMonths: target.residualMonths - ref2.residualMonths };
        }
      }
      const P = (R !== null && W !== null) ? round2(R - W) : null;
      residuals.push({ tag: on3.tag, method: 'pairAdjusted', value: R });
      residuals.push({ tag: plTag, method: 'placebo', value: W });
      residuals.push({ tag: on3.tag, method: 'premium', value: P });
      detail.on3 = { tag: on3.tag, ref: ref ? ref.tag : null, slope: slR ? round2(slR.slope) : null,
                     gapMonths: ref ? on3.residualMonths - ref.residualMonths : null };
    }
  }

  return {
    date,
    bonds: obs.map(p => ({
      tag: p.tag, tenor: p.tenor, maturity: p.maturity, coupon: p.coupon,
      residualMonths: p.residualMonths, relativeYield: p.relativeYield,
      isOnTheRun: p.isOnTheRun, inWindow: p.inWindow, role: p.role,
    })),
    slopes: slopes.map(({ from, to, bpPerYear }) => ({ from, to, bpPerYear })),
    segments,
    fit: fitLine ? { slope: round2(fitLine.slope), intercept: round2(fitLine.intercept), n: fitLine.n }
                 : { slope: null, intercept: null, n: fit.length },
    residuals,
    detail,
  };
}

// --- 종목별 잔차 시계열 ---
// residual = 그 종목의 '역할에 따른 주 잔차'.
//   3Y 지표물 → premium P | 그 외(2Y 지표물·경과물 내부점) → localInterp | 경계점 → null
// method 를 함께 실어 어떤 계산인지 숨기지 않는다. 위약 잔차 W 는 별도로 residualPlacebo 에 담는다
// (강등 직후 최장 경과물이 되면 W 가 R 의 연속선이라 전후 비교에 쓰인다).
export function series(dataset, tag, from, to) {
  const out = [];
  for (const d of allDates(dataset)) {
    if (from && d < from) continue;
    if (to && d > to) continue;
    const snap = snapshot(dataset, d);
    const b = snap.bonds.find(p => p.tag === tag);
    if (!b) continue;
    const pick = m => {
      const r = snap.residuals.find(z => z.tag === tag && z.method === m);
      return r ? r.value : null;
    };
    const primary = (b.role === 'onTheRun' && b.tenor === '3Y') ? 'premium' : 'localInterp';
    out.push({
      date: d, residualMonths: b.residualMonths, relativeYield: b.relativeYield,
      residual: pick(primary), method: primary, role: b.role,
      residualPlacebo: pick('placebo'),
    });
  }
  return out;
}

// --- 구간 기울기 시계열 ---
export function segmentSlopes(dataset, from, to) {
  const out = [];
  for (const d of allDates(dataset)) {
    if (from && d < from) continue;
    if (to && d > to) continue;
    const { segments } = snapshot(dataset, d);
    out.push({ date: d, ...segments });
  }
  return out;
}
