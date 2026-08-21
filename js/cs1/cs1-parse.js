// cs1-parse.js — CS-1 크레딧 섹터 스프레드 모니터의 순수 파싱·계산부.
//
// 입력은 composite xlsx 의 `yield` 시트(원데이터)뿐이다. Excel 파생인 `spread` 시트와
// `Sheet4` 는 읽지 않는다 — 모든 스프레드를 여기서 원수익률로부터 직접 계산한다.
// (사전 대조: spread 시트 값 == yield 파생값, 최근 300영업일 × 전 시리즈 52,800셀 불일치 0.
//  즉 이 규칙에 정확도 비용은 없고, Excel 수식 층에 대한 의존만 끊어진다.)
//
// [열 순서 불변 아님] 소스는 시리즈가 추가될 때마다 열이 통째로 밀린다(2026-08 산금·중금이
//   국고 바로 뒤로 삽입되며 실제로 밀렸다). 그래서 열 인덱스를 일절 하드코딩하지 않고
//   수식 행의 `BONDAVG\d+` 를 스캔해 블록을 발견한다. 행 위치(수식 행·라벨 행)도 같은 이유로
//   발견형이다.
//
// [블록 경계] 수식 2번째 인자의 범위(`M18:W18`)가 그 시리즈의 출력 폭이다. 국고 블록만
//   범위에 일자 열(A)이 끼어 12칸이므로 "수식열 + 11" 같은 산술은 국고에서 깨진다.
//   범위 안에서 다시 만기 라벨 패턴에 맞는 열만 취하는 것이 유일하게 안전한 방법이다.
//   범위를 못 읽으면 다음 수식 열 직전까지를 경계로 삼는다(퇴화 입력 방어).
//
// [단위·정밀도] 소스 수익률은 %, 0.001%(=0.1bp) 격자. 스프레드는 bp 로만 내보내며
//   (시리즈 − 국고) × 100 을 **계산 시점에** 소수 1자리로 반올림한다. 직렬화 시점 반올림은
//   금지 — 그러면 부동소수 노이즈가 파생 계산에 그대로 전파된다.
//   섹터 간 페어도 원수익률 차에서 한 번만 반올림한다. 이미 반올림된 두 vs-국고 값을 빼면
//   반올림이 두 번 겹쳐 최대 0.1bp 가 어긋난다(국고가 상쇄되므로 수학적으로는 동치).
//
// [원수익률 미저장] 산출물에는 bp 스프레드만 담는다. 레벨은 어디에도 쓰지 않는다.
// [보간 없음] 결측은 null 그대로 두고 통계에서 제외한다. 채우지 않는다.

// ── 상수 ──

/** 국고 블록 식별 코드. 이게 없으면 스프레드를 정의할 수 없으므로 명시적으로 실패한다. */
export const KTB_CODE = 'BONDAVG01';

/** 수식 행·라벨 행을 찾을 때 훑는 최대 행수. 소스는 17~18행이지만 위치를 가정하지 않는다. */
export const SCAN_ROWS = 60;

/** 일자 열의 Excel 시리얼 하한(1990-01-01 근처). 빈 행·머리글 행을 데이터에서 걸러낸다. */
const MIN_SERIAL = 30000;

/** pairId 구분자. 섹터명에 '-'(회사채AA-)가 들어가므로 하이픈은 쓸 수 없다. */
export const VS = '_vs_';

/**
 * 섹터 간 페어 — 발행금리를 볼 때 국고 대비만으로는 답이 안 나오는 비교들.
 * 값 = (x 스프레드) − (y 스프레드) = x 수익률 − y 수익률.
 * 여기 없는 조합은 만들지 않는다(측정 화면이지 조합 탐색기가 아니다).
 */
export const CROSS_PAIRS = [
  { x: '산금채AAA', y: '은행채AAA' },
  { x: '중금채AAA', y: '은행채AAA' },
  { x: '산금채AAA', y: '공사채AAA' },
  { x: '중금채AAA', y: '공사채AAA' },
  { x: '은행채AAA', y: '공사채AAA' },
];

