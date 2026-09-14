// fetch-inflation-diffusion-kr.mjs — 한국 CPI 확산지수(KOSIS)를 조회·계산해
// data/inflation-diffusion-kr.js 생성. KOSIS_API_KEY 필요(키드 게이트).
//
// ⚠️ fetcher 로직 이식본 — 원본: Fenrir src/lib/inflation-diffusion/fetchers/kr.ts.
//    기준 커밋 a242949. 방법론은 diffusion-core.mjs·diffusion-pipeline.mjs.
//    수정 시 반드시 Fenrir 원본과 동시 반영 (이중 구현 드리프트 방지).
//
// 실행:  KOSIS_API_KEY=xxxx node scripts/fetch-inflation-diffusion-kr.mjs
//    (회사 PC 키 미저장 원칙 → 실행·대조는 개인 노트북. 코드는 키 없이 완성·검증까지만.)

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  KR_CORE_INTL_TBL, KR_CORE_TBL, KR_CPI_ITEMS, KR_NATIONAL_C1, KR_PRICE_TBL,
} from './lib/kr-cpi-items.mjs';
import { lookupKrWeight } from './lib/kr-cpi-weights.mjs';
import {
  BACKFILL_MONTHS, DETAIL_MONTHS, DETAIL_SIZE_LIMIT,
  monthsBetween, computeWindow, buildCountryPayload, writeDataFile,
} from './lib/diffusion-pipeline.mjs';
import { fetchWithRetry } from './lib/fetch-retry.mjs';

const KOSIS_URL = 'https://kosis.kr/openapi/Param/statisticsParameterData.do';
const SOURCE_URL = KOSIS_URL + '?orgId=101&tblId=DT_1J22112';

function periodToKosis(p) { return p.slice(0, 4) + p.slice(5, 7); }         // "2026-03"→"202603"
function kosisToPeriod(prdDe) { return `${prdDe.slice(0, 4)}-${prdDe.slice(4, 6)}`; }
function parseDt(d) { if (!d.DT) return null; const v = parseFloat(d.DT); return Number.isFinite(v) ? v : null; }

