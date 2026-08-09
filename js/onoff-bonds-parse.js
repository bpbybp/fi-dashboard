// onoff-bonds-parse.js — 인포맥스 종목별 민평 xlsx → **종목 단위** 상대금리 계열 변환 모듈.
//
// [기존 파이프라인과의 관계] js/onoff-parse.js(세대=3종목 조합 스키마)와 병행하는 별개 계보다.
// 저 모듈을 import 하지 않고 독립적으로 구현한다 — 세대 스키마가 동결/폐기돼도 이쪽은 영향받지
// 않아야 하고, 반대로 이쪽 변경이 저쪽 산출물 바이트를 흔들어서도 안 되기 때문.
// 산출물도 다르다: data/onoff-ktb3y.js(세대) ↔ data/onoff-bonds.js(종목).
//
// [데이터 라이선스] 민평 수익률은 유료 벤더 데이터 → 원본 수익률(%)은 절대 직렬화하지 않는다.
// parseBonds 는 메모리상에서만 원본 %를 다루고, buildRelative 가 즉시 앵커 대비 bp 로 바꾼다.
// serializeBonds 에 들어가는 값은 전부 상대 bp 이며 레벨 앵커가 없다(원본 재배포 아님).
//
// [만기 이후 캐리포워드] 원본 xlsx 는 이미 만기가 도래한 종목도 만기월 이후 구간을 단일 값
// 반복으로 계속 채워 보낸다. parseBonds 가 만기월 초과 관측을 잘라낸다 — 그 값들은 시장 관측이
// 아니라 벤더의 보류(carry-forward) 아티팩트다.
//
// [상대화 기준] 매일 '그날 유효한 최단만기 종목'을 앵커로 잡고 앵커 대비 bp 를 낸다. 앵커는
// 만기 도래로 계속 교체되므로, 교체 시 두 앵커가 함께 관측된 날의 스프레드를 누적 오프셋으로
// 이어 붙여 전 기간을 단일 기준으로 통일한다(체인 링킹). 절대 레벨은 복원되지 않는다.
//
// DOM 접근 금지. 파일 I/O·XLSX 로드는 호출자 담당(이 모듈은 SheetJS AOA 만 받는다).

// --- 프리미티브 ---

// Excel 시리얼(1900 date system) → 'YYYY-MM-DD' (UTC, 일 단위 반올림)
export function serialToISO(serial) {
  const days = Math.round(serial) - 25569; // 25569 = 1970-01-01 의 Excel 시리얼
  const d = new Date(days * 86400000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// 토·일 여부. ISO 를 UTC 로 해석해 로컬 TZ 영향 배제.
export function isWeekend(iso) {
  const g = new Date(iso + 'T00:00:00Z').getUTCDay();
  return g === 0 || g === 6;
}

// 0.1bp 그리드 정규화(부동소수점 노이즈 제거)
export const round1 = v =>
  (typeof v === 'number' && Number.isFinite(v)) ? Math.round(v * 10) / 10 : null;

// 'YYYY-MM' 을 월 일련번호로. 만기 − 첫관측 개월수 계산용.
const monthIndex = ym => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7));

// 종목명 → { coupon, maturity:'YYYY-MM', tag }.  예: '국고03500-2906(26-5)'
//   03500 → coupon 3.500 | 2906 → 만기 2029-06 | (26-5) → tag '26-5'
const NAME_RE = /^국고(\d{5})-(\d{2})(\d{2})\((\d{2}-\d+)\)/;
export function parseName(name) {
  const m = String(name).match(NAME_RE);
  if (!m) return null;
  return { coupon: Number(m[1]) / 1000, maturity: '20' + m[2] + '-' + m[3], tag: m[4] };
}

// 경고 수집기 — 호출자가 onWarn 을 주지 않으면 console.warn 으로 흘린다(노드/브라우저 공통).
const defaultWarn = msg => { if (typeof console !== 'undefined') console.warn('⚠ ' + msg); };

