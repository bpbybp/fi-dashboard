// csv-parse.js — KOSIS 소비자물가지수 wide-format CSV 파서 (브라우저용).
//
// KOSIS CSV 형태:
//   통계표,계정항목,단위,가중치,변환,1965/01,1965/02,...,2026/05
//   "4.2.1. 소비자물가지수","총지수","2020=100","1000","원자료","2.493",...
//
// 앞 5개 = 메타 컬럼, 그 뒤 = 'YYYY/MM' 기간 컬럼.
// 데이터 행마다 계정항목/단위/변환으로 시리즈를 구분.

const META_COLS = 5; // 통계표, 계정항목, 단위, 가중치, 변환

// CSV 한 줄 파싱 (따옴표 안 콤마 처리, KOSIS는 필드 내 개행 없음).
function parseLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// 'YYYY/MM' 또는 'YYYY.MM' → 'YYYY-MM'. 아니면 null.
function normalizePeriod(raw) {
  const s = raw.trim();
  const m = s.match(/^(\d{4})[\/.\-](\d{1,2})$/);
  if (!m) return null;
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;
}

// 반환: { periods: ['1965-01', ...], rows: [{ account, unit, weight, transform, points: [{period,value}] }] }
export function parseKosisCsv(text) {
  // BOM 제거
  const clean = text.replace(/^\uFEFF/, '');
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('CSV에 데이터 행이 없습니다.');
  }

  const header = parseLine(lines[0]);
  // 기간 컬럼 인덱스 매핑
  const periodCols = [];
  for (let i = META_COLS; i < header.length; i++) {
    const p = normalizePeriod(header[i]);
    if (p) periodCols.push({ idx: i, period: p });
  }
  if (periodCols.length === 0) {
    throw new Error('기간 컬럼(YYYY/MM)을 찾지 못했습니다. KOSIS 원본 형식이 맞는지 확인하세요.');
  }

  const rows = [];
  for (let r = 1; r < lines.length; r++) {
    const cells = parseLine(lines[r]);
    if (cells.length < META_COLS) continue;
    const account = (cells[1] || '').trim();
    const unit = (cells[2] || '').trim();
    const weight = (cells[3] || '').trim();
    const transform = (cells[4] || '').trim();

    const points = [];
    for (const { idx, period } of periodCols) {
      const raw = (cells[idx] || '').trim();
      if (raw === '' || raw === '-') continue;
      const v = parseFloat(raw);
      if (Number.isFinite(v)) points.push({ period, value: v });
    }
    if (points.length === 0) continue;
    rows.push({ account, unit, weight, transform, points });
  }

  if (rows.length === 0) {
    throw new Error('유효한 데이터 행이 없습니다.');
  }

  return {
    periods: periodCols.map((p) => p.period),
    rows,
  };
}

// 힌트(account/transform)로 특정 행 자동 매칭. 없으면 null.
// KOSIS 계정항목 라벨은 공백 변형이 있을 수 있어(예: "식료품 및 에너지 제외지수"
// vs 힌트 "식료품및에너지제외지수") 비교 전 모든 공백을 제거해 정규화한다.
// 총지수처럼 공백이 없는 라벨은 정규화해도 동일하므로 헤드라인 매칭에는 영향 없음.
// KOSIS 특수분류 CSV 는 라벨 끝에 각주 번호가 붙는다("생활물가지수 4)"). 끝 각주를 떼지 않으면
// 매칭이 실패해 수동 선택으로 넘어가고, 거기서 총지수 행이 골라져 생활물가 이력이 오염됐다(66652f9).
export function normKey(s) {
  return (s || '').replace(/\s*\d+\)\s*$/, '').replace(/\s+/g, '');
}
export function matchRow(parsed, hint) {
  if (!hint) return null;
  const wantAccount = hint.account ? normKey(hint.account) : null;
  const wantTransform = hint.transform ? normKey(hint.transform) : null;
  return parsed.rows.find((row) => {
    const okAccount = !wantAccount || normKey(row.account) === wantAccount;
    const okTransform = !wantTransform || normKey(row.transform) === wantTransform;
    return okAccount && okTransform;
  }) ?? null;
}
