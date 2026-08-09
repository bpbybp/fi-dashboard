// onoff-parse.js — 인포맥스 종목별 민평 xlsx → 세대별 파생 스프레드(bp) 변환 공유 모듈.
// 브라우저(onoff-admin)와 node(tools/convert-onoff.mjs)가 모두 import → 바이트 동일 산출.
// 환경 무관: 파일 I/O·XLSX 로드는 호출자 담당, 이 모듈은 SheetJS AOA만 입력받는다. DOM 접근 금지.
//
// [데이터 라이선스] 민평 수익률은 유료 벤더 데이터 → 원본 수익률은 절대 직렬화하지 않는다.
// parseAoa 는 메모리상에서만 원본을 다루고, deriveGenerations 가 즉시 세대별 스프레드(bp)로
// 변환한다. 커밋되는 data/onoff-ktb3y.js 에는 파생 스프레드만 담긴다(원본 재배포 아님).
//
// [방법론] 국고 3년 지표물은 6/12월 교체(신지표가 구지표보다 만기 6개월 김). 세대 = 지표물 한 대(代).
//   raw   = [y(지표) − y(구지표)]                        (커브상 인접 스프레드)
//   slope = [y(구지표) − y(구구지표)]                    (한 칸 더 과거 구간의 기울기)
//   fly   = raw − slope                                   (커브조정 상대가치, 단위 bp)
// fly<0: 지표물 리치(정상). fly>0: 지표물 저평가(이례).
//
// [정밀도] 민평 그리드가 0.1bp이므로 스프레드는 0.1bp(소수1자리)로 정규화한다. 원본 double의
// 부동소수점 노이즈는 (a−b)*100 후 round1 로 제거된다. 날짜는 Excel 시리얼을 UTC 일단위
// 반올림으로 변환해 TZ 아티팩트를 없앤다(credit-parse.js 와 동일 규칙).

export const TENOR = '3Y';

// Excel 시리얼(1900 date system) → 'YYYY-MM-DD' (UTC, 일 단위 반올림)
export function serialToISO(serial) {
  const days = Math.round(serial) - 25569; // 25569 = 1970-01-01 의 Excel 시리얼
  return new Date(days * 86400000).toISOString().slice(0, 10);
}

// 스프레드 bp 를 0.1bp 그리드로 정규화(부동소수점 노이즈 제거)
export const round1 = v =>
  (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * 10) / 10 : null;

// 토·일 여부 (민평은 주말 캐리오버 → 제거). ISO 문자열을 UTC 로 해석해 로컬 TZ 영향 배제.
export function isWeekend(iso) {
  const g = new Date(iso + 'T00:00:00Z').getUTCDay();
  return g === 0 || g === 6;
}

// 종목명 → { coupon, maturity:'YYYY-MM', tag }.  예: '국고03500-2906(26-5)'
//   03500 → coupon 3.500 | 2906 → 만기 2029-06 | (26-5) → tag '26-5'
export function parseName(name) {
  const m = String(name).match(/^국고(\d{5})-(\d{2})(\d{2})\((\d{2}-\d+)\)/);
  if (!m) return null;
  return { coupon: Number(m[1]) / 1000, maturity: '20' + m[2] + '-' + m[3], tag: m[4] };
}

