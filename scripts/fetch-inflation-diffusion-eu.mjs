// fetch-inflation-diffusion-eu.mjs — 유로존 HICP 확산지수(Eurostat, ECOICOP v2)를
// 조회·계산해 data/inflation-diffusion-eu.js 생성. 인증 불필요(공개 SDMX API).
//
// ⚠️ fetcher 로직 이식본 — 원본: Fenrir src/lib/inflation-diffusion/fetchers/eu.ts.
//    기준 커밋 a242949. 방법론은 scripts/lib/diffusion-core.mjs·diffusion-pipeline.mjs.
//    수정 시 반드시 Fenrir 원본과 동시 반영 (이중 구현 드리프트 방지).
//
// bpbybp 규약: Node 내장 fetch, 무의존, 출력에 wall-clock 미포함, window 전역 자기등록.
//
// 실행:  node scripts/fetch-inflation-diffusion-eu.mjs   (키 불필요)

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  EU_CORE_COICOP, EU_GEO, EU_HEADLINE_COICOP, EU_HICP_ITEMS,
  EU_RATE_TBL, EU_WEIGHT_STATINFO, EU_WEIGHT_TBL,
} from './lib/eu-hicp-items.mjs';
import {
  BACKFILL_MONTHS, DETAIL_MONTHS, DETAIL_SIZE_LIMIT,
  monthsBetween, computeWindow, buildCountryPayload, writeDataFile,
} from './lib/diffusion-pipeline.mjs';
import { fetchWithRetry } from './lib/fetch-retry.mjs';

const EUROSTAT_BASE = 'https://ec.europa.eu/eurostat/api/dissemination/sdmx/2.1/data/';
const SOURCE_URL = EUROSTAT_BASE + EU_RATE_TBL;

// JSON-stat 2.0 row-major flat index.
function flatIndex(sizes, positions) {
  let idx = 0;
  for (let i = 0; i < positions.length; i++) idx = idx * sizes[i] + positions[i];
  return idx;
}

async function fetchEurostat(table, filterPath) {
  const url = `${EUROSTAT_BASE}${table}/${filterPath}/?format=JSON`;
  const res = await fetchWithRetry(url, {}, { label: 'diffusion-eu' });
  if (!res.ok) throw new Error(`Eurostat HTTP ${res.status} for ${table}`);
  const json = await res.json();
  if (Array.isArray(json.error) && json.error.length > 0) {
    throw new Error(`Eurostat error for ${table}: ${json.error[0].label ?? 'unknown'}`);
  }
  if (!json.dimension || !json.value) throw new Error(`Eurostat malformed dataset for ${table}`);
  return json;
}

// (coicop18, timeKey) → 값. rate(MINR)·weight(IW) 공용.
function lookupValue(ds, coicop, timeKey) {
  const coicopIdx = ds.dimension.coicop18?.category?.index?.[coicop];
  const timeIdx = ds.dimension.time?.category?.index?.[timeKey];
  if (coicopIdx == null || timeIdx == null) return null;
  const positions = [];
  for (const dimId of ds.id) {
    if (dimId === 'coicop18') positions.push(coicopIdx);
    else if (dimId === 'time') positions.push(timeIdx);
    else positions.push(0); // 단일값 차원 (freq, unit, statinfo, geo)
  }
  const v = ds.value[String(flatIndex(ds.size, positions))];
  return typeof v === 'number' ? v : null;
}

function latestPeriod(ds, coicop) {
  const indices = ds.dimension.time?.category?.index ?? {};
  const ordered = Object.entries(indices).sort((a, b) => b[1] - a[1]);
  for (const [time] of ordered) if (lookupValue(ds, coicop, time) != null) return time;
  return null;
}