// --- 1. 파싱 ---
// aoa 레이아웃(인포맥스 종목별 민평, 기존 파이프라인과 동일):
//   row0: 조회 메타(시작/종료/Data 개수/주기/정렬/영업일/시세산출) — 무시
//   row1: 종목명, 2열 간격(col 0,2,4,…). 값 셀은 그 다음 열.
//   row2: 반복 헤더 '일자 | 민평3사 수익률(산출일)'
//   row3~: [일자(Excel 시리얼), 수익률] 쌍. 열마다 자기 일자 축을 갖고 유효 구간이 다르다.
//
// 필터 순서(명세 고정): ① 금리 비유한수 제외 → ② 주말 제외 → ③ 만기월 초과 제외.
// 반환: [{ tag, maturity, coupon, first, last, obs: Map<ISO, number> }]  ※ obs 는 원본 % (메모리 한정)
export function parseBonds(aoa, onWarn = defaultWarn) {
  const nameRow = aoa[1] || [];
  const bonds = [];
  for (let c = 0; c < nameRow.length; c += 2) {
    const nm = nameRow[c];
    if (nm == null || nm === '') continue;
    const info = parseName(nm);
    if (!info) throw new Error(`종목명 파싱 불가: 열 ${c} '${nm}'`);

    const obs = new Map(); // ISO → yld(%)  (중복 일자는 후자 우선)
    let dropCarry = 0, dropWeekend = 0;
    for (let r = 3; r < aoa.length; r++) {
      const row = aoa[r];
      if (!row) continue;
      const s = row[c], y = row[c + 1];
      if (typeof s !== 'number' || s < 40000) continue;        // 날짜 셀 아님
      if (typeof y !== 'number' || !Number.isFinite(y)) continue; // ① 금리 없음/NaN
      const iso = serialToISO(s);
      if (iso === null) continue;
      if (isWeekend(iso)) { dropWeekend++; continue; }         // ② 주말 캐리오버
      if (iso.slice(0, 7) > info.maturity) { dropCarry++; continue; } // ③ 만기월 초과 캐리포워드
      obs.set(iso, y);
    }
    if (!obs.size) { onWarn(`${info.tag}: 유효 관측 0건 — 종목 제외`); continue; }

    const dates = [...obs.keys()].sort();
    bonds.push({
      tag: info.tag,
      maturity: info.maturity,
      coupon: info.coupon,
      first: dates[0],
      last: dates[dates.length - 1],
      obs,
      dropped: { weekend: dropWeekend, postMaturity: dropCarry },
    });
  }
  return bonds;
}

// --- 2. tenor 분류 ---
// (만기월 − 첫 관측월) 개월수로 판정. 30개월 미만 = 2Y, 이상 = 3Y.
// 국고 2년물은 실측 25개월, 3년물은 37~40개월로 군집이 명확히 갈린다. 28~32개월 구간에
// 걸리는 종목은 그 전제가 깨진 것이므로 경고를 낸다(값은 그대로 반환).
export function classifyTenor(bond, onWarn = defaultWarn) {
  const months = monthIndex(bond.maturity) - monthIndex(bond.first.slice(0, 7));
  if (months >= 28 && months <= 32)
    onWarn(`${bond.tag}: tenor 경계 — 만기 ${bond.maturity} − 첫관측 ${bond.first} = ${months}개월`);
  return months < 30 ? '2Y' : '3Y';
}

// --- 3. 상대화(앵커 체인 링킹) ---
// 각 일자마다 그날 유효한 최단만기 종목을 앵커로 잡는다. 앵커가 바뀌면, 구·신 앵커가 함께
// 관측된 가장 최근 날의 스프레드를 누적 오프셋에 더해 전 기간을 단일 기준으로 잇는다.
//
//   unified_b(d) = (y_b(d) − y_anchor(d)) * 100 + cum(d)
//   전환 시:      cum_new = cum_old + (y_new(link) − y_old(link)) * 100
//
// 이렇게 두면 구 앵커의 unified 값이 전환 전후로 이어진다(=계단 없음).
// 겹치는 날이 하나도 없으면(구 앵커 종료 후 신 앵커 개시) 이을 수가 없으므로 에러로 중단한다.
//
// 반환: { dates, byTag: Map<tag, [[ISO, bp], …]>, cum: [[ISO, cumBp], …],
//         anchorLog: [{ date, from, to, linkDate, stepBp, cumBp }], baseTag }
export function buildRelative(bonds, onWarn = defaultWarn) {
  if (!bonds.length) throw new Error('상대화 실패: 종목이 없습니다.');

  const allDates = new Set();
  for (const b of bonds) for (const d of b.obs.keys()) allDates.add(d);
  const dates = [...allDates].sort();

  // 그날 유효한 종목 중 최단만기(동률이면 첫 관측이 이른 쪽 → tag 순)를 앵커로.
  const pickAnchor = d => {
    let best = null;
    for (const b of bonds) {
      if (!b.obs.has(d)) continue;
      if (best === null ||
          b.maturity < best.maturity ||
          (b.maturity === best.maturity && (b.first < best.first ||
            (b.first === best.first && b.tag < best.tag)))) best = b;
    }
    return best;
  };

  const byTag = new Map(bonds.map(b => [b.tag, []]));
  const cum = [];
  const anchorLog = [];
  let curAnchor = null, cumBp = 0, baseTag = null;

  for (const d of dates) {
    const anchor = pickAnchor(d);
    if (!anchor) throw new Error(`상대화 실패: ${d} 에 유효 종목이 없습니다.`);

    if (curAnchor === null) {
      curAnchor = anchor;
      baseTag = anchor.tag;
    } else if (anchor.tag !== curAnchor.tag) {
      // 구·신 앵커가 함께 관측된 가장 최근 날을 찾아 링크한다.
      let linkDate = null;
      for (const cand of [...curAnchor.obs.keys()].sort().reverse()) {
        if (cand > d) continue;
        if (anchor.obs.has(cand)) { linkDate = cand; break; }
      }
      if (linkDate === null)
        throw new Error(
          `상대화 실패: 앵커 단절 @ ${d} — ${curAnchor.tag}(만기 ${curAnchor.maturity}, 최종 ` +
          `${curAnchor.last}) 와 ${anchor.tag}(만기 ${anchor.maturity}, 최초 ${anchor.first}) 가 ` +
          `함께 관측된 날이 없어 기준을 이을 수 없습니다.`);
      const stepBp = round1((anchor.obs.get(linkDate) - curAnchor.obs.get(linkDate)) * 100);
      cumBp = round1(cumBp + stepBp);
      anchorLog.push({ date: d, from: curAnchor.tag, to: anchor.tag, linkDate, stepBp, cumBp });
      if (linkDate !== d) onWarn(`앵커 전환 ${curAnchor.tag}→${anchor.tag} @ ${d}: 당일 동시 관측이 없어 ${linkDate} 로 링크`);
      curAnchor = anchor;
    }

    const yA = curAnchor.obs.get(d);
    for (const b of bonds) {
      if (!b.obs.has(d)) continue;
      byTag.get(b.tag).push([d, round1((b.obs.get(d) - yA) * 100 + cumBp)]);
    }
    cum.push([d, cumBp]);
  }

  return { dates, byTag, cum, anchorLog, baseTag };
}