// --- 파싱: SheetJS AOA(header:1, raw:true) → 종목별 원본 수익률 계열(주말 제거·정렬·중복 후자) ---
// aoa 레이아웃(인포맥스 종목별 민평):
//   row0: 메타(시작/종료/Data 개수/주기) — 무시
//   row1: 종목명, 2열 간격 (col 0,2,4,…). 값 셀은 그 다음 열.
//   row2: 반복 헤더 '일자 | 민평3사 수익률(산출일)'
//   row3~: [일자(Excel 시리얼), 수익률] 쌍. 종목마다 유효 행 수 다름.
// 반환: { bonds:[{ tag, coupon, maturity, series:[['YYYY-MM-DD', yld], …] }] } (원본 수익률, 메모리 한정)
export function parseAoa(aoa) {
  const nameRow = aoa[1] || [];
  const bonds = [];
  for (let c = 0; c < nameRow.length; c += 2) {
    const nm = nameRow[c];
    if (nm == null || nm === '') continue;
    const info = parseName(nm);
    if (!info) throw new Error(`종목명 파싱 불가: 열 ${c} '${nm}'`);

    // 종목 값 열은 c+1. 날짜(시리얼)·수익률 쌍 수집.
    const map = new Map(); // ISO → yld (중복 날짜는 후자 우선)
    for (let r = 3; r < aoa.length; r++) {
      const row = aoa[r];
      if (!row) continue;
      const s = row[c], y = row[c + 1];
      if (typeof s !== 'number' || s < 40000) continue;      // 날짜 셀 아님
      if (typeof y !== 'number' || !Number.isFinite(y)) continue; // NaN/빈값 제거
      const iso = serialToISO(s);
      if (isWeekend(iso)) continue;                          // 주말 캐리오버 제거
      map.set(iso, y);
    }
    const series = [...map.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    bonds.push({ tag: info.tag, coupon: info.coupon, maturity: info.maturity, series });
  }
  return { bonds };
}

// 한 날짜의 3종목 수익률 → 커브조정 분해(bp). 순수 함수(OO-2 onoff-calc 도 재사용).
export function decompose(yOn, yOff1, yOff2) {
  const raw = (yOn - yOff1) * 100;
  const slope = (yOff1 - yOff2) * 100;
  return { raw: round1(raw), slope: round1(slope), fly: round1(raw - slope) };
}

// --- 변환: 원본 종목 계열 → 세대별 파생 스프레드 계열 ---
// bonds 는 파일 순서(신지표 → 과거) 그대로. 세대 i 는 [지표 bonds[i], 구지표 bonds[i+1],
// 구구지표 bonds[i+2]]. 구구지표까지 존재하는 세대만 생성(마지막 2종목은 밴드 재료로만 사용).
// 각 세대 계열은 지표물이 관측된 날짜 중 구·구구지표도 모두 존재하는 날만 포함(day0 = 첫 관측).
// 반환: [{ tag, vs, slopeVs, start, maturity, vsMaturity, slopeVsMaturity,
//          series:[['YYYY-MM-DD', raw_bp, slope_bp, fly_bp], …] }]
// vsMaturity/slopeVsMaturity 는 validateStructure 의 만기 단조성 가드용 메타다. serialize 는
// 이 둘을 직렬화하지 않는다 — 산출물 바이트를 바꾸지 않기 위함(가드 추가는 데이터 변경이 아님).
export function deriveGenerations(bonds) {
  const maps = bonds.map(b => new Map(b.series));
  const gens = [];
  for (let i = 0; i + 2 < bonds.length; i++) {
    const on = maps[i], off1 = maps[i + 1], off2 = maps[i + 2];
    const series = [];
    for (const [d, yOn] of bonds[i].series) {
      if (!off1.has(d) || !off2.has(d)) continue; // 3종목 모두 있는 날만
      const { raw, slope, fly } = decompose(yOn, off1.get(d), off2.get(d));
      series.push([d, raw, slope, fly]);
    }
    if (!series.length) continue;
    gens.push({
      tag: bonds[i].tag,
      vs: bonds[i + 1].tag,
      slopeVs: bonds[i + 2].tag,
      start: series[0][0],
      maturity: bonds[i].maturity,
      vsMaturity: bonds[i + 1].maturity,
      slopeVsMaturity: bonds[i + 2].maturity,
      series,
    });
  }
  return gens;
}

// AOA → 완성 데이터셋. updated = 전 세대 통틀어 가장 최근 관측일.
export function buildDataset(aoa) {
  const { bonds } = parseAoa(aoa);
  const generations = deriveGenerations(bonds);
  let updated = '';
  for (const g of generations) {
    const last = g.series[g.series.length - 1][0];
    if (last > updated) updated = last;
  }
  return { tenor: TENOR, updated, generations };
}

// --- 직렬화: data/onoff-ktb3y.js 텍스트 (세대 1개당 1줄 → diff 가독성) ---
export function serialize(dataset) {
  const { tenor, updated, generations } = dataset;
  const genLine = g => '    ' + JSON.stringify({
    tag: g.tag, vs: g.vs, slopeVs: g.slopeVs,
    start: g.start, maturity: g.maturity, series: g.series,
  });
  return (
    'window.ONOFF_KTB3Y = {\n' +
    '  tenor: ' + JSON.stringify(tenor) + ',\n' +
    '  updated: ' + JSON.stringify(updated) + ',\n' +
    '  generations: [\n' +
    generations.map(genLine).join(',\n') +
    '\n  ]\n};\n'
  );
}

// --- 구조 검증 ---
// 고정 기준값(행수·특정 fly 값)이 아니라 '갱신돼도 참인' 구조 불변식만 검사(라이선스·게이트 분리).
// 새 영업일 추가·세대 교체는 정상 통과, 파싱 붕괴·컬럼 변형·이상치만 실패. 실패 시 Error throw.
const TAG_RE = /^\d{2}-\d+$/;
const MAT_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_GENS = 8;        // 세대 수 하한(구현 시점 18) — 이보다 적으면 파싱/컬럼 이상
const BP_ABS_MAX = 100;    // |raw|,|slope|,|fly| 상한(bp) — 초과 시 파싱/부호 붕괴 의심

export function validateStructure(dataset) {
  const fail = m => { throw new Error('구조 검증 실패: ' + m); };
  const { tenor, updated, generations } = dataset;

  if (tenor !== TENOR) fail(`tenor ${tenor} ≠ ${TENOR}`);
  if (!DATE_RE.test(updated)) fail(`updated 날짜 형식 오류 '${updated}'`);
  if (!Array.isArray(generations) || generations.length < MIN_GENS)
    fail(`세대 수 ${generations ? generations.length : 0} < ${MIN_GENS}`);

  // 만기 조회표 — deriveGenerations 가 vsMaturity/slopeVsMaturity 를 붙이지만, 직렬화되지 않으므로
  // 기존 산출물(data/onoff-ktb3y.js)에는 없다. 같은 데이터셋 안의 다른 세대 tag 로 보완한다.
  const matByTag = new Map(generations.map(g => [g.tag, g.maturity]));
  const matOf = (explicit, tag) => explicit || matByTag.get(tag) || null;

  for (const g of generations) {
    const where = `세대 ${g.tag}`;
    if (!TAG_RE.test(g.tag) || !TAG_RE.test(g.vs) || !TAG_RE.test(g.slopeVs))
      fail(`${where}: tag/vs/slopeVs 형식 오류 (${g.tag}/${g.vs}/${g.slopeVs})`);
    if (!MAT_RE.test(g.maturity)) fail(`${where}: maturity 형식 오류 '${g.maturity}'`);
    if (!Array.isArray(g.series) || g.series.length === 0) fail(`${where}: series 비어 있음`);
    if (g.start !== g.series[0][0]) fail(`${where}: start(${g.start}) ≠ 첫 관측(${g.series[0][0]})`);

    // 만기 단조성: 지표 > 구지표 > 구구지표. 'YYYY-MM' 은 사전식 비교가 시간순과 일치.
    // deriveGenerations 는 xlsx 열 순서만 보고 세대를 짜므로, 열 순서가 만기 오름차순이거나
    // 계열(2Y/3Y)이 섞이면 만기가 역전된 세대가 조용히 만들어진다 — 그 경로를 여기서 끊는다.
    // 만기를 모르는 종목(조회표에도 없는 vs/slopeVs)은 해당 비교만 건너뛴다.
    const vsMat = matOf(g.vsMaturity, g.vs);
    const svMat = matOf(g.slopeVsMaturity, g.slopeVs);
    if (vsMat != null && !MAT_RE.test(vsMat)) fail(`${where}: vsMaturity 형식 오류 '${vsMat}'`);
    if (svMat != null && !MAT_RE.test(svMat)) fail(`${where}: slopeVsMaturity 형식 오류 '${svMat}'`);
    const ladder = `${g.tag}(${g.maturity}) > ${g.vs}(${vsMat ?? '미상'}) > ${g.slopeVs}(${svMat ?? '미상'})`;
    if (vsMat != null && !(g.maturity > vsMat))
      fail(`${where}: 만기 역전 — 지표가 구지표보다 길지 않음 [${ladder}]`);
    if (vsMat != null && svMat != null && !(vsMat > svMat))
      fail(`${where}: 만기 역전 — 구지표가 구구지표보다 길지 않음 [${ladder}]`);

    let prev = '';
    for (let i = 0; i < g.series.length; i++) {
      const [d, raw, slope, fly] = g.series[i];
      if (!DATE_RE.test(d) || Number.isNaN(Date.parse(d))) fail(`${where}: 날짜 파싱 불가 행 ${i} '${d}'`);
      if (isWeekend(d)) fail(`${where}: 주말 미제거 ${d} (행 ${i})`);
      if (prev && d <= prev) fail(`${where}: 날짜 비오름차순/중복 ${prev} → ${d} (행 ${i})`);
      prev = d;
      for (const [k, v] of [['raw', raw], ['slope', slope], ['fly', fly]]) {
        if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where}: ${k} 비수치 @ ${d}`);
        if (Math.abs(v) > BP_ABS_MAX) fail(`${where}: ${k}=${v}bp @ ${d} > ±${BP_ABS_MAX} (이상치)`);
      }
      if (round1(raw - slope) !== fly) fail(`${where}: fly ≠ raw−slope @ ${d} (${fly} vs ${round1(raw - slope)})`);
    }
  }

  // 파생 통계(미리보기/게이트 공용)
  const cur = generations[0];
  const curLast = cur.series[cur.series.length - 1];
  return {
    tenor, updated,
    nGen: generations.length,
    current: {
      tag: cur.tag, vs: cur.vs, slopeVs: cur.slopeVs,
      rows: cur.series.length, first: cur.start, last: curLast[0],
      fly: curLast[3], raw: curLast[1], slope: curLast[2],
    },
  };
}
