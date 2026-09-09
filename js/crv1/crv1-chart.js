// crv1-chart.js — CRV-1 Phase 4 이력 라인차트. SVG 문자열을 짓는 순수 함수, DOM 의존 없음.
//
// [복제 사유] 손으로 그리는 SVG 차트의 정본은 js/st1-ui.js:560-693 이다. 그 파일은 ST-1 화면
//   전용이라 기하·스케일 헬퍼가 export 되지 않고, 기존 파일을 수정하지 않는다는 규약에 따라
//   SVG_W/SVG_H/PLOT 관례와 scale()·niceTicks()·n1() 을 여기에 복제한다(crv1-dur.js 와 같은 방식).
//   st1 의 헬퍼가 바뀌면 여기도 같이 봐야 한다 — 다만 산식이 아니라 화면 기하라 값이 갈라져도
//   숫자가 틀어지지는 않는다(그래서 패리티 테스트는 걸지 않는다).
//
// [Plotly 미사용] 이 페이지는 vendor/plotly.min.js 를 로드하지 않으며 추가하지도 않는다.
//   CS-1·MS-1·CP 는 Plotly 를 쓰지만 crv1.html 은 무의존 정적 페이지로 남긴다 — 선 세 개와
//   수평 기준선 두 개에 차트 라이브러리를 들이면 페이지가 vendor 사정에 묶인다.
//
// [st1 대비 신규분] st1 차트는 x 가 잔존일수인 산점도다. 여기서 새로 쓴 것은 넷이다.
//   · x 를 **영업일 인덱스**로 둔다. 달력일 간격으로 그리면 주말·휴일이 규칙적인 빈칸이 되고,
//     그 빈칸이 실제 결측과 구별되지 않는다. 날짜는 눈금 라벨로만 쓴다.
//   · null 에서 선을 **끊는다**. polyline 을 분절하며, 앞뒤를 잇지 않는다(보간 금지 — 없는
//     관측을 지어내지 않는다). 앞뒤가 모두 null 인 고립된 하루는 선이 될 수 없으므로 점으로 찍는다.
//   · 끊긴 자리를 축 바닥 **러그**로 표시한다. 선이 없는 것과 값이 없는 것을 구별해 준다.
//   · 끝점 값 라벨(DESIGN.md 필수). 겹치면 세로로 벌린다. 값 옆에 **그 값이 관측된 날짜**를
//     작은 글씨로 붙인다 — 끝점은 최신일이 아니라 마지막 유효 관측이라 제목의 최신일과 다를 수
//     있고(의도된 동작), 날짜가 없으면 그 차이가 화면에서 오류처럼 보인다.
//
// [측정 전용] 판단 문구·색상 신호·화살표·밴드 없음. 선은 실선 1 + 점선 2(중립·평균)뿐이고
//   유채색은 실선의 --accent 하나다. 러그는 무채색 단일 톤이며 **압축·결측을 구분하지 않는다**
//   — 두 톤으로 나누는 순간 그 구분이 곧 신호로 읽힌다. 사유별 일수는 캡션 숫자로만 낸다.
//   임계선·이산 밴드 금지. 평균선과 0선은 기준선이지 경계가 아니다.

/** 좌표계는 viewBox 로 고정하고 CSS 로 폭을 늘린다(st1 관례). 반응형이 공짜로 따라온다. */
export const SVG_W = 1200;
export const SVG_H = 280;
/**
 * 우측 여백 92 는 끝점 라벨 자리다(DESIGN.md). 없애면 라벨이 뷰박스 밖으로 나간다.
 * "1234.5 · 09-03" 기준으로 잡았다 — 값 11px + 날짜 9px 모노에 여유 몇 px. 라벨 형식을
 * 바꾸면 이 숫자도 같이 봐야 한다.
 */
const PLOT = { x0: 52, x1: SVG_W - 92, y0: 14, y1: SVG_H - 34 };

/** 러그 띠 두께(뷰박스 px). 플롯 안쪽 맨 아래에 깔고 선을 그 위에 얹는다. */
const RUG_H = 6;
/** 끝점 라벨 세로 최소 간격. 이보다 가까우면 벌린다. */
const LABEL_GAP = 12;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const n1 = (v) => Number(v).toFixed(1);

/** 선형 스케일. 도메인 폭이 0이면 화면 가운데로 접는다. (st1-ui.js:588 복제) */
function scale(lo, hi, a, b) {
  const span = hi - lo;
  if (!(span > 0)) return () => (a + b) / 2;
  return (v) => a + ((v - lo) / span) * (b - a);
}

