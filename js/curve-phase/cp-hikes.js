// cp-hikes.js — 인상 사이클 마커 도출(CP-Q3c). 순수 함수·정적 상수, ES module. DOM·fetch 없음.
//   오버레이(cp-overlay) 위에 '개별 인상 결정'을 마커로 얹기 위한 좌표·크기·심볼 도출.
//   단위 규약: 금리 %(원자료), 인상폭 bp(=%p×100). y좌표는 오버레이 기울기 bp(라인 위에 안착).
//   KR: 기준금리 계열에서 인상을 도출(계단 상승) — isFinal = '다음 변경이 인하'.
//   US: 목표범위 상단이 원자료에 없어 정적 상수(US_HIKE_RUNS) — rateAfter = 상단(%).
//     (EFFR 점프 도출은 상단과 불일치·노이즈 → 설계상 하드코딩. 사이클 id 로 키.)

// ── 마커 크기: 인상폭(bp)에 비례. 25→7 · 50→10 · 75→13. base 4 로 0bp 도 가시. ──
export const hikeMarkerSize = (bp) => 4 + 0.12 * bp;

// ── KR 인상 도출: baseArr([{date,rate}] 오름차순)에서 rate 상승 지점을 인상으로. ──
//   각 인상: rateAfter = 인상 후 기준금리(%), bp = 인상폭, isFinal = 다음 '변경'이 인하이면 true.
//   (다음 변경이 또 인상이면 false. 뒤에 변경이 없으면 — 현재 진행 사이클 — false.)
export function deriveKRHikes(baseArr) {
  // 변경점 인덱스(값이 직전과 다른 지점) 수집.
  const chg = [];
  for (let i = 1; i < baseArr.length; i++) {
    if (baseArr[i].rate !== baseArr[i - 1].rate) chg.push(i);
  }
  const out = [];
  for (let k = 0; k < chg.length; k++) {
    const i = chg[k];
    const prev = baseArr[i - 1].rate, cur = baseArr[i].rate;
    if (cur <= prev) continue; // 인하·동결 제외
    const nextChg = chg[k + 1];
    const isFinal = nextChg != null && baseArr[nextChg].rate < baseArr[nextChg - 1].rate;
    out.push({
      date: baseArr[i].date,
      rateAfter: cur,
      bp: Math.round((cur - prev) * 100),
      isFinal,
    });
  }
  return out;
}

// ── US 인상 런(정적): 사이클 id → [{date, rateAfter(상단%), bp(인상폭), isFinal}] ──
//   출처: FOMC 결정일·목표(범위 상단). 창(T−120~T+250) 밖 인상은 toRelativeX 가 자동 제외하므로
//   각 런은 해당 사이클 창을 덮는 범위만 수록. isFinal 은 '다음 정책변경이 인하'인 인상에만 true.
//   1994 는 범위제 이전(단일 목표) — 그 목표를 상단으로 취급.
export const US_HIKE_RUNS = {
  '1994': [
    { date: '1994-02-04', rateAfter: 3.25, bp: 25, isFinal: false },
    { date: '1994-03-22', rateAfter: 3.50, bp: 25, isFinal: false },
    { date: '1994-04-18', rateAfter: 3.75, bp: 25, isFinal: false },
    { date: '1994-05-17', rateAfter: 4.25, bp: 50, isFinal: false },
    { date: '1994-08-16', rateAfter: 4.75, bp: 50, isFinal: false },
    { date: '1994-11-15', rateAfter: 5.50, bp: 75, isFinal: false },
    { date: '1995-02-01', rateAfter: 6.00, bp: 50, isFinal: true }, // 다음 변경 = 인하(1995-07-06)
  ],
  '2015': [
    { date: '2015-12-16', rateAfter: 0.50, bp: 25, isFinal: false }, // 다음 변경 = 인상(2016-12-14)
  ],
  '2016': [
    { date: '2016-12-14', rateAfter: 0.75, bp: 25, isFinal: false },
    { date: '2017-03-15', rateAfter: 1.00, bp: 25, isFinal: false },
    { date: '2017-06-14', rateAfter: 1.25, bp: 25, isFinal: false },
    { date: '2017-12-13', rateAfter: 1.50, bp: 25, isFinal: false }, // 런은 2018 로 지속 → isFinal 아님
  ],
  '2022': [
    { date: '2022-03-16', rateAfter: 0.50, bp: 25, isFinal: false },
    { date: '2022-05-04', rateAfter: 1.00, bp: 50, isFinal: false },
    { date: '2022-06-15', rateAfter: 1.75, bp: 75, isFinal: false },
    { date: '2022-07-27', rateAfter: 2.50, bp: 75, isFinal: false },
    { date: '2022-09-21', rateAfter: 3.25, bp: 75, isFinal: false },
    { date: '2022-11-02', rateAfter: 4.00, bp: 75, isFinal: false },
    { date: '2022-12-14', rateAfter: 4.50, bp: 50, isFinal: false },
    { date: '2023-02-01', rateAfter: 4.75, bp: 25, isFinal: false },
    { date: '2023-03-22', rateAfter: 5.00, bp: 25, isFinal: false }, // 런은 2023-07 로 지속 → isFinal 아님
  ],
};

// 전체 US 인상(런 무관, 날짜순). KR(deriveKRHikes)과 대칭 — 각 사이클 창에 '모든' 인상을 매핑한다.
//   (사이클별 키로 스코프하면 이웃 사이클 인상이 창에 들어와도 누락된다. 예: 2015 창의 T+249=2016-12-14.)
export const usHikesFlat = () =>
  Object.values(US_HIKE_RUNS).flat().slice().sort((a, b) => (a.date < b.date ? -1 : 1));

// ── 인상일(달력) → 오버레이 상대좌표. points = eventAligned 결과 [{offset,date,bp}]. ──
//   해당일 이상(첫 거래일) 포인트로 매핑(계단, carry-forward). 창(pre~post) 밖이면 null → 마커 제외.
//   반환 { offset, y }(y = 그 세션의 기울기 bp → 마커가 라인 위에 안착) 또는 null.
export function toRelativeX(points, date) {
  if (!points || !points.length) return null;
  if (date > points[points.length - 1].date) return null; // 창 오른쪽(T+250) 밖
  if (date < points[0].date) return null;                 // 창 왼쪽(T−120) 밖
  const p = points.find((q) => q.date >= date);
  return p ? { offset: p.offset, y: p.bp } : null;
}

// ── 한 사이클의 마커 스펙 = 오버레이 points × 인상 목록. 창 밖 인상은 제외. ──
//   승인 ③: T=0(offset 0) 첫 인상 마커는 표시하지 않는다 — T=0 세로 점선과 중복이므로 제외.
//   반환 [{date, offset, y, size, isFinal, rateAfter, hikeBp}]. 빈 배열이면 호출부가 trace skip.
export function buildHikeMarkers(points, hikes) {
  const out = [];
  for (const h of hikes || []) {
    const rel = toRelativeX(points, h.date);
    if (!rel || rel.offset === 0) continue; // offset 0 = T=0 첫 인상 → 제외(승인 ③)
    out.push({
      date: h.date,
      offset: rel.offset,
      y: rel.y,
      size: hikeMarkerSize(h.bp),
      isFinal: !!h.isFinal,
      rateAfter: h.rateAfter,
      hikeBp: h.bp,
    });
  }
  return out;
}
