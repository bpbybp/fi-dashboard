// credit-parse.js — composite xlsx → data/credit-spread.js 파싱·직렬화·검증 공유 모듈.
// 브라우저(admin)와 node(tools/convert-composite.mjs)가 모두 import → 바이트 동일 산출 보장.
// 환경 무관: 파일 I/O·XLSX 로드는 호출자 담당, 이 모듈은 SheetJS AOA만 입력받는다.
//
// [노드 발견형] 만기 노드를 데이터(17행 헤더)에서 발견한다. 만기 문자열 → 연 단위:
//   'N월' → N/12 (3월=0.25, 6월=0.5, 9월=0.75) / 'N년' → N (1.5년=1.5, 10년=10).
//   신규 만기 추가 시 코드 무수정으로 흡수(발견형). 산출 스키마는 평면 컬럼형 유지
//   (series['섹터_만기']) — 기존 소비 코드 무회귀. meta에 nodes(숫자)·maturities(라벨) 부가.
//
// [정밀도] 민평 스프레드 그리드 0.1bp(=%p 3자리) → 3자리 반올림값이 참값. 날짜는 Excel
//   시리얼을 UTC 일단위 반올림으로 변환(TZ 아티팩트 제거). 이 두 규칙이 양 환경 동일해야 diff 0.

// 기대 섹터(국고 포함 17) — 구조 변화(섹터 추가/개명)를 조용히 통과시키지 않기 위한 고정 집합.
//
// 2026-08-21: 소스 xlsx에 산금채AAA(BONDAVG16)·중금채AAA(BONDAVG18)가 국고 바로 뒤로
//   삽입되면서 이후 전 열이 밀렸고, 이 집합이 15로 고정돼 있어 `섹터 수 17 ≠ 15`로
//   인제스트가 막혀 있었다(커브 RV 일일 갱신 실패). 두 섹터는 2015-01-02부터 전 구간
//   무결측이므로 그대로 수록한다. 고정 집합 방식 자체는 유지 — 다음 열 변동도 똑같이
//   조용히 통과시키지 않고 여기서 멈추는 것이 이 게이트의 목적이다.
export const EXPECTED_SECTORS = [
  '국고채권', '산금채AAA', '중금채AAA', '공사채AAA', '은행채AAA', '회사채AAA', '회사채AA+', '카드채AA+',
  '회사채AA0', '카드채AA0', '회사채AA-', '여전채AA-', '회사채A+', '여전채A+', '회사채A0', '여전채A0',
  '회사채BBB+',
];

// Excel 시리얼(1900) → 'YYYY-MM-DD' (UTC 일 반올림)
export function serialToISO(serial) {
  const days = Math.round(serial) - 25569;
  return new Date(days * 86400000).toISOString().slice(0, 10);
}

// 민평 호가 그리드(0.1bp=%p 3자리) 정규화 — 부동소수점 노이즈 제거
export const round3 = v =>
  (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * 1000) / 1000 : null;

// 만기 라벨 → 연 단위 숫자. 'N월'→N/12, 'N년'(소수 허용)→N. 그 외 null.
export function maturityToYears(label) {
  const s = String(label).trim();
  let m = s.match(/^(\d+)월$/);
  if (m) return parseInt(m[1], 10) / 12;
  m = s.match(/^(\d+(?:\.\d+)?)년$/);
  if (m) return parseFloat(m[1]);
  return null;
}

// 라벨 '섹터_만기' → { sector, mat } (마지막 '_' 기준 — 섹터명엔 '_' 없음)
function splitLabel(label) {
  const i = label.lastIndexOf('_');
  return i < 0 ? { sector: label, mat: '' } : { sector: label.slice(0, i), mat: label.slice(i + 1) };
}

// --- 파싱: SheetJS AOA(header:1, raw:true) → 평면 컬럼형 + 발견 노드 ---
// 반환: { cols:[{idx,label}], sectors, nodes(숫자 오름차순), maturities(라벨, node순), dates, series }
export function parseAoa(aoa) {
  const header = aoa[16] || []; // 17행 헤더
  const cols = [];
  for (let c = 1; c < header.length; c++) {
    const label = header[c];
    if (label != null && label !== '') cols.push({ idx: c, label: String(label) });
  }
  const sectors = [...new Set(cols.map(c => splitLabel(c.label).sector))];

  // 만기 노드 발견 (라벨→연수). 라벨↔연수 매핑 보존.
  const matToYr = new Map();
  for (const c of cols) {
    const { mat } = splitLabel(c.label);
    if (!matToYr.has(mat)) matToYr.set(mat, maturityToYears(mat));
  }
  const uniqYears = [...new Set([...matToYr.values()].filter(y => y != null))].sort((a, b) => a - b);
  // node순 만기 라벨(대표 1개씩) — 표시/메타용
  const yearToMat = new Map();
  for (const [mat, yr] of matToYr) if (yr != null && !yearToMat.has(yr)) yearToMat.set(yr, mat);
  const maturities = uniqYears.map(y => yearToMat.get(y));

  const dates = [];
  const series = {};
  for (const c of cols) series[c.label] = [];
  for (let r = 17; r < aoa.length; r++) {
    const a = aoa[r] && aoa[r][0];
    if (typeof a !== 'number' || a < 40000) continue;
    dates.push(serialToISO(a));
    for (const c of cols) series[c.label].push(round3(aoa[r][c.idx]));
  }
  return { cols, sectors, nodes: uniqYears, maturities, dates, series };
}

