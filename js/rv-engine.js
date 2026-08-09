// rv-engine.js — 상대가치 판별 엔진(결정론적 계산). 순수 함수, Node 테스트 가능.
//   판별 로직 스펙:
//   · 기준수익률 = 발행사 커브의 잔존만기 인접 두 점 선형보간. 외삽 금지(첫점 이전/끝점 이후 → null).
//     보간 구간 내 결측은 유효 인접 두 점으로 대체(present 테너만 점으로 사용).
//   · 폴백: 발행사 매칭 성공이나 커브 보간 불가 → 그 발행사의 그룹 대표커브(00000). '그룹 폴백'.
//           발행사 매칭 실패 → issuer_raw를 채권그룹명과 매칭 → 그룹 대표커브. '그룹 폴백'.
//           둘 다 실패 → 매칭 실패.
//   · 잔존연수 = (만기일 − 오늘)/365.25 (기준일=오늘 단순화).

export const TENOR_YEARS = {
  '3M': 0.25, '6M': 0.5, '9M': 0.75, '1Y': 1, '1.5Y': 1.5, '2Y': 2, '2.5Y': 2.5,
  '3Y': 3, '4Y': 4, '5Y': 5, '7Y': 7, '10Y': 10, '15Y': 15, '20Y': 20, '30Y': 30,
};

export function residualYears(maturityDate, todayStr) {
  if (!maturityDate) return null;
  const ms = new Date(maturityDate + 'T00:00:00') - new Date(todayStr + 'T00:00:00');
  const y = ms / (365.25 * 864e5);
  return Number.isFinite(y) ? y : null;
}

// 선형보간. 외삽 금지 → 범위 밖이면 null. present 테너만 점으로 사용(결측 자동 스킵).
export function interpolate(curve, ry) {
  if (!curve || ry == null) return null;
  const pts = Object.entries(curve)
    .map(([t, v]) => [TENOR_YEARS[t], v])
    .filter((p) => p[0] != null && Number.isFinite(p[1]))
    .sort((a, b) => a[0] - b[0]);
  if (!pts.length) return null;
  if (ry < pts[0][0] || ry > pts[pts.length - 1][0]) return null; // 외삽 금지
  for (const [x, v] of pts) if (x === ry) return v;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    if (ry > x0 && ry < x1) return y0 + (y1 - y0) * (ry - x0) / (x1 - x0);
  }
  return null;
}

const stripSpecial = (s) => String(s).replace(/[\s()（）·\-_.,/]/g, '');
// issuer_raw ↔ 채권그룹명 매칭(발행사 실패 시 폴백용). exact→정규화→포함.
export function matchGroupName(raw, groupCurves) {
  if (!raw) return null;
  if (groupCurves[raw]) return raw;
  const nr = stripSpecial(raw);
  if (nr.length < 2) return null;
  const keys = Object.keys(groupCurves);
  for (const k of keys) if (stripSpecial(k) === nr) return k;
  for (const k of keys) if (k.length >= 2 && k.includes(raw)) return k;
  return null;
}

// 호가의 유효 수익률(원괴리 계산용). 원(won) 스프레드는 듀레이션 필요 → Phase 4.
//
// ── B-6 수정 (2026-08-05) ──────────────────────────────────────────────────
// 이전 마지막 분기는 `return { y: 민평, basis: '민평flat' }` 이었다. 즉 민평만 있으면
// spread_type 이 무엇이든(폴백 flat 이든 null 이든) "민평에 판다"로 확정했다.
// parseSpread 의 폴백 flat 제거만으로는 부족하다 — spread_type 이 null 로 바뀌어도
// 여기서 다시 민평flat 이 되기 때문이다. **flat 은 명시 flat 일 때만 인정한다.**
export function quoteYield(q) {
  if (q.actual_yield != null) return { y: q.actual_yield, basis: 'actual' };
  if (q.minpyeong_yield != null) {
    if (q.spread_type === 'bp') return { y: q.minpyeong_yield + (q.spread_value || 0) / 100, basis: '민평+bp' };
    if (q.spread_type === 'absolute') return { y: q.spread_value, basis: 'absolute' };
    if (q.spread_type === 'won') return { y: null, basis: '원(듀레이션 필요)' };
    if (q.spread_type === 'flat') return { y: q.minpyeong_yield, basis: '민평flat' };
    return { y: null, basis: '미상(레벨없음)' }; // 민평은 있으나 호가 레벨이 없다(B-6)
  }
  if (q.spread_type === 'absolute') return { y: q.spread_value, basis: 'absolute' };
  return { y: null, basis: '미상' };
}