// ── 소형 유틸 (공유 파일을 import 하지 않고 CS-1 안에 둔다 — 규칙 5) ──

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Excel 시리얼(1900 체계) → 'YYYY-MM-DD'. UTC 일단위 반올림으로 TZ 아티팩트를 지운다. */
export function serialToISO(serial) {
  const days = Math.round(serial) - 25569;
  return new Date(days * 86400000).toISOString().slice(0, 10);
}

/** 'AI' → 34. 열 문자 → 0-기반 인덱스. */
export function colToIdx(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) {
    const d = ch.charCodeAt(0) - 64;
    if (d < 1 || d > 26) return -1;
    n = n * 26 + d;
  }
  return n - 1;
}

/** %p 차 → bp, 소수 1자리. 어느 한쪽이라도 수가 아니면 null(결측 전파). */
export function toBp1(a, b) {
  if (!isNum(a) || !isNum(b)) return null;
  const v = Math.round((a - b) * 1000) / 10;
  return Object.is(v, -0) ? 0 : v;
}

/**
 * 만기 라벨 정규화. '3월이하(당일)' → { label:'3월', years:0.25 }.
 * 라벨 접미(이하/(당일))는 표시용 군더더기라 떼고, 기존 credit-spread 의 만기 표기와
 * 같은 형태로 맞춘다('3월','1.5년','10년'). 만기가 아니면 null → 일자 열 등이 걸러진다.
 */