// --- 4. 직렬화 ---
// data/onoff-bonds.js 텍스트. 종목 1개당 1줄, 전환 1건당 1줄 → diff 가독성(세대 파일과 같은 규약).
// 원본 % 는 어디에도 들어가지 않는다 — series 는 전부 앵커 체인 기준 상대 bp.
export function serializeBonds(dataset) {
  const { updated, anchorNote, anchorLog = [], bonds } = dataset;
  const bondLine = b => '    ' + JSON.stringify({
    tag: b.tag, tenor: b.tenor, maturity: b.maturity, coupon: b.coupon,
    first: b.first, last: b.last, series: b.series,
  });
  const logLine = a => '    ' + JSON.stringify({
    date: a.date, from: a.from, to: a.to, linkDate: a.linkDate, stepBp: a.stepBp, cumBp: a.cumBp,
  });
  return (
    `// series의 상대금리는 앵커 전환 ${anchorLog.length}회의 누적 오프셋을 포함한다.\n` +
    '// 같은 일자 내 종목 간 비교에만 사용할 것.\n' +
    '// 서로 다른 일자의 레벨을 직접 비교하지 말 것 (누적 오차 포함).\n' +
    '//\n' +
    '// 자동 생성물 — tools/convert-onoff-bonds.mjs. 직접 편집 금지.\n' +
    'window.ONOFF_BONDS = {\n' +
    '  updated: ' + JSON.stringify(updated) + ',\n' +
    '  anchorNote: ' + JSON.stringify(anchorNote) + ',\n' +
    '  anchorLog: [\n' +
    anchorLog.map(logLine).join(',\n') +
    '\n  ],\n' +
    '  bonds: [\n' +
    bonds.map(bondLine).join(',\n') +
    '\n  ]\n};\n'
  );
}

// --- 5. 구조 검증 ---
// 고정 기준값이 아니라 '갱신돼도 참인' 불변식만 검사한다. 실패 시 Error throw,
// 에러 아닌 이상징후는 onWarn 으로 보고하고 warnings 에 담아 돌려준다.
const TAG_RE = /^\d{2}-\d+$/;
const MAT_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_BONDS = 20;      // 종목 수 하한 — 이보다 적으면 파싱/컬럼 이상
const BP_ABS_MAX = 500;    // |상대 bp| 상한 — 초과 시 앵커 링킹/부호 붕괴 의심
const TENORS = new Set(['2Y', '3Y']);

