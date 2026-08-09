// cv-matrix.js — CV-3 스프레드 변화 매트릭스 (측정만 한다).
//
// 질문 두 개를 표 하나로 답한다:
//   가로(행) 읽기 = 같은 섹터에서 어느 만기의 스프레드가 상대적으로 빨리 움직이나
//   세로(열) 읽기 = 같은 만기에서 어느 섹터의 스프레드가 상대적으로 빨리 움직이나
//
// 셀 = Δ스프레드(bp) = 현재 − h영업일 전. 데이터(credit-spread)가 영업일 격자이므로
//   h 는 그대로 행 오프셋이다. 색은 0 중심 대칭 — +확대=적색 / −축소=청색,
//   농도는 매트릭스 전체 max|Δ| 대비 상대 크기(그래야 "상대적으로"가 셀 간 비교가 된다).
//
// v1 은 원시 Δbp (스펙 확정 2026-08-07). z250 정규화("이 속도가 이 섹터에선 흔한가")는
//   v2 결정 항목으로 보류. 국고채권 행은 제외 — 그 시리즈는 스프레드가 아니라 레벨(%)이다.
// 판단·시그널 텍스트 없음.

export const CV3_HORIZONS = [
  { key: '1w', label: '1주', biz: 5 },
  { key: '1m', label: '1개월', biz: 20 },
  { key: '3m', label: '3개월', biz: 60 },
];

const LS_KEY = 'cv3-horizon';
const num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Δ 매트릭스 계산 (순수).
 * @param {object} data  FENRIR_SERIES['credit-spread'] — { meta, dates, series }
 * @param {number} biz   과거 오프셋(영업일 = 행 수)
 * @returns {{ asof:string, baseDate:string, sectors:string[], mats:string[],
 *             cells:(number|null)[][], maxAbs:number }|null}
 *   cells[si][mi] = Δbp(소수 1자리). 현재/과거 어느 쪽이든 결측이면 null.
 *   이력이 부족하면(과거 인덱스 음수) 전체 null 반환.
 */
export function buildChangeMatrix(data, biz) {
  const { meta, series, dates } = data;
  const t = dates.length - 1;
  const b = t - biz;
  if (b < 0) return null;
  const sectors = meta.sectors.filter((s) => s !== '국고채권');
  const cells = sectors.map((sec) => meta.maturities.map((m) => {
    const arr = series[`${sec}_${m}`];
    const cur = arr ? arr[t] : null;
    const prev = arr ? arr[b] : null;
    if (!num(cur) || !num(prev)) return null;
    return Math.round((cur - prev) * 1000) / 10; // %p → bp, 0.1bp 반올림
  }));
  let maxAbs = 0;
  for (const row of cells) for (const v of row) {
    if (v != null && Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
  }
  return { asof: dates[t], baseDate: dates[b], sectors, mats: meta.maturities, cells, maxAbs };
}

/** 셀 배경 농도(%) — |Δ|/max 비례, 보이는 최소 6%, 상한 78%. Δ=0 또는 max=0 이면 0. */
export function cellAlphaPct(v, maxAbs) {
  if (v == null || v === 0 || !maxAbs) return 0;
  return Math.min(78, Math.max(6, Math.round((Math.abs(v) / maxAbs) * 78)));
}

// ── 렌더 ──────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const signed1 = (v) => (v > 0 ? '+' : '') + v.toFixed(1);

function tableHtml(M) {
  if (!M) return '<div class="note">이력이 부족해 이 호라이즌을 계산할 수 없습니다.</div>';
  const headTh = M.mats.map((m) => `<th>${esc(m)}</th>`).join('');
  const rows = M.sectors.map((sec, si) => {
    const tds = M.cells[si].map((v) => {
      if (v == null) return '<td class="nil">·</td>';
      const pct = cellAlphaPct(v, M.maxAbs);
      const colorVar = v > 0 ? '--cv3-pos' : '--cv3-neg';
      const bg = pct ? ` style="background:color-mix(in srgb, var(${colorVar}) ${pct}%, transparent)"` : '';
      return `<td${bg}>${signed1(v)}</td>`;
    }).join('');
    return `<tr><th>${esc(sec)}</th>${tds}</tr>`;
  }).join('');
  return `<div class="cv3-asof">기준 ${esc(M.asof)} − ${esc(M.baseDate)} · 단위 bp · 최대 |Δ| ${M.maxAbs.toFixed(1)}</div>
    <div class="cv3-wrap"><table class="cv3-table">
      <thead><tr><th></th>${headTh}</tr></thead><tbody>${rows}</tbody>
    </table></div>`;
}

export function initChangeMatrix() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const data = window.FENRIR_SERIES && window.FENRIR_SERIES['credit-spread'];
  const host = document.getElementById('cv3-panel');
  const seg = document.getElementById('cv3-horizon');
  if (!data || !host || !seg) return;

  let hzKey = '1m';
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (CV3_HORIZONS.some((h) => h.key === saved)) hzKey = saved;
  } catch { /* 저장 실패는 무시 */ }

  function render() {
    const hz = CV3_HORIZONS.find((h) => h.key === hzKey) || CV3_HORIZONS[1];
    host.innerHTML = tableHtml(buildChangeMatrix(data, hz.biz));
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.hz === hzKey));
  }

  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-hz]');
    if (!b) return;
    hzKey = b.dataset.hz;
    try { localStorage.setItem(LS_KEY, hzKey); } catch { /* 무시 */ }
    render();
  });

  render();
}