/** 1·2·5·10 배수 눈금. (st1-ui.js:595 복제) */
function niceTicks(lo, hi, want = 5) {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const k = raw / mag;
  const step = (k < 1.5 ? 1 : k < 3 ? 2 : k < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

/** 눈금 간격에 맞춘 소수 자릿수. 창이 좁으면 정수 눈금이 전부 같은 숫자로 보인다. */
function tickDecimals(ticks) {
  if (ticks.length < 2) return 1;
  const step = Math.abs(ticks[1] - ticks[0]);
  return step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
}

/** 부호를 항상 붙인 값. 갭은 0 을 기준으로 읽는 값이라 +/− 가 있어야 한다. */
const signedFmt = (v, d = 1) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
const plainFmt = (v, d = 1) => v.toFixed(d);

/**
 * x 눈금 — 영업일 인덱스 몇 개를 골라 날짜(YYYY-MM)로 라벨링한다.
 * 등간격 인덱스라 실제 달력 간격은 고르지 않다. 시간축이 아니라 **관측 순서축**이기 때문이다.
 */
function xTicks(dates, want = 6) {
  const N = dates.length;
  if (N <= 1) return [{ i: 0, label: (dates[0] || '').slice(0, 7) }];
  const k = Math.min(want, N);
  const out = [];
  for (let j = 0; j < k; j++) {
    const i = Math.round((j * (N - 1)) / (k - 1));
    out.push({ i, label: String(dates[i] || '').slice(0, 7) });
  }
  return out;
}

/**
 * null 을 경계로 끊은 선. 이어붙이지 않는다.
 * 고립점(앞뒤가 null 인 하루)은 polyline 이 아무것도 그리지 않으므로 작은 점으로 남긴다 —
 * 결측이 잦은 구간에서 하루짜리 관측이 통째로 사라지는 것을 막는다.
 */
function brokenLine(values, sx, sy, kind) {
  const parts = [];
  let seg = [];
  const flush = () => {
    if (seg.length === 1) parts.push(`<circle class="dot ${kind}" cx="${seg[0][0]}" cy="${seg[0][1]}" r="1.5"/>`);
    else if (seg.length > 1) parts.push(`<polyline class="ln ${kind}" points="${seg.map((p) => `${p[0]},${p[1]}`).join(' ')}"/>`);
    seg = [];
  };
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (isNum(v)) seg.push([n1(sx(i)), n1(sy(v))]);
    else flush();
  }
  flush();
  return parts.join('');
}

/**
 * 결측 러그 — 값이 없는 날의 연속 구간을 축 바닥 띠로 깐다.
 * 사유(압축·결측)를 구분하지 않는 **단일 톤**이다. 하루짜리 구간은 폭이 1px 미만으로
 * 떨어지므로 최소 폭을 준다 — 안 그러면 전체 창에서 하루 결측이 보이지 않는다.
 */
function rugRects(values, sx, N) {
  const dx = N > 1 ? (PLOT.x1 - PLOT.x0) / (N - 1) : (PLOT.x1 - PLOT.x0);
  const y = PLOT.y1 - RUG_H;
  const out = [];
  let a = -1;
  const flush = (b) => {
    if (a < 0) return;
    const x0 = Math.max(PLOT.x0, sx(a) - dx / 2);
    const x1 = Math.min(PLOT.x1, sx(b) + dx / 2);
    out.push(`<rect class="rug" x="${n1(x0)}" y="${y}" width="${n1(Math.max(1, x1 - x0))}" height="${RUG_H}"/>`);
    a = -1;
  };
  for (let i = 0; i < values.length; i++) {
    if (isNum(values[i])) { flush(i - 1); } else if (a < 0) a = i;
  }
  flush(values.length - 1);
  return out.join('');
}

/** 마지막 유효 관측의 {i, v}. 최신일이 압축·결측이면 그 이전 날이 끝점이 된다. */
function lastPoint(values) {
  for (let i = values.length - 1; i >= 0; i--) if (isNum(values[i])) return { i, v: values[i] };
  return null;
}

/**
 * 끝점 값 라벨(DESIGN.md 필수) — 값은 데이터에서 동적 바인딩. 겹치면 세로로 벌린다.
 * @param {Array<{y:number, x:number, text:string, cls:string}>} labels
 */
function spread(labels) {
  const sorted = [...labels].sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y < LABEL_GAP) sorted[i].y = sorted[i - 1].y + LABEL_GAP;
  }
  return sorted;
}

