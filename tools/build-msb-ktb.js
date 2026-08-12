// MS-1 국고-통안 상대가치 모니터 — 민평 xlsx → data/msb-ktb-nodes.json 빌더 (node, CJS)
//
// [라이선스] 원본 민평 금리·종목별 금리는 산출물에 절대 저장하지 않는다. 저장되는 것은
// 스프레드(bp)와 커버리지 카운트·플래그뿐이다. 원본 xlsx 는 .gitignore(*.xlsx)로 커밋 금지.
//
// 실행:
//   node tools/build-msb-ktb.js                       # data/raw/국고통안.xlsx 사용
//   node tools/build-msb-ktb.js <파일.xlsx>
//   node tools/build-msb-ktb.js --backfill <dir>      # 디렉터리 일괄
//   node tools/build-msb-ktb.js --dump-header <파일>  # 레이아웃 진단(산출물 미변경)
// 옵션:
//   --out <path>   산출 JSON 경로 (기본 data/msb-ktb-nodes.json)
//   --dry-run      계산만 하고 파일에 쓰지 않음
//
// 설계 원칙:
//   - 지표물(on-the-run) 개념을 쓰지 않는다. 종목은 4개 '계보'(M2·M3·K2·K3)로만 나뉘고,
//     계보별 곡선은 끝까지 독립이다. 서로 다른 계보를 한 곡선에 합치지 않는다.
//   - 보간은 인접 2점 local linear 만. 전역 스플라인·다항 금지.
//   - 외삽 전면 금지. 계보별 관측 범위 밖 노드는 null + flags.

const { readFileSync, writeFileSync, existsSync, readdirSync } = require('node:fs');
const { join, resolve, basename, extname } = require('node:path');
const { createRequire } = require('node:module');

const ROOT = join(__dirname, '..');
const DEFAULT_INPUT = join(ROOT, 'data', 'raw', '국고통안.xlsx');
const DEFAULT_OUT = join(ROOT, 'data', 'msb-ktb-nodes.json');

const SCHEMA_VERSION = 2;

// ── 상수 ────────────────────────────────────────────────────────────────────
const NODES = [1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5];
const LINEAGES = ['M2', 'M3', 'K2', 'K3'];
const PAIRS = ['M2_K2', 'M2_K3', 'M3_K2', 'M3_K3'];
const LIQ_KEYS = ['msb', 'ktb', 'delta'];

const DAYS_PER_YEAR = 365.25;
const MIN_TTM = 0.05;      // ttm <= 0.05 제외
const HOLIDAY_EPS = 1e-9;  // 휴일 캐리 판정: 전 종목 변화 절대합
const COVER_DROP = 2;      // 계보 종목수가 전일 대비 이만큼 줄면 flag
const EPS = 1e-9;

// 알려진 조회범위(3810영업일 기준)에서 휴일 캐리를 걷어내면 2556일이 남는다.
// 같은 범위인데 결과가 다르면 전처리가 조용히 어긋난 것이므로 중단한다.
const EXPECT = { rawDays: 3810, validDays: 2556, tol: 5 };

// ── 소수점 안정화 ───────────────────────────────────────────────────────────
// 재실행 zero-diff 를 위해 부동소수 잡음을 고정 자릿수로 잘라낸다.
// 저장 정밀도는 0.1bp. 민평 자체가 0.1bp 단위로 고시되므로 그 아래는 잡음이고,
// 소수 3자리로 두면 2556일치 파일이 불필요하게 커진다.
const round1 = v => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
const nodeLabel = n => n.toFixed(2); // 플래그 키: 1 → "1.00", 2.25 → "2.25"

