// series-merge.js — 저장된 월간 이력(기준) + 업로드(증분) 병합. DOM 무관 순수 모듈.
//
// 원칙: 저장 이력이 기준이고 업로드는 증분이다. 업로드만으로 data 파일을 재생성하면
// 장기 이력이 업로드 구간(예: 15개월)으로 대체된다 — admin CPI 사고의 원인.
// 병합이 이상해 보이면(기준년 개편 의심·공백·축소) 조용히 진행하지 않고 던진다.

export const REVISION_WARN_PT = 0.3;      // 개정 폭이 이 값(지수 pt)을 넘으면 경고 목록에 올림
const REVISION_EPS = 1e-9;                // 이 이하 차이는 동일 값으로 본다
const REBASE_DIFF_SHARE = 0.5;            // 겹치는 달 중 |차이| > REVISION_WARN_PT 비중이 이 이상이면 개편 의심
const REBASE_RATIO_RANGE = 5e-4;          // 비율(업로드/기존) 범위가 이 미만이면 "거의 일정" (둘째 자리 반올림 노이즈 ~1e-4 흡수)
const REBASE_RATIO_OFF = 1e-3;            // 평균 비율이 1에서 이만큼 벗어나야 개편 (값 동일 = 비율 1 일정은 제외)
const REBASE_MIN_OVERLAP = 2;             // 이보다 겹침이 적으면 개편 판정 불가(경고만)

const MONTH_RE = /^(\d{4})[\/.\-](\d{1,2})$/;

// 'YYYY-MM' | 'YYYY-M' | 'YYYY/MM' | 'YYYY.MM' → 'YYYY-MM'. 해석 불가면 던진다.
export function normalizeMonthKey(raw) {
  const m = String(raw ?? '').trim().match(MONTH_RE);
  const month = m ? Number(m[2]) : 0;
  if (!m || month < 1 || month > 12) throw new Error(`월 키를 해석할 수 없음: "${raw}"`);
  return `${m[1]}-${String(month).padStart(2, '0')}`;
}

function shiftMonth(key, n) {
  const [y, m] = key.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

// 점 배열 → Map(정규화 월 → 값). 같은 달이 여러 번이면 마지막 값.
function toMonthMap(points, label) {
  const map = new Map();
  for (const p of points) {
    const key = normalizeMonthKey(p?.period);
    const v = p?.value;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label} ${key} 값이 숫자가 아님: ${v}`);
    map.set(key, v);
  }
  return map;
}

function rebaseReason(pairs) {
  const big = pairs.filter(([, e, u]) => Math.abs(u - e) > REVISION_WARN_PT).length;
  if (big / pairs.length >= REBASE_DIFF_SHARE) {
    return `겹치는 ${pairs.length}개월 중 ${big}개월이 ${REVISION_WARN_PT}pt 초과 차이`;
  }
  const ratios = pairs.map(([, e, u]) => u / e);
  const range = Math.max(...ratios) - Math.min(...ratios);
  const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  if (range < REBASE_RATIO_RANGE && Math.abs(mean - 1) > REBASE_RATIO_OFF) {
    return `겹치는 ${pairs.length}개월의 업로드/기존 비율이 ${mean.toFixed(4)}로 거의 일정`;
  }
  return null;
}

// existing: 저장 이력, upload: 업로드 점 배열 (둘 다 [{ period, value }]).
// 반환: { series, stats: { kept, added, revised, maxRevision }, revisions, warnings }
//   revisions: [{ period, old, new, diff }] — 값이 바뀐 겹치는 달 전부
//   warnings:  [{ kind: 'revision', period, old, new, diff, message }]  |  [{ kind: 'overlap', overlap, message }]
export function mergeSeries(existing, upload) {
  if (!Array.isArray(existing) || existing.length === 0) {
    throw new Error('기존 이력이 없습니다 — 저장된 data 파일을 읽지 못하면 병합하지 않습니다.');
  }
  if (!Array.isArray(upload) || upload.length === 0) throw new Error('업로드 데이터가 없습니다.');

  const exMap = toMonthMap(existing, '기존');
  const upMap = toMonthMap(upload, '업로드');

  const exLast = [...exMap.keys()].sort().at(-1);
  const upFirst = [...upMap.keys()].sort()[0];
  const expectedNext = shiftMonth(exLast, 1);
  if (upFirst > expectedNext) {
    throw new Error(`${expectedNext}~${shiftMonth(upFirst, -1)} 누락 — 업로드가 기존 마지막 달(${exLast}) 다음 달부터 이어지지 않습니다.`);
  }

  const pairs = [...upMap].filter(([k]) => exMap.has(k)).map(([k, u]) => [k, exMap.get(k), u]);
  const warnings = [];
  if (pairs.length < REBASE_MIN_OVERLAP) {
    warnings.push({
      kind: 'overlap',
      overlap: pairs.length,
      message: pairs.length === 0 ? '겹침 없음, 기준년 변경 판정 불가' : '겹침 1개월, 기준년 변경 판정 불가',
    });
  } else {
    const reason = rebaseReason(pairs);
    if (reason) throw new Error(`기준년 변경 의심 — ${reason}. 병합을 중단합니다.`);
  }

  const revisions = pairs
    .filter(([, e, u]) => Math.abs(u - e) > REVISION_EPS)
    .map(([period, e, u]) => ({ period, old: e, new: u, diff: u - e }))
    .sort((a, b) => (a.period < b.period ? -1 : 1));
  for (const r of revisions) {
    if (Math.abs(r.diff) > REVISION_WARN_PT) {
      warnings.push({ kind: 'revision', ...r, message: `${r.period} 개정 ${r.diff >= 0 ? '+' : ''}${r.diff.toFixed(3)}pt` });
    }
  }

  const merged = new Map([...exMap, ...upMap]);
  const keys = [...merged.keys()].sort();
  for (let i = 1; i < keys.length; i++) {
    const want = shiftMonth(keys[i - 1], 1);
    if (keys[i] !== want) throw new Error(`${want}~${shiftMonth(keys[i], -1)} 누락 — 병합 결과에 빈 달이 있습니다.`);
  }
  if (keys.length < existing.length) {
    throw new Error(`병합 결과 개월 수(${keys.length})가 기존 개월 수(${existing.length})보다 적습니다 — 중단.`);
  }

  const added = [...upMap.keys()].filter((k) => !exMap.has(k)).length;
  return {
    series: keys.map((period) => ({ period, value: merged.get(period) })),
    stats: {
      kept: exMap.size - revisions.length,
      added,
      revised: revisions.length,
      maxRevision: revisions.reduce((mx, r) => Math.max(mx, Math.abs(r.diff)), 0),
    },
    revisions,
    warnings,
  };
}