/**
 * 이력 라인차트 SVG.
 *
 * @param {object} p
 * @param {string[]} p.dates                 창 구간 날짜(x 라벨용)
 * @param {Array<number|null>} p.main        실선 — 비중 또는 갭
 * @param {Array<number|null>|null} [p.dashed] 가는 점선 — 중립(비중 뷰에서만)
 * @param {number|null} [p.mean]             수평 점선 — 창 평균
 * @param {boolean} [p.zeroRef]              0 기준선(갭 뷰)
 * @param {string} [p.unit]                  y축 단위 라벨
 * @param {boolean} [p.signed]               끝점·기준선 라벨에 부호를 붙일지
 * @param {string} [p.ariaLabel]
 * @returns {string} SVG 문자열
 */
export function chartSvg({
  dates = [], main = [], dashed = null, mean = null, zeroRef = false,
  unit = '%', signed = false, ariaLabel = '',
} = {}) {
  const N = main.length;
  const fmt = signed ? signedFmt : plainFmt;

  // y 도메인 — 실선·점선·평균선·0선을 모두 담는다. 기준선이 화면 밖에 있으면 기준이 아니다.
  let yLo = Infinity, yHi = -Infinity;
  const take = (v) => { if (isNum(v)) { if (v < yLo) yLo = v; if (v > yHi) yHi = v; } };
  for (const v of main) take(v);
  if (dashed) for (const v of dashed) take(v);
  take(mean);
  if (zeroRef) take(0);

  if (!(yLo <= yHi)) {
    return `<svg class="crv1-chart" viewBox="0 0 ${SVG_W} ${SVG_H}" preserveAspectRatio="xMidYMid meet"`
      + ` role="img" aria-label="${esc(ariaLabel)}">`
      + `<text class="ax" x="${SVG_W / 2}" y="${SVG_H / 2}" text-anchor="middle">창 안에 표시할 값이 없습니다</text></svg>`;
  }
  const pad = Math.max(0.5, (yHi - yLo) * 0.1);
  yLo -= pad; yHi += pad;

  const sx = scale(0, Math.max(1, N - 1), PLOT.x0, PLOT.x1);
  const sy = scale(yLo, yHi, PLOT.y1, PLOT.y0);   // 화면 y 는 아래가 크다

  const yt = niceTicks(yLo, yHi, 5).filter((v) => v >= yLo && v <= yHi);
  const yd = tickDecimals(yt);
  const xt = xTicks(dates);

  const grid = [
    ...yt.map((v) => `<line class="grid" x1="${PLOT.x0}" y1="${n1(sy(v))}" x2="${PLOT.x1}" y2="${n1(sy(v))}"/>`),
    ...xt.map((t) => `<line class="grid" x1="${n1(sx(t.i))}" y1="${PLOT.y0}" x2="${n1(sx(t.i))}" y2="${PLOT.y1}"/>`),
  ].join('');

  const axis = [
    ...yt.map((v) => `<text class="ax" x="${PLOT.x0 - 8}" y="${n1(sy(v) + 3.5)}" text-anchor="end">${v.toFixed(yd)}</text>`),
    ...xt.map((t) => `<text class="ax" x="${n1(sx(t.i))}" y="${PLOT.y1 + 16}" text-anchor="middle">${esc(t.label)}</text>`),
    `<text class="ax lab" x="${PLOT.x0 - 8}" y="${PLOT.y0 - 2}" text-anchor="end">${esc(unit)}</text>`,
  ].join('');

  // 기준선 — 데이터 선 아래에 깐다(CS-1 의 shapes layer:'below' 와 같은 순서).
  const refs = [];
  if (zeroRef) refs.push(`<line class="ref zero" x1="${PLOT.x0}" y1="${n1(sy(0))}" x2="${PLOT.x1}" y2="${n1(sy(0))}"/>`);
  // 평균선에 글자 라벨을 붙인다. 비중 뷰에는 점선이 둘(중립·평균)이라 파선 모양만으로
  // 구분하게 두면 읽는 사람이 매번 추측해야 한다. 판정이 아니라 이름이다.
  // 선은 데이터 아래에 깔지만 **라벨은 맨 위에** 얹는다 — 바탕을 punch out 해도 나중에
  // 그려지는 중립 점선이 그 위를 덮으면 글자가 다시 지워진다.
  let meanLabel = '';
  if (isNum(mean)) {
    const my = sy(mean);
    refs.push(`<line class="ref mean" x1="${PLOT.x0}" y1="${n1(my)}" x2="${PLOT.x1}" y2="${n1(my)}"/>`);
    meanLabel = `<rect class="ref-lab-bg" x="${PLOT.x0 + 2}" y="${n1(my - 14)}" width="25" height="12"/>`
      + `<text class="ref-lab" x="${PLOT.x0 + 5}" y="${n1(my - 4.5)}">평균</text>`;
  }

  const rug = rugRects(main, sx, N);
  const dashedLine = dashed ? brokenLine(dashed, sx, sy, 'neutral') : '';
  const mainLine = brokenLine(main, sx, sy, 'main');

  // 끝점 값 라벨. 실선·중립점선 각각의 **마지막 유효 관측**에 붙인다. 최신일이 압축·결측이면
  // 그보다 앞선 날이 끝점이 되고, 그 점이 데이터 덩어리에서 떨어져 있을 수 있다 —
  // 라벨만 덩그러니 뜨면 무슨 숫자인지 알 수 없으므로 점을 함께 찍어 붙여 둔다.
  // 날짜는 MM-DD 로만 낸다. x 눈금이 YYYY-MM 을 이미 깔고 있어 연도는 축에서 읽힌다.
  const mmdd = (i) => String(dates[i] || '').slice(5);
  const lp = [];
  const pm = lastPoint(main);
  if (pm) lp.push({ x: sx(pm.i), y: sy(pm.v), dy: sy(pm.v), text: fmt(pm.v), date: mmdd(pm.i), kind: 'main' });
  if (dashed) {
    const pd = lastPoint(dashed);
    if (pd) lp.push({ x: sx(pd.i), y: sy(pd.v), dy: sy(pd.v), text: pd.v.toFixed(1), date: mmdd(pd.i), kind: 'neutral' });
  }
  const endDots = lp
    .map((p) => `<circle class="ep-dot ${p.kind}" cx="${n1(p.x)}" cy="${n1(p.dy)}" r="2.4"/>`)
    .join('');
  // spread 는 라벨의 y 만 벌린다(점은 제자리) — 두 끝점이 겹칠 때 숫자가 포개지는 것을 막는다.
  const endLabels = spread(lp)
    .map((p) => `<text class="ep ${p.kind}" x="${n1(Math.min(p.x, PLOT.x1) + 6)}" y="${n1(p.y + 3.5)}">${esc(p.text)}`
      + (p.date ? `<tspan class="ep-date" dx="4">· ${esc(p.date)}</tspan>` : '')
      + '</text>')
    .join('');

  return `<svg class="crv1-chart" viewBox="0 0 ${SVG_W} ${SVG_H}" preserveAspectRatio="xMidYMid meet"`
    + ` role="img" aria-label="${esc(ariaLabel)}">`
    + grid
    + rug
    + refs.join('')
    + dashedLine + mainLine
    + `<line class="axis-line" x1="${PLOT.x0}" y1="${PLOT.y1}" x2="${PLOT.x1}" y2="${PLOT.y1}"/>`
    + `<line class="axis-line" x1="${PLOT.x0}" y1="${PLOT.y0}" x2="${PLOT.x0}" y2="${PLOT.y1}"/>`
    + axis + meanLabel + endDots + endLabels
    + '</svg>';
}