// ── 보간 ────────────────────────────────────────────────────────────────────
// points: [{ttm, y}] — ttm 오름차순·중복 없음 전제(buildCurve 가 보장).
// 반환: {value, extrap}. 관측 최소/최대 밖이면 value=null, extrap=true (외삽 금지).
function localLinear(points, x) {
  if (!Array.isArray(points) || points.length === 0) return { value: null, extrap: true };
  const lo = points[0], hi = points[points.length - 1];
  if (x < lo.ttm - EPS || x > hi.ttm + EPS) return { value: null, extrap: true };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (x >= a.ttm - EPS && x <= b.ttm + EPS) {
      const span = b.ttm - a.ttm;
      if (span <= EPS) return { value: a.y, extrap: false };
      const w = (x - a.ttm) / span;
      return { value: a.y + w * (b.y - a.y), extrap: false };
    }
  }
  // 단일 점 커브에서 x 가 그 점과 일치하는 경우
  if (Math.abs(x - lo.ttm) <= EPS) return { value: lo.y, extrap: false };
  return { value: null, extrap: true };
}

// bonds: [{code, ttm, y}] → 보간용 커브. 동일 잔존 종목은 평균으로 합산.
function buildCurve(bonds) {
  const byTtm = new Map();
  for (const b of bonds) {
    const key = Math.round(b.ttm * 1e6) / 1e6;
    if (!byTtm.has(key)) byTtm.set(key, []);
    byTtm.get(key).push(b.y);
  }
  return [...byTtm.entries()]
    .map(([ttm, ys]) => ({ ttm, y: ys.reduce((s, v) => s + v, 0) / ys.length }))
    .sort((a, b) => a.ttm - b.ttm);
}

// ── 관측 소실 감시 ──────────────────────────────────────────────────────────
// [이상치 필터를 두지 않는 이유]
// 계보 분리로 원발행만기 오염이 제거된 뒤 남는 계보 내 종목 간 편차는 곡선 기울기
// 자체이므로 이상치 판정 근거가 없다. 앞서 쓰던 '±0.05년 창 15bp 초과 제외' 규칙은
// 실측상 발동 자체가 불가능했다 — ±0.05년 창에 들어온 동일계보 쌍 0건 / 46,905 관측
// (계보별 발행 주기가 3~6개월이라 같은 계보 종목이 18일 안에 겹치지 않는다).
//
// 대신 곡선을 떠받치는 관측이 갑자기 사라지는 쪽만 감시한다. 종목수가 전일 대비
// COVER_DROP 이상 줄면 그날의 보간 구간이 통째로 넓어졌다는 뜻이라 값을 그대로
// 믿으면 안 된다.
function coverDropFlags(cover, prevCover) {
  if (!prevCover) return [];
  return LINEAGES
    .filter(lin => cover[lin] <= (prevCover[lin] ?? 0) - COVER_DROP)
    .map(lin => `cover_drop_${lin}`);
}