// --- 직렬화: data/credit-spread.js (평면 컬럼형 + meta.nodes/maturities) ---
export function serialize({ cols, sectors, nodes, maturities, dates, series }) {
  const meta = {
    source: 'composite-xlsx',
    last_updated: dates[dates.length - 1],
    sectors,
    maturities,     // 라벨(node 오름차순): ['3월','6월',...,'10년']
    nodes,          // 숫자(연): [0.25,0.5,0.75,1,1.5,2,2.5,3,4,5,10]
  };
  return (
    'window.FENRIR_SERIES = window.FENRIR_SERIES || {};\n' +
    'window.FENRIR_SERIES["credit-spread"] = {\n' +
    '  meta: ' + JSON.stringify(meta) + ',\n' +
    '  dates: ' + JSON.stringify(dates) + ',\n' +
    '  series: {\n' +
    cols.map(c => '    ' + JSON.stringify(c.label) + ': ' + JSON.stringify(series[c.label])).join(',\n') +
    '\n  }\n};\n'
  );
}

// --- 구조 검증 (노드 발견형 불변식) ---
// 고정 라벨 수가 아니라 '갱신돼도 참인' 구조 불변식 검사. 실패 시 Error(위치 포함).
const MIN_ROWS = 2832;
const MIN_LAST_DATE = '2026-07-01';
const MIN_NODES = 5;
const KTB_RANGE = [0, 20];      // 국고 금리 %
const CREDIT_RANGE = [-1, 15];  // 크레딧 스프레드 %p
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateStructure(parsed) {
  const { cols, sectors, nodes, dates, series } = parsed;
  const fail = m => { throw new Error('구조 검증 실패: ' + m); };

  // 1) 섹터: 정확히 EXPECTED 15(국고 포함)와 집합 일치 (추가/개명/누락 시 명시적 실패)
  if (sectors.length !== EXPECTED_SECTORS.length)
    fail(`섹터 수 ${sectors.length} ≠ ${EXPECTED_SECTORS.length}`);
  const secSet = new Set(sectors), wantSec = new Set(EXPECTED_SECTORS);
  const secMissing = EXPECTED_SECTORS.filter(s => !secSet.has(s));
  const secExtra = sectors.filter(s => !wantSec.has(s));
  if (secMissing.length) fail(`섹터 누락: ${secMissing.join(', ')}`);
  if (secExtra.length) fail(`예상 밖 섹터: ${secExtra.join(', ')}`);

  // 2) 노드: ≥MIN_NODES, 각 노드 연수 매핑 가능, 전 섹터 동일 노드셋
  if (nodes.length < MIN_NODES) fail(`노드 수 ${nodes.length} < ${MIN_NODES}`);
  for (const c of cols) {
    const { mat } = splitLabel(c.label);
    if (maturityToYears(mat) == null) fail(`만기 라벨 연수 매핑 불가: '${c.label}' (mat='${mat}')`);
  }
  const nodeSetOf = (sec) => new Set(cols.filter(c => splitLabel(c.label).sector === sec)
    .map(c => maturityToYears(splitLabel(c.label).mat)));
  const refNodes = nodeSetOf(sectors[0]);
  if (refNodes.size !== nodes.length) fail(`대표 섹터 노드 수 ${refNodes.size} ≠ 발견 노드 ${nodes.length}`);
  for (const s of sectors) {
    const ns = nodeSetOf(s);
    if (ns.size !== refNodes.size) fail(`섹터 '${s}' 노드 수 ${ns.size} ≠ ${refNodes.size} (노드셋 불일치)`);
    for (const y of refNodes) if (!ns.has(y)) fail(`섹터 '${s}' 노드 ${y}년 누락 (전 섹터 동일 노드셋 위반)`);
  }

  // 3) 날짜: 행수·파싱·중복·오름차순·최신
  if (dates.length < MIN_ROWS) fail(`행수 ${dates.length} < ${MIN_ROWS}`);
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    if (!DATE_RE.test(d) || Number.isNaN(Date.parse(d))) fail(`날짜 파싱 불가: 행 ${i} '${d}'`);
    if (i > 0) {
      if (d === dates[i - 1]) fail(`중복 날짜: ${d} (행 ${i})`);
      if (d < dates[i - 1]) fail(`날짜 역순: ${dates[i - 1]} → ${d} (행 ${i})`);
    }
  }
  const last = dates[dates.length - 1];
  if (last < MIN_LAST_DATE) fail(`최신 날짜 ${last} < ${MIN_LAST_DATE}`);

  // 4) 값 범위 + 비null ≥ 50%
  const n = dates.length;
  for (const c of cols) {
    const arr = series[c.label];
    const isKtb = splitLabel(c.label).sector === '국고채권';
    const [lo, hi] = isKtb ? KTB_RANGE : CREDIT_RANGE;
    let nn = 0;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (v == null) continue;
      nn++;
      if (v < lo || v > hi)
        fail(`값 범위 위반: ${c.label} @ ${dates[i]} = ${v} (허용 ${lo}~${hi}${isKtb ? '%' : '%p'})`);
    }
    if (nn / n < 0.5) fail(`비null 비율 ${(nn / n * 100).toFixed(0)}% < 50%: ${c.label}`);
  }

  const lastVal = arr => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return arr[i]; return null; };
  return {
    rows: n, first: dates[0], last,
    sectors: sectors.length, cols: cols.length, nodes: nodes.length, nodeList: nodes,
    ktb3: lastVal(series['국고채권_3년']),
    gsAAA3: lastVal(series['공사채AAA_3년']),
  };
}