// 발행사 매칭 + 기준수익률 해석. matchIssuerFn 주입(발행사 canonical 재계산 — 민평 로드시점 무관).
export function resolveReference(q, mp, aliases, abbreviations, matchIssuerFn, todayStr) {
  const ry = residualYears(q.maturity_date, todayStr);

  // 발행사 canonical 매칭(현재 민평 기준 재계산)
  let canonical = null, matchType = null;
  if (matchIssuerFn && aliases && aliases.length) {
    const m = matchIssuerFn(q.issuer_raw, aliases, abbreviations);
    if (m) { canonical = m.canonical; matchType = m.match_type; }
  }

  if (ry == null) return { method: canonical ? 'issuer' : 'unmatched', refYield: null, ry: null, canonical, matchType, reason: '만기 미상' };

  // 1. 발행사 커브
  if (canonical && mp.issuers[canonical]) {
    const iss = mp.issuers[canonical];
    const r = interpolate(iss.curve, ry);
    if (r != null) return { method: 'issuer', refYield: r, ry, group: iss.group, canonical, matchType };
    const gc = mp.groupCurves[iss.group];
    const gr = gc ? interpolate(gc.curve, ry) : null;
    if (gr != null) return { method: 'group_fallback', refYield: gr, ry, group: iss.group, canonical, matchType, note: '발행사 커브 보간불가→그룹' };
    return { method: 'issuer', refYield: null, ry, group: iss.group, canonical, matchType, reason: '기준없음(외삽/결측)' };
  }

  // 2. 발행사 매칭 실패 → 그룹명 매칭
  const g = matchGroupName(q.issuer_raw, mp.groupCurves);
  if (g) {
    const gr = interpolate(mp.groupCurves[g].curve, ry);
    if (gr != null) return { method: 'group_fallback', refYield: gr, ry, group: g, note: '발행사 매칭 실패→그룹명' };
    return { method: 'group_fallback', refYield: null, ry, group: g, reason: '기준없음(외삽)' };
  }

  // 3. 완전 실패
  return { method: 'unmatched', refYield: null, ry };
}

// 매칭률 + 내장민평 대비 보간 diff 분포(Phase 4 괴리구조 결정용).
export function computeStats(rows) {
  const n = rows.length;
  const by = { issuer: 0, group_fallback: 0, unmatched: 0 };
  let noRef = 0;
  for (const { ref } of rows) {
    if (ref.method === 'issuer') by.issuer++;
    else if (ref.method === 'group_fallback') by.group_fallback++;
    else by.unmatched++;
    if (ref.refYield == null && ref.method !== 'unmatched') noRef++;
  }
  const withEmb = rows.filter((r) => r.q.minpyeong_yield != null);
  const diffs = rows
    .filter((r) => r.q.minpyeong_yield != null && r.ref.refYield != null)
    .map((r) => (r.q.minpyeong_yield - r.ref.refYield) * 100);
  diffs.sort((a, b) => a - b);
  const median = diffs.length
    ? (diffs.length % 2 ? diffs[(diffs.length - 1) / 2] : (diffs[diffs.length / 2 - 1] + diffs[diffs.length / 2]) / 2)
    : null;
  const maxAbs = diffs.length ? Math.max(...diffs.map((d) => Math.abs(d))) : null;
  const over15 = diffs.filter((d) => Math.abs(d) > 15).length;
  return {
    n, by, noRef,
    embeddedCount: withEmb.length, embeddedPct: n ? (withEmb.length / n) * 100 : 0,
    diffN: diffs.length, diffMedian: median, diffMaxAbs: maxAbs, diffOver15: over15, diffs,
  };
}

// 민평 issuers → matchIssuer용 aliases 배열
export function buildAliases(mp) {
  return Object.keys(mp.issuers).map((name) => ({ canonical: name, aliases: [name] }));
}