function buildSnapshot(ratesDs, weightsDs, resolvedPeriod, weightYear) {
  const headlineYoy = lookupValue(ratesDs, EU_HEADLINE_COICOP, resolvedPeriod);
  if (headlineYoy == null) return null;
  const coreYoy = lookupValue(ratesDs, EU_CORE_COICOP, resolvedPeriod);
  const items = EU_HICP_ITEMS.map((it) => ({
    code: it.code, name: it.name,
    weight: weightYear ? lookupValue(weightsDs, it.code, weightYear) : null,
    yoy: lookupValue(ratesDs, it.code, resolvedPeriod),
  }));
  return {
    country: 'EU', period: resolvedPeriod, headline_yoy: headlineYoy, core_yoy: coreYoy,
    // HICP-X-FET(에너지·식료품·주류·담배 제외)이 국제 코어(식료품·에너지)와 정의가
    // 달라 core_yoy_intl은 null (Fenrir와 동일).
    core_yoy_intl: null, items, source_url: SOURCE_URL, fetched_at: '',
  };
}

// v2 MINR은 7자리 leaf를 2021까지 backfill → 단일 호출로 5년 윈도우 커버.
async function fetchEuHistory(start, end) {
  const [ratesDs, weightsDs] = await Promise.all([
    fetchEurostat(EU_RATE_TBL, `M.RCH_A..${EU_GEO}`),
    fetchEurostat(EU_WEIGHT_TBL, `A..${EU_WEIGHT_STATINFO}.${EU_GEO}`),
  ]);
  const ratesTimes = ratesDs.dimension.time?.category?.index ?? {};
  const weightsTimes = weightsDs.dimension.time?.category?.index ?? {};
  const weightYearsAvailable = Object.keys(weightsTimes).sort();
  const out = [];
  for (const period of monthsBetween(start, end)) {
    if (!(period in ratesTimes)) continue;
    const periodYear = period.slice(0, 4);
    let weightYear = null;
    for (let i = weightYearsAvailable.length - 1; i >= 0; i--) {
      if (weightYearsAvailable[i] <= periodYear) { weightYear = weightYearsAvailable[i]; break; }
    }
    const snap = buildSnapshot(ratesDs, weightsDs, period, weightYear);
    if (snap) out.push(snap);
  }
  return out;
}

async function main() {
  const { start, end } = computeWindow(new Date());
  console.error(`[diffusion-eu] window ${start} ~ ${end} (${BACKFILL_MONTHS}개월), 상세 최근 ${DETAIL_MONTHS}개월`);
  console.error('[diffusion-eu] Eurostat HICP(PRC_HICP_MINR/IW) 조회…');
  const snaps = await fetchEuHistory(start, end);

  const PORT_REF = 'Fenrir a242949 · eu.ts 이식';
  const eu = buildCountryPayload(snaps, {
    series_id: 'inflation-diffusion-eu', display_name: 'EU HICP 확산지수 (Eurostat, 292품목)',
    country: 'EU', source: 'eurostat', unit: '%', value_type: 'diffusion', frequency: 'monthly',
    yoy_basis: 'YoY', thresholds: { ge0: 0, ge2: 2, ge25: 2.5, ge3: 3 },
    window: { start, end }, port_ref: PORT_REF,
    note: 'EU는 최종치 D+15 시차 정상(flash는 헤드라인만 → leaf<20%면 flash로 skip).',
  });
  console.error(`[diffusion-eu] EU ${eu.stats.periods}개월(flash skip ${eu.stats.flashSkipped}), ${eu.stats.earliest}~${eu.stats.latest}`);

  const banner = `// data/inflation-diffusion-eu.js — 유로존 HICP 확산지수 (Eurostat ECOICOP v2).\n` +
    `// scripts/fetch-inflation-diffusion-eu.mjs 생성. 자동 생성물 — 직접 편집 금지. ${PORT_REF}.\n`;
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const { bytes, path } = writeDataFile({
    dataDir: join(scriptDir, '..', 'data'), fileName: 'inflation-diffusion-eu.js', banner, logTag: 'diffusion-eu',
    entries: [{ key: 'inflation-diffusion-eu', payload: eu.payload }],
  });
  console.error(`[diffusion-eu] 출력 ${(bytes / 1024).toFixed(1)}KB (한도 ${DETAIL_SIZE_LIMIT / 1024}KB) → ${path}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`[diffusion-eu] 실패: ${err.message}`); process.exit(1); });
}

export { fetchEuHistory, buildSnapshot, lookupValue };