export function validateBonds(dataset, onWarn = defaultWarn) {
  const fail = m => { throw new Error('종목 구조 검증 실패: ' + m); };
  const warnings = [];
  const warn = m => { warnings.push(m); onWarn(m); };
  const { updated, bonds } = dataset;

  // 1) updated 날짜 형식
  if (!DATE_RE.test(updated)) fail(`updated 날짜 형식 오류 '${updated}'`);

  // 2) 종목 수 하한
  if (!Array.isArray(bonds) || bonds.length < MIN_BONDS)
    fail(`종목 수 ${bonds ? bonds.length : 0} < ${MIN_BONDS}`);

  const byMaturity = new Map();
  let totalObs = 0;
  let prevMaturity = '';

  for (const b of bonds) {
    const where = `종목 ${b.tag}`;

    // 3) 필드 형식
    if (!TAG_RE.test(b.tag)) fail(`${where}: tag 형식 오류 '${b.tag}'`);
    if (!MAT_RE.test(b.maturity)) fail(`${where}: maturity 형식 오류 '${b.maturity}'`);
    if (typeof b.coupon !== 'number' || !Number.isFinite(b.coupon)) fail(`${where}: coupon 비수치 '${b.coupon}'`);
    if (!Array.isArray(b.series) || b.series.length === 0) fail(`${where}: series 비어 있음`);

    // 7) tenor
    if (!TENORS.has(b.tenor)) fail(`${where}: tenor '${b.tenor}' ∉ {2Y,3Y}`);

    // 4) 날짜 오름차순·중복 없음·주말 없음  /  6) 상대금리 상한
    let prev = '';
    for (let i = 0; i < b.series.length; i++) {
      const [d, bp] = b.series[i];
      if (!DATE_RE.test(d) || Number.isNaN(Date.parse(d))) fail(`${where}: 날짜 파싱 불가 행 ${i} '${d}'`);
      if (isWeekend(d)) fail(`${where}: 주말 미제거 ${d} (행 ${i})`);
      if (prev && d <= prev) fail(`${where}: 날짜 비오름차순/중복 ${prev} → ${d} (행 ${i})`);
      prev = d;
      if (typeof bp !== 'number' || !Number.isFinite(bp)) fail(`${where}: 상대금리 비수치 @ ${d}`);
      if (Math.abs(bp) > BP_ABS_MAX) fail(`${where}: 상대금리 ${bp}bp @ ${d} > ±${BP_ABS_MAX} (이상치)`);
    }
    totalObs += b.series.length;

    // first/last 와 series 양끝 정합 — 직렬화된 메타가 계열과 어긋나면 소비 측이 잘못 자른다.
    if (b.first !== b.series[0][0]) fail(`${where}: first(${b.first}) ≠ 첫 관측(${b.series[0][0]})`);
    if (b.last !== b.series[b.series.length - 1][0]) fail(`${where}: last(${b.last}) ≠ 마지막 관측(${b.series[b.series.length - 1][0]})`);

    // 5) 캐리포워드 잔존 — series 최종일이 만기월을 넘으면 안 된다.
    if (b.last.slice(0, 7) > b.maturity)
      fail(`${where}: 만기 이후 관측 잔존 — 최종 ${b.last} > 만기월 ${b.maturity}`);

    // 9) 만기 정렬 — bonds 배열은 만기 비내림차순이어야 한다.
    // 세대 스키마의 '세대 내 만기 단조성'에 대응하는 종목 스키마 쪽 불변식이다. 세대 조합이 없으니
    // 역전이 곧바로 잘못된 스프레드를 만들지는 않지만, 순서가 뒤집혔다는 건 xlsx 열 구성이나
    // 정렬 단계가 깨졌다는 신호다. 같은 만기(2Y·3Y 동월 만기)는 정상이라 8)에서 경고로만 잡는다.
    if (prevMaturity && b.maturity < prevMaturity)
      fail(`${where}: 만기 정렬 역전 — 직전 종목 만기 ${prevMaturity} > ${b.maturity}. bonds 배열은 만기 오름차순이어야 함`);
    prevMaturity = b.maturity;

    if (!byMaturity.has(b.maturity)) byMaturity.set(b.maturity, []);
    byMaturity.get(b.maturity).push(b);
  }

  // 8) 만기 충돌 — 같은 만기 종목이 2개 이상이면 경고(에러 아님).
  //    커브 형태 자체는 제약하지 않는다(상대금리의 만기순 단조성은 요구하지 않음).
  for (const [mat, group] of byMaturity) {
    if (group.length > 1)
      warn(`만기 충돌 ${mat}: ${group.map(g => `${g.tag}(${g.tenor})`).join(', ')} — ${group.length}개 종목이 같은 만기월`);
  }

  const tenorCount = bonds.reduce((a, b) => (a[b.tenor] = (a[b.tenor] || 0) + 1, a), {});
  const allFirst = bonds.reduce((m, b) => (m === null || b.first < m ? b.first : m), null);
  const allLast = bonds.reduce((m, b) => (m === null || b.last > m ? b.last : m), null);

  return { updated, nBonds: bonds.length, tenorCount, first: allFirst, last: allLast, totalObs, warnings };
}