export function parseTenor(label) {
  const m = /^(\d+(?:\.\d+)?)\s*(월|년)/.exec(String(label ?? '').trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return { label: m[1] + m[2], years: m[2] === '월' ? n / 12 : n };
}

// ── 레이아웃 발견 ──

/**
 * 수식 행과 만기 라벨 행의 위치를 찾는다.
 * @param {object} p
 * @param {Array<Array<string|null|undefined>>} p.formulaRows  formulaRows[r][c] = 수식 문자열
 * @param {Array<Array<*>>} p.aoa  값 AOA (header:1, raw:true)
 * @returns {{ formulaRowIdx:number, labelRowIdx:number, formulaRow:Array, labelRow:Array }}
 * @throws 수식 행 또는 만기 라벨 행을 못 찾으면
 */
export function findLayout({ formulaRows, aoa }) {
  const limit = Math.min(SCAN_ROWS, Math.max(formulaRows.length, aoa.length));
  let formulaRowIdx = -1;
  for (let r = 0; r < limit; r++) {
    const row = formulaRows[r];
    if (row && row.some((f) => f && /BONDAVG\d+/.test(String(f)))) { formulaRowIdx = r; break; }
  }
  if (formulaRowIdx < 0) throw new Error('yield 시트에서 BONDAVG 수식 행을 찾지 못했습니다. 소스 시트가 맞는지 확인하세요.');

  // 라벨 행은 보통 수식 바로 다음 줄이지만 위치를 가정하지 않고, 뒤 몇 줄 중
  // 만기 라벨이 가장 많은 행을 고른다.
  let labelRowIdx = -1, best = 0;
  for (let r = formulaRowIdx + 1; r < Math.min(formulaRowIdx + 5, aoa.length); r++) {
    const n = (aoa[r] || []).filter((v) => parseTenor(v)).length;
    if (n > best) { best = n; labelRowIdx = r; }
  }
  if (labelRowIdx < 0) throw new Error(`수식 행(${formulaRowIdx + 1}행) 뒤에서 만기 라벨 행을 찾지 못했습니다.`);

  return { formulaRowIdx, labelRowIdx, formulaRow: formulaRows[formulaRowIdx] || [], labelRow: aoa[labelRowIdx] || [] };
}

/**
 * 수식 행을 스캔해 시리즈 블록을 만든다. 열 인덱스는 전부 여기서 발견된다.
 * @param {object} p
 * @param {Array} p.formulaRow  수식 행 (인덱스 = 열)
 * @param {Array} p.labelRow    만기 라벨 행
 * @param {Object<string,string>} [p.codeNames]  index 시트의 코드→이름 (Title= 없을 때 fallback)
 * @returns {{ blocks:Array, skipped:Array }}
 *   blocks[i] = { code, name, c0, c1, cols:[{ col, tenor, years }] }
 */
export function extractBlocks({ formulaRow, labelRow, codeNames = {} }) {
  // 1) 수식이 있는 열과 그 코드·표시명·범위를 뽑는다.
  const found = [];
  for (let c = 0; c < formulaRow.length; c++) {
    const f = formulaRow[c];
    if (f == null || f === '') continue;
    const s = String(f);
    const code = (s.match(/BONDAVG\d+/) || [])[0];
    if (!code) continue;
    // Title=<이름> 이 spread 시트 헤더·기존 credit-spread 섹터명과 정확히 일치한다.
    // index 시트 이름('금융채 산금채 AAA')은 표기가 달라 fallback 으로만 쓴다.
    const title = (s.match(/Title=([^,)"&]+)/) || [])[1];
    // 2번째 인자의 출력 범위(`M18:W18`) — 같은 행 번호로 끝나는 A1 범위.
    const rng = s.match(/\b([A-Z]{1,3})(\d+):([A-Z]{1,3})\2\b/);
    found.push({
      col: c, code,
      name: (title && title.trim()) || codeNames[code] || code,
      r0: rng ? colToIdx(rng[1]) : -1,
      r1: rng ? colToIdx(rng[3]) : -1,
    });
  }

  // 2) 블록 경계: 수식이 준 범위가 1순위. 없으면 다음 수식 열 직전까지.
  const blocks = [], skipped = [], usedNames = new Set();
  for (let i = 0; i < found.length; i++) {
    const cur = found[i];
    const nextCol = i + 1 < found.length ? found[i + 1].col : labelRow.length;
    const hasRange = cur.r0 >= 0 && cur.r1 >= cur.r0;
    const c0 = hasRange ? cur.r0 : cur.col;
    const c1 = hasRange ? cur.r1 : nextCol - 1;

    // 3) 범위 안에서 만기 라벨인 열만 취한다. 국고 블록의 일자 열(A)이 여기서 떨어진다.
    const cols = [];
    const seen = new Set();
    for (let c = c0; c <= c1 && c < labelRow.length; c++) {
      const t = parseTenor(labelRow[c]);
      if (!t || seen.has(t.label)) continue;
      seen.add(t.label);
      cols.push({ col: c, tenor: t.label, years: t.years });
    }
    if (!cols.length) { skipped.push({ code: cur.code, name: cur.name, reason: '범위 안에 만기 라벨 없음' }); continue; }

    // 이름 충돌(같은 표시명 두 블록)은 코드를 덧붙여 구분한다 — 조용히 덮어쓰지 않는다.
    let name = cur.name;
    if (usedNames.has(name)) name = `${name}(${cur.code})`;
    usedNames.add(name);

    blocks.push({ code: cur.code, name, c0, c1, cols });
  }
  return { blocks, skipped };
}

// ── 스프레드 산출 ──

/**
 * 블록 + 데이터 행 → vs-국고 스프레드와 섹터 간 페어.
 * @param {object} p
 * @param {Array} p.blocks  extractBlocks 결과
 * @param {Array<Array<*>>} p.rows  라벨 행 다음부터의 AOA 행 (빈 행 포함 가능)
 * @param {Array} [p.crossPairs]  섹터 간 페어 정의 (기본 CROSS_PAIRS)
 * @returns {{ dates, tenors, tenorYears, sectors, codes, series, seriesOrder, crossMissing }}
 * @throws 국고 블록이 없으면
 */
export function buildSpreads({ blocks, rows, crossPairs = CROSS_PAIRS }) {
  const ktb = blocks.find((b) => b.code === KTB_CODE);
  if (!ktb) {
    throw new Error(
      `국고 블록(${KTB_CODE})을 찾지 못했습니다. 발견된 코드: ${blocks.map((b) => b.code).join(', ') || '(없음)'}. ` +
      '국고 없이는 스프레드를 정의할 수 없어 중단합니다.'
    );
  }

  // 만기 축은 국고 블록 기준(전 섹터 동일 격자). 연수 오름차순.
  const tenorList = ktb.cols.slice().sort((a, b) => a.years - b.years);
  const tenors = tenorList.map((t) => t.tenor);
  const tenorYears = tenorList.map((t) => t.years);
  const ktbColOf = new Map(ktb.cols.map((t) => [t.tenor, t.col]));

  const credit = blocks.filter((b) => b !== ktb);

  // 데이터 행: A열이 Excel 시리얼인 행만. 소스 !ref 가 빈 행 10만 줄까지 잡고 있어 반드시 걸러야 한다.
  const dates = [];
  const dataRows = [];
  for (const row of rows) {
    const a = row && row[0];
    if (!isNum(a) || a < MIN_SERIAL) continue;
    dates.push(serialToISO(a));
    dataRows.push(row);
  }

  const series = {}, seriesOrder = [];
  const emptyCol = () => new Array(dataRows.length).fill(null);

  // vs-국고
  for (const b of credit) {
    const id = b.name + VS + ktb.name;
    const byTenor = {};
    const colOf = new Map(b.cols.map((t) => [t.tenor, t.col]));
    for (const tenor of tenors) {
      const sc = colOf.get(tenor), kc = ktbColOf.get(tenor);
      if (sc == null || kc == null) { byTenor[tenor] = emptyCol(); continue; } // 해당 만기 미제공 → null 유지
      const out = new Array(dataRows.length);
      for (let i = 0; i < dataRows.length; i++) out[i] = toBp1(dataRows[i][sc], dataRows[i][kc]);
      byTenor[tenor] = out;
    }
    series[id] = byTenor;
    seriesOrder.push(id);
  }

  // 섹터 간 — 원수익률 차에서 한 번만 반올림(반올림 이중 적용 회피).
  const byName = new Map(blocks.map((b) => [b.name, b]));
  const crossMissing = [];
  for (const { x, y } of crossPairs) {
    const bx = byName.get(x), by = byName.get(y);
    if (!bx || !by) { crossMissing.push({ x, y, missing: [!bx && x, !by && y].filter(Boolean) }); continue; }
    const id = x + VS + y;
    const xc = new Map(bx.cols.map((t) => [t.tenor, t.col]));
    const yc = new Map(by.cols.map((t) => [t.tenor, t.col]));
    const byTenor = {};
    for (const tenor of tenors) {
      const a = xc.get(tenor), b = yc.get(tenor);
      if (a == null || b == null) { byTenor[tenor] = emptyCol(); continue; }
      const out = new Array(dataRows.length);
      for (let i = 0; i < dataRows.length; i++) out[i] = toBp1(dataRows[i][a], dataRows[i][b]);
      byTenor[tenor] = out;
    }
    series[id] = byTenor;
    seriesOrder.push(id);
  }

  return {
    dates, tenors, tenorYears,
    sectors: blocks.map((b) => b.name),
    codes: Object.fromEntries(blocks.map((b) => [b.name, b.code])),
    series, seriesOrder, crossMissing,
  };
}

// ── 직렬화 ──

/**
 * data/cs1/spreads.json 문자열. 수치 배열은 한 줄로 눕힌다 — 21페어 × 11만기 × 2,866일을
 * JSON.stringify(,,2) 로 쓰면 파일이 수십 MB가 되고 diff 가 읽히지 않는다.
 * 값은 이미 buildSpreads 에서 반올림된 상태다(여기서 다시 손대지 않는다).
 */
export function serialize(doc) {
  const inline = (arr) => '[' + arr.map((v) => (v == null ? 'null' : String(v))).join(',') + ']';
  const out = [];
  out.push('{');
  out.push('  "meta": ' + JSON.stringify(doc.meta) + ',');
  out.push('  "dates": [' + doc.dates.map((d) => JSON.stringify(d)).join(',') + '],');
  out.push('  "series": {');
  const ids = doc.meta.seriesOrder;
  ids.forEach((id, i) => {
    out.push('    ' + JSON.stringify(id) + ': {');
    const tn = doc.meta.tenors;
    tn.forEach((t, j) => {
      out.push('      ' + JSON.stringify(t) + ': ' + inline(doc.series[id][t]) + (j === tn.length - 1 ? '' : ','));
    });
    out.push('    }' + (i === ids.length - 1 ? '' : ','));
  });
  out.push('  }');
  out.push('}');
  return out.join('\n') + '\n';
}