async function callKosis(apiKey, tblId, startPrd, endPrd, extraParams = {}) {
  const url = new URL(KOSIS_URL);
  url.searchParams.set('method', 'getList');
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('format', 'json');
  url.searchParams.set('jsonVD', 'Y');
  url.searchParams.set('orgId', '101');
  url.searchParams.set('tblId', tblId);
  url.searchParams.set('prdSe', 'M');
  url.searchParams.set('startPrdDe', startPrd);
  url.searchParams.set('endPrdDe', endPrd);
  for (const [k, v] of Object.entries(extraParams)) url.searchParams.set(k, v);

  // 타임아웃·재시도는 공통 헬퍼(기본 60s, FETCH_TIMEOUT_MS). URL에 apiKey가 있어
  // 헬퍼 로그는 host만 출력.
  const res = await fetchWithRetry(url.toString(), {}, { label: 'diffusion-kr' });
  if (!res.ok) throw new Error(`KOSIS HTTP ${res.status} (tbl=${tblId})`);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`KOSIS non-JSON (tbl=${tblId}): ${text.slice(0, 200)}`); }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    throw new Error(`KOSIS error ${parsed.err} (tbl=${tblId}): ${parsed.errMsg}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`KOSIS response not array (tbl=${tblId})`);
  return parsed;
}

function pickLatestOrAt(rows, period) {
  if (period) { const target = periodToKosis(period); return rows.find((r) => r.PRD_DE === target); }
  return [...rows].sort((a, b) => (b.PRD_DE ?? '').localeCompare(a.PRD_DE ?? ''))[0];
}

function yoyForPoint(series, current) {
  const cur = parseDt(current);
  if (cur == null || cur === 0) return null;
  const curPrd = current.PRD_DE ?? '';
  if (curPrd.length !== 6) return null;
  const priorYearPrd = String(parseInt(curPrd.slice(0, 4), 10) - 1) + curPrd.slice(4);
  const prior = series.find((r) => r.PRD_DE === priorYearPrd);
  if (!prior) return null;
  const prv = parseDt(prior);
  if (prv == null || prv === 0) return null;
  return (cur / prv - 1) * 100;
}

async function loadKosisWindow(apiKey, startPrd, endPrd) {
  const [priceRows, coreRows, coreIntlRows] = await Promise.all([
    callKosis(apiKey, KR_PRICE_TBL, startPrd, endPrd, { itmId: 'T+', objL1: KR_NATIONAL_C1, objL2: 'ALL' }),
    callKosis(apiKey, KR_CORE_TBL, startPrd, endPrd, { itmId: 'T+', objL1: 'ALL' }),
    callKosis(apiKey, KR_CORE_INTL_TBL, startPrd, endPrd, { itmId: 'T+', objL1: 'ALL' }),
  ]);
  const byC2 = new Map();
  for (const r of priceRows) {
    if (!r.C2) continue;
    if (!byC2.has(r.C2)) byC2.set(r.C2, []);
    byC2.get(r.C2).push(r);
  }
  return { byC2, coreRows, coreIntlRows };
}

function buildSnapshotFromDataset(ds, resolvedPeriod) {
  const headlineSeries = ds.byC2.get('0') ?? [];
  const headlinePoint = pickLatestOrAt(headlineSeries, resolvedPeriod);
  if (!headlinePoint || !headlinePoint.PRD_DE) return null;
  const headlineYoy = yoyForPoint(headlineSeries, headlinePoint);
  if (headlineYoy == null) return null;

  const coreSeries = ds.coreRows.filter((r) => r.C1 === 'QB');          // 농산물·석유류 제외
  const corePoint = pickLatestOrAt(coreSeries, resolvedPeriod);
  const coreYoy = corePoint ? yoyForPoint(coreSeries, corePoint) : null;

  const coreIntlSeries = ds.coreIntlRows.filter((r) => r.C1 === 'DB');  // 식료품·에너지 제외
  const coreIntlPoint = pickLatestOrAt(coreIntlSeries, resolvedPeriod);
  const coreYoyIntl = coreIntlPoint ? yoyForPoint(coreIntlSeries, coreIntlPoint) : null;

  const items = KR_CPI_ITEMS.map((it) => {
    const series = ds.byC2.get(it.code) ?? [];
    const point = pickLatestOrAt(series, resolvedPeriod);
    return { code: it.code, name: it.name, weight: lookupKrWeight(it.code), yoy: point ? yoyForPoint(series, point) : null };
  });

  return {
    country: 'KR', period: resolvedPeriod, headline_yoy: headlineYoy,
    core_yoy: coreYoy, core_yoy_intl: coreYoyIntl, items, source_url: SOURCE_URL, fetched_at: '',
  };
}

async function fetchKrHistory(apiKey, startPeriod, endPeriod) {
  // 시작 12개월 전부터(YoY 앵커).
  const startY = parseInt(startPeriod.slice(0, 4), 10) - 1;
  const startM = parseInt(startPeriod.slice(5, 7), 10);
  const startPrd = `${startY}${String(startM).padStart(2, '0')}`;
  const endPrd = `${endPeriod.slice(0, 4)}${endPeriod.slice(5, 7)}`;
  const ds = await loadKosisWindow(apiKey, startPrd, endPrd);
  const out = [];
  for (const period of monthsBetween(startPeriod, endPeriod)) {
    const snap = buildSnapshotFromDataset(ds, period);
    if (snap) out.push(snap);
  }
  return out;
}

async function main() {
  const apiKey = process.env.KOSIS_API_KEY;
  if (!apiKey) { console.error('[diffusion-kr] KOSIS_API_KEY 환경변수가 없습니다.'); process.exit(1); }

  const { start, end } = computeWindow(new Date());
  console.error(`[diffusion-kr] window ${start} ~ ${end} (${BACKFILL_MONTHS}개월), 상세 최근 ${DETAIL_MONTHS}개월`);
  console.error('[diffusion-kr] KOSIS DT_1J22112/22007/22009 조회…');
  const snaps = await fetchKrHistory(apiKey, start, end);

  const PORT_REF = 'Fenrir a242949 · kr.ts 이식';
  const kr = buildCountryPayload(snaps, {
    series_id: 'inflation-diffusion-kr', display_name: 'KR CPI 확산지수 (KOSIS, 458품목)',
    country: 'KR', source: 'kosis', unit: '%', value_type: 'diffusion', frequency: 'monthly',
    yoy_basis: 'YoY', thresholds: { ge0: 0, ge2: 2, ge25: 2.5, ge3: 3 },
    window: { start, end }, port_ref: PORT_REF,
    note: '코어=농산물·석유류 제외(정책), 국제코어=식료품·에너지 제외.',
  });
  console.error(`[diffusion-kr] KR ${kr.stats.periods}개월(flash skip ${kr.stats.flashSkipped}), ${kr.stats.earliest}~${kr.stats.latest}`);

  const banner = `// data/inflation-diffusion-kr.js — 한국 CPI 확산지수 (KOSIS).\n` +
    `// scripts/fetch-inflation-diffusion-kr.mjs 생성. 자동 생성물 — 직접 편집 금지. ${PORT_REF}.\n`;
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const { bytes, path } = writeDataFile({
    dataDir: join(scriptDir, '..', 'data'), fileName: 'inflation-diffusion-kr.js', banner, logTag: 'diffusion-kr',
    entries: [{ key: 'inflation-diffusion-kr', payload: kr.payload }],
  });
  console.error(`[diffusion-kr] 출력 ${(bytes / 1024).toFixed(1)}KB (한도 ${DETAIL_SIZE_LIMIT / 1024}KB) → ${path}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`[diffusion-kr] 실패: ${err.message}`); process.exit(1); });
}

export { fetchKrHistory, buildSnapshotFromDataset, yoyForPoint };