/**
 * 캡션 한 줄. 숫자만 낸다 — 평가어 없음.
 *   평균 x.x · σ y.y · 현재 z=±z.z · n=NNN / W (제외 M일: 압축 a · 결측 b)
 * 제외가 없으면 괄호를 붙이지 않는다. flag 를 못 준 제외(other)가 있으면 감추지 않고 덧붙인다.
 *
 * @param {ReturnType<import('./crv1-history.js').stats>} st
 */
export function captionText(st) {
  const num = (v, d = 1) => (isNum(v) ? v.toFixed(d) : '—');
  const z = isNum(st.z) ? signedFmt(st.z, 1) : '—';
  const parts = [`평균 ${num(st.mean)}`, `σ ${num(st.sd)}`, `현재 z=${z}`, `n=${st.n} / ${st.used}`];
  let line = parts.join(' · ');
  if (st.excluded > 0) {
    const why = [`압축 ${st.tight}`, `결측 ${st.missing}`];
    if (st.other > 0) why.push(`기타 ${st.other}`);
    line += ` (제외 ${st.excluded}일: ${why.join(' · ')})`;
  }
  return line;
}

/** 차트 제목 오른쪽에 붙는 현재값 묶음. 표의 최신일 숫자와 같은 값이다. */
export function headlineText(cur) {
  const f = (v, s = false) => (isNum(v) ? (s ? signedFmt(v, 2) : v.toFixed(2)) : '—');
  return `비중 ${f(cur.ratio)}% · 중립 ${f(cur.neutral)}% · 갭 ${f(cur.gap, true)}%p`;
}