// ── 계보 판정 ───────────────────────────────────────────────────────────────
// 통안: 종목명 접미 2자리가 계보. 만기는 해당 월 5일.
// 국고: 종목명으로 계보를 알 수 없다. 만기는 해당 월 10일이고, 계보는 원발행만기
//       (만기 − 최초관측일)로 가른다. 2.5년 미만 = K2, 이상 = K3.
const MSB_RE = /^통안\d+-(\d{2})(\d{2})-(\d{2})$/;
const KTB_RE = /^국고\d+-(\d{2})(\d{2})\(/;
const MSB_LINEAGE = { '02': 'M2', '03': 'M3' };
const KTB_SPLIT_Y = 2.5;

function parseBondName(raw) {
  const s = String(raw == null ? '' : raw).replace(/\s+/g, '');
  let m = MSB_RE.exec(s);
  if (m) return { kind: 'msb', maturity: `20${m[1]}-${m[2]}-05`, suffix: m[3] };
  m = KTB_RE.exec(s);
  if (m) return { kind: 'ktb', maturity: `20${m[1]}-${m[2]}-10`, suffix: null };
  return null;
}

const yearsBetween = (from, to) =>
  (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000 / DAYS_PER_YEAR;

const ktbLineage = (maturity, firstObs) =>
  (yearsBetween(firstObs, maturity) < KTB_SPLIT_Y ? 'K2' : 'K3');

// bond: parseWorkbook 산출물 1건. 계보를 못 정하면 null(집계에서 제외).
function assignLineage(bond) {
  if (bond.kind === 'msb') return MSB_LINEAGE[bond.suffix] || null;
  if (!bond.firstObs) return null;
  return ktbLineage(bond.maturity, bond.firstObs);
}

// ── 입력 파싱 ───────────────────────────────────────────────────────────────
// 인포맥스 종목별 민평 레이아웃: row2=종목명, row3=라벨(일자/수익률), row4~ 데이터.
// 종목당 2열. 라벨 순서(일자 먼저/수익률 먼저)는 조회 설정에 따라 뒤집힐 수 있어
// 위치 고정 대신 아래 별칭 표로 판별한다. 실파일 라벨이 다르면 --dump-header 로
// 확인 후 별칭 표만 넓히면 된다(계산 로직 무변경).
const COLUMN_ALIASES = {
  date: [/^일자$/, /기준일/, /평가일/, /^날짜$/],
  yield: [/민평.*수익률/, /민평.*금리/, /^수익률/, /평가수익률/, /^금리$/, /민평/],
};

const norm = v => String(v == null ? '' : v).replace(/\s+/g, '');
const matchesAny = (text, aliases) => aliases.some(re => re.test(norm(text)));

function matchColumn(header, aliases) {
  for (const re of aliases) {
    const i = header.findIndex(h => re.test(norm(h)));
    if (i >= 0) return i;
  }
  return -1;
}

// 라벨 행: 앞쪽 20행 중 '일자'와 '수익률'이 함께 있는 첫 행.
function findHeaderRow(aoa) {
  const limit = Math.min(aoa.length, 20);
  for (let i = 0; i < limit; i++) {
    const row = (aoa[i] || []).map(norm);
    if (!row.some(Boolean)) continue;
    if (matchColumn(row, COLUMN_ALIASES.date) >= 0 && matchColumn(row, COLUMN_ALIASES.yield) >= 0) return i;
  }
  return -1;
}

// Excel 시리얼(1900 체계) → ISO. 문자열 날짜도 허용.
function toISO(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = Math.round((v - 25569) * 86400000);
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

const toNum = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const n = Number(String(v).replace(/[,\s%]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// aoa → { bonds, dates }. 원본 금리는 여기서만 다루고 산출물로 나가지 않는다.
function parseWorkbook(aoa) {
  const labelRow = findHeaderRow(aoa);
  if (labelRow < 0) throw new Error('라벨 행(일자·수익률)을 찾지 못했습니다. --dump-header 로 확인하세요.');
  if (labelRow < 1) throw new Error('종목명 행이 라벨 행 위에 없습니다.');
  const labels = aoa[labelRow] || [];
  const names = aoa[labelRow - 1] || [];

  const bonds = [];
  const skipped = { unnamed: 0, unparsedName: 0, noLabel: 0 };

  for (let c = 0; c + 1 < Math.max(labels.length, names.length); c += 2) {
    const rawName = names[c] != null && String(names[c]).trim() ? names[c] : names[c + 1];
    if (rawName == null || !String(rawName).trim()) { skipped.unnamed++; continue; }

    const meta = parseBondName(rawName);
    if (!meta) { skipped.unparsedName++; continue; }

    // 어느 열이 일자이고 어느 열이 수익률인지 라벨로 판별
    let dateCol = c, yieldCol = c + 1;
    if (matchesAny(labels[c + 1], COLUMN_ALIASES.date) && matchesAny(labels[c], COLUMN_ALIASES.yield)) {
      dateCol = c + 1; yieldCol = c;
    } else if (!matchesAny(labels[c], COLUMN_ALIASES.date)) {
      skipped.noLabel++; continue;
    }

    const obs = new Map();
    for (let r = labelRow + 1; r < aoa.length; r++) {
      const row = aoa[r];
      if (!row) continue;
      const d = toISO(row[dateCol]);
      if (!d) continue;
      const y = toNum(row[yieldCol]);
      if (y === null) continue;
      obs.set(d, y); // 같은 날짜 중복 입력은 후자 우선(OO-1 파서 관행과 동일)
    }
    if (obs.size === 0) continue;

    const dates = [...obs.keys()].sort();
    bonds.push({
      code: String(rawName).trim(),
      name: String(rawName).trim(),
      kind: meta.kind,
      suffix: meta.suffix,
      maturity: meta.maturity,
      firstObs: dates[0],
      obs,
    });
  }

  const all = new Set();
  for (const b of bonds) for (const d of b.obs.keys()) all.add(d);
  return { bonds, dates: [...all].sort(), skipped, labelRow };
}

// ── 전처리 1: 휴일 캐리 제거 ────────────────────────────────────────────────
// 휴일에도 전일 민평이 그대로 실려 나오는 행이 섞여 있다. 직전 '유효일'(제거되지 않고
// 남은 날) 대비 전 종목 수익률 변화 절대합이 0이면 그날은 캐리로 보고 버린다.
// 직전 원본일이 아니라 직전 유효일과 비교해야 연휴가 3일 이어져도 1일만 남는다.
// 종목 구성이 달라진 날(발행·만기)은 캐리일 수 없으므로 무조건 남긴다.
function removeHolidayCarry(bonds, dates) {
  const kept = [];
  let prev = null;
  for (const d of dates) {
    if (prev === null) { kept.push(d); prev = d; continue; }
    let sum = 0, comparable = 0, setDiff = false;
    for (const b of bonds) {
      const a = b.obs.get(prev), c = b.obs.get(d);
      if ((a === undefined) !== (c === undefined)) { setDiff = true; break; }
      if (a !== undefined) { sum += Math.abs(c - a); comparable++; }
    }
    if (setDiff || comparable === 0 || sum >= HOLIDAY_EPS) { kept.push(d); prev = d; }
  }
  return kept;
}

// ── 일자 단위 계산 ──────────────────────────────────────────────────────────
// bonds: parseWorkbook 산출물(계보 부여 완료). prevCover: 직전 유효일의 cover(없으면 null).
// 반환: 스키마 v2 의 series[date] 레코드
function computeDay(bonds, date, prevCover = null) {
  const flags = [];

  // 전처리 2: ttm 산출 + 초단기 제외
  const byLineage = Object.fromEntries(LINEAGES.map(k => [k, []]));
  for (const b of bonds) {
    if (!b.lineage) continue;
    const y = b.obs.get(date);
    if (y === undefined) continue;
    const ttm = yearsBetween(date, b.maturity);
    if (!(ttm > MIN_TTM + EPS)) continue;
    byLineage[b.lineage].push({ code: b.code, ttm, y });
  }

  const curves = {}, cover = {};
  for (const key of LINEAGES) {
    curves[key] = buildCurve(byLineage[key]);
    cover[key] = byLineage[key].length;
  }
  flags.push(...coverDropFlags(cover, prevCover));

  // 노드별 계보 곡선값(%). 관측 범위 밖이면 null + flag.
  const level = Object.fromEntries(LINEAGES.map(k => [k, []]));
  for (const node of NODES) {
    for (const key of LINEAGES) {
      const r = localLinear(curves[key], node);
      if (r.extrap) flags.push(`extrap_${key}_${nodeLabel(node)}`);
      level[key].push(r.value);
    }
  }

  const diffBp = (a, b) => (a === null || b === null ? null : round1((a - b) * 100));

  const sp = {};
  for (const pair of PAIRS) {
    const [x, y] = pair.split('_');
    sp[pair] = NODES.map((_, i) => diffBp(level[x][i], level[y][i]));
  }

  const liq = {
    msb: NODES.map((_, i) => diffBp(level.M3[i], level.M2[i])),
    ktb: NODES.map((_, i) => diffBp(level.K3[i], level.K2[i])),
    delta: [],
  };
  liq.delta = NODES.map((_, i) =>
    (liq.msb[i] === null || liq.ktb[i] === null ? null : round1(liq.msb[i] - liq.ktb[i])));

  // adj 는 저장된(반올림된) sp·liq.delta 로 계산한다. 원값으로 계산해 나중에 반올림하면
  // 파일 안에서 adj !== sp - liq.delta 가 되어 읽는 쪽이 버그로 오해한다.
  const adj = {};
  for (const pair of PAIRS) {
    adj[pair] = NODES.map((_, i) =>
      (sp[pair][i] === null || liq.delta[i] === null ? null : round1(sp[pair][i] - liq.delta[i])));
  }

  return {
    sp,
    liq,
    adj,
    cover: { M2: cover.M2, M3: cover.M3, K2: cover.K2, K3: cover.K3 },
    flags: [...new Set(flags)].sort(),
  };
}

// ── 파이프라인 ──────────────────────────────────────────────────────────────
// aoa → { series, stats }. 전처리 순서 고정: 휴일 캐리 → ttm 필터 → 이상치.
function buildSeries(aoa) {
  const { bonds, dates, skipped } = parseWorkbook(aoa);
  if (bonds.length === 0) throw new Error('유효 종목 0건 — 종목명 형식을 확인하세요.');

  const warnings = [];
  const panelFirst = dates[0];
  for (const b of bonds) {
    b.lineage = assignLineage(b);
    if (!b.lineage) warnings.push(`계보 판정 불가(집계 제외): ${b.code}`);
    // 조회범위 시작에 걸친 국고는 최초관측일이 발행일이 아니라 조회 시작일이라
    // 원발행만기가 실제보다 짧게 잡힌다. 절단은 만기를 '짧게'만 만들므로 오분류 방향은
    // K3 → K2 한쪽뿐이다. 이미 K3 로 잡혔다면 실제 원발행만기는 그보다 더 길어 판정이
    // 뒤집힐 수 없다. 그래서 K2 로 떨어진 종목만 경고한다.
    else if (b.kind === 'ktb' && b.firstObs === panelFirst && b.lineage === 'K2') {
      warnings.push(`원발행만기 절단 의심(조회 시작일에 이미 존재, K3 가 K2 로 내려갔을 수 있음): ${b.code}`);
    }
  }

  const validDates = removeHolidayCarry(bonds, dates);
  const stats = {
    bonds: bonds.length,
    rawDays: dates.length,
    validDays: validDates.length,
    lineage: Object.fromEntries(LINEAGES.map(k => [k, bonds.filter(b => b.lineage === k).length])),
    skipped,
    warnings,
  };

  // cover_drop 은 직전 '유효일'과의 비교다 — 캐리로 지워진 날은 건너뛴 상태로 이어진다.
  const series = {};
  let prevCover = null;
  for (const d of validDates) {
    series[d] = computeDay(bonds, d, prevCover);
    prevCover = series[d].cover;
  }
  return { series, stats };
}

// 알려진 조회범위일 때만 하드 게이트. 범위가 다르면 경고만 하고 통과시킨다.
function checkDayCount(stats) {
  if (Math.abs(stats.rawDays - EXPECT.rawDays) > EXPECT.tol) {
    return { ok: true, message: `조회범위가 기준(${EXPECT.rawDays}일)과 다름: raw=${stats.rawDays} valid=${stats.validDays} — 일수 게이트 skip` };
  }
  if (Math.abs(stats.validDays - EXPECT.validDays) > EXPECT.tol) {
    return { ok: false, message: `휴일 캐리 제거 결과가 기대치를 벗어남: ${stats.rawDays}일 → ${stats.validDays}일 (기대 ${EXPECT.validDays}±${EXPECT.tol})` };
  }
  return { ok: true, message: `일수 게이트 통과: ${stats.rawDays}일 → ${stats.validDays}일` };
}

// ── 스키마 I/O ──────────────────────────────────────────────────────────────
function emptyDoc() {
  return { schema_version: SCHEMA_VERSION, nodes: [...NODES], pairs: [...PAIRS], series: {} };
}

function readDoc(path) {
  if (!existsSync(path)) return emptyDoc();
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  if (doc.schema_version !== SCHEMA_VERSION) {
    throw new Error(`스키마 버전 불일치: ${doc.schema_version} (기대 ${SCHEMA_VERSION})`);
  }
  if (!doc.series) doc.series = {};
  return doc;
}

// 해당 날짜 키만 갱신/추가. 다른 날짜는 값·순서 모두 불변(일자 오름차순 재직렬화).
function upsertDates(doc, records) {
  const next = { ...emptyDoc(), series: { ...doc.series, ...records } };
  const sorted = {};
  for (const k of Object.keys(next.series).sort()) sorted[k] = next.series[k];
  next.series = sorted;
  return next;
}

const upsertDate = (doc, date, record) => upsertDates(doc, { [date]: record });

// 수치 배열은 한 줄로 눕힌다. 2556일 × 11배열 × 7개를 JSON.stringify(,,2) 로 쓰면
// 값 하나가 한 줄씩 차지해 파일이 수십 MB 로 불어나고 diff 를 읽을 수 없다.
const inline = arr => '[' + arr.map(v => (v === null ? 'null' : JSON.stringify(v))).join(',') + ']';
const inlineObj = (obj, keys) => '{' + keys.map(k => `"${k}": ${inline(obj[k])}`).join(', ') + '}';

function serialize(doc) {
  const out = ['{'];
  out.push(`  "schema_version": ${doc.schema_version},`);
  out.push(`  "nodes": ${inline(doc.nodes)},`);
  out.push(`  "pairs": ${inline(doc.pairs)},`);
  out.push('  "series": {');
  const dates = Object.keys(doc.series).sort();
  dates.forEach((d, i) => {
    const r = doc.series[d];
    out.push(`    ${JSON.stringify(d)}: {`);
    out.push(`      "sp": ${inlineObj(r.sp, PAIRS)},`);
    out.push(`      "liq": ${inlineObj(r.liq, LIQ_KEYS)},`);
    out.push(`      "adj": ${inlineObj(r.adj, PAIRS)},`);
    out.push(`      "cover": ${JSON.stringify(r.cover)},`);
    out.push(`      "flags": ${inline(r.flags)}`);
    out.push(`    }${i < dates.length - 1 ? ',' : ''}`);
  });
  out.push('  }');
  out.push('}');
  return out.join('\n') + '\n';
}

// ── 파일 읽기 ───────────────────────────────────────────────────────────────
// xlsx 는 내부가 UTF-8 이라 인코딩 이슈가 없다. 인포맥스가 EUC-KR csv 로 내려주는
// 경우를 대비해 csv 는 euc-kr 로 디코딩한다(BOM 있으면 utf-8 로 판단).
function readAoa(path) {
  const buf = readFileSync(path);
  const ext = extname(path).toLowerCase();
  if (ext === '.csv' || ext === '.txt') {
    const utf8 = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    const text = new TextDecoder(utf8 ? 'utf-8' : 'euc-kr').decode(buf);
    return text.replace(/\r\n?/g, '\n').split('\n').filter(l => l.length)
      .map(line => line.split(',').map(c => c.replace(/^"|"$/g, '')));
  }
  const require2 = createRequire(__filename);
  const XLSX = require2('../vendor/xlsx.min.js');
  const wb = XLSX.read(buf, { type: 'buffer', codepage: 949 });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) throw new Error(`시트를 찾지 못했습니다: ${path}`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = { inputs: [], out: DEFAULT_OUT, dryRun: false, dumpHeader: null, backfill: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--backfill') opts.backfill = argv[++i];
    else if (a === '--out') opts.out = resolve(argv[++i]);
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--dump-header') opts.dumpHeader = argv[++i];
    else if (a.startsWith('--')) throw new Error(`알 수 없는 옵션: ${a}`);
    else opts.inputs.push(a);
  }
  return opts;
}

function dumpHeader(path) {
  const aoa = readAoa(path);
  const labelRow = findHeaderRow(aoa);
  console.log(`라벨 행 index: ${labelRow}`);
  if (labelRow < 1) {
    for (let i = 0; i < Math.min(aoa.length, 10); i++) console.log(i, JSON.stringify((aoa[i] || []).slice(0, 12)));
    return;
  }
  console.log('종목명 행:', JSON.stringify((aoa[labelRow - 1] || []).slice(0, 8)));
  console.log('라벨 행  :', JSON.stringify((aoa[labelRow] || []).slice(0, 8)));
  console.log('첫 데이터:', JSON.stringify((aoa[labelRow + 1] || []).slice(0, 8)));
  const { bonds, dates, skipped } = parseWorkbook(aoa);
  console.log(`종목 ${bonds.length}건 / 일자 ${dates.length}건 / skip ${JSON.stringify(skipped)}`);
  const panelFirst = dates[0];
  for (const b of bonds.slice(0, 5)) {
    console.log(`  ${b.code}  만기=${b.maturity}  최초관측=${b.firstObs}  계보=${assignLineage(b)}`);
  }
  console.log(`  (조회 시작일 ${panelFirst})`);
}

function main(argv) {
  const opts = parseArgs(argv);

  if (opts.dumpHeader) { dumpHeader(resolve(opts.dumpHeader)); return 0; }

  let files = opts.inputs.map(f => resolve(f));
  if (opts.backfill) {
    const dir = resolve(opts.backfill);
    files = files.concat(
      readdirSync(dir)
        .filter(f => /\.(xlsx|csv)$/i.test(f) && !f.startsWith('~$'))
        .sort()
        .map(f => join(dir, f)),
    );
  }
  if (files.length === 0) {
    if (!existsSync(DEFAULT_INPUT)) {
      console.error(`❌ 입력 파일이 없습니다: ${DEFAULT_INPUT}`);
      console.error('   사용법: node tools/build-msb-ktb.js [파일.xlsx] | --backfill <dir> | --dump-header <파일>');
      return 1;
    }
    files = [DEFAULT_INPUT];
  }

  let doc = readDoc(opts.out);
  let touched = 0;

  for (const file of files) {
    const { series, stats } = buildSeries(readAoa(file));
    console.log(`■ ${basename(file)}`);
    console.log(`  종목 ${stats.bonds}건  계보 ${JSON.stringify(stats.lineage)}`);
    for (const w of stats.warnings) console.warn(`  ⚠ ${w}`);

    const gate = checkDayCount(stats);
    console.log(`  ${gate.ok ? '✓' : '✖'} ${gate.message}`);
    if (!gate.ok) throw new Error(gate.message);

    doc = upsertDates(doc, series);
    touched += Object.keys(series).length;
  }

  if (touched === 0) { console.error('❌ 반영된 일자가 없습니다.'); return 1; }
  if (opts.dryRun) { console.log(`(dry-run) ${touched}일 계산, 파일 미변경`); return 0; }

  writeFileSync(opts.out, serialize(doc), 'utf8');
  console.log(`→ ${opts.out} (${touched}일 갱신, 총 ${Object.keys(doc.series).length}일)`);
  return 0;
}

module.exports = {
  NODES, LINEAGES, PAIRS, LIQ_KEYS, SCHEMA_VERSION, EXPECT,
  MIN_TTM, COVER_DROP, KTB_SPLIT_Y, DAYS_PER_YEAR,
  localLinear, buildCurve, coverDropFlags,
  parseBondName, assignLineage, ktbLineage, yearsBetween,
  findHeaderRow, matchColumn, COLUMN_ALIASES, parseWorkbook, removeHolidayCarry,
  computeDay, buildSeries, checkDayCount,
  emptyDoc, readDoc, upsertDate, upsertDates, serialize, readAoa,
  toISO, toNum, parseArgs, main, DEFAULT_INPUT, DEFAULT_OUT,
};

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error('❌ ' + err.message);
    process.exit(1);
  }
}
