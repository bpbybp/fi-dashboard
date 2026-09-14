// freshness.js — 데이터 신선도 순수 함수 (공용).
//   (lastPeriod, lastUpdated, cadence, today) → { period, updated, lagMonths }
//   DOM·전역 의존 없음 → 페이지(inflation-diffusion 등)와 node --test 양쪽에서 import.
//
// cadence: { releaseDay: D }      — 기준월 M 자료가 M+1월 D일에 나온다고 가정
//          { releaseDay: 'eom' }  — M+1월 말일
// 오늘이 발표일 당일 이상이면 전월이 기대 기준월, 아니면 전전월.
// lagMonths = max(0, 기대 기준월 − 실제 기준월). 판단 문구는 만들지 않는다.

const pad2 = (n) => String(n).padStart(2, '0');

function parsePeriod(p) {
  const m = /^(\d{4})-(\d{2})/.exec(p || '');
  return m ? { y: Number(m[1]), m: Number(m[2]) } : null;
}

function parseDate(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
}

const monthIndex = ({ y, m }) => y * 12 + (m - 1);
const fromIndex = (i) => `${Math.floor(i / 12)}-${pad2((i % 12) + 1)}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// today('YYYY-MM-DD') 기준으로 이미 발표됐어야 할 가장 최근 기준월('YYYY-MM').
export function expectedPeriod(cadence, today) {
  const t = parseDate(today);
  if (!t || !cadence) return null;
  const day = cadence.releaseDay === 'eom' ? daysInMonth(t.y, t.m) : Number(cadence.releaseDay);
  const back = t.d >= day ? 1 : 2;
  return fromIndex(monthIndex(t) - back);
}

export function freshness(lastPeriod, lastUpdated, cadence, today) {
  const lp = parsePeriod(lastPeriod);
  const period = lp ? `${lp.y}-${pad2(lp.m)}` : null;
  const u = parseDate(lastUpdated);
  const updated = u ? `${pad2(u.m)}-${pad2(u.d)}` : null;
  const exp = parsePeriod(expectedPeriod(cadence, today));
  const lagMonths = lp && exp ? Math.max(0, monthIndex(exp) - monthIndex(lp)) : null;
  return { period, updated, lagMonths };
}

// 브라우저 기준 KST 오늘('YYYY-MM-DD'). 페이지에서 today 인자 생성용.
export function todayKst(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);
}
