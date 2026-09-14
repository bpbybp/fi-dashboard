// fetch-inflation-diffusion-au.mjs — 호주 CPI 확산지수(ABS SDMX)를 조회·계산해
// data/inflation-diffusion-au.js 생성. 인증 불필요(공개 API).
//
// ⚠️ fetcher 로직 이식본 — 원본: Fenrir src/lib/inflation-diffusion/fetchers/au.ts + au-bridge.ts.
//    기준 커밋 a242949. 방법론은 diffusion-core.mjs·diffusion-pipeline.mjs.
//    수정 시 반드시 Fenrir 원본과 동시 반영 (이중 구현 드리프트 방지).
//
// ⚠️ 2025-11 이전은 분기 자료를 월로 상수보간(계단형) → 변동이 실제보다 작아 보일 수 있음.
//    (페이지 각주로 명시.)
//
// 실행:  node scripts/fetch-inflation-diffusion-au.mjs   (키 불필요)

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  AU_CORE_INTL_INDEX, AU_CPI_ITEMS, AU_FREQ_MONTHLY, AU_FREQ_QUARTERLY,
  AU_HEADLINE_INDEX, AU_MEASURE_INDEX, AU_MEASURE_YOY, AU_QUARTERLY_DATAFLOW,
  AU_QUARTERLY_HEADLINE_INDEX, AU_RATE_DATAFLOW, AU_REGION, AU_TRIMMED_MEAN_INDEX,
  AU_TSEST_ORIGINAL, AU_TSEST_SA,
} from './lib/au-cpi-items.mjs';
import { lookupAuWeight } from './lib/au-cpi-weights.mjs';
import {
  COMPLETE_MONTHLY_FIRST_PERIOD, expandQuarterlyToMonthly, needsQuarterlyBridge,
  periodToQuarter, priorYearQuarter, splitWindow,
} from './lib/au-bridge.mjs';
import {
  BACKFILL_MONTHS, DETAIL_MONTHS, DETAIL_SIZE_LIMIT,
  computeWindow, buildCountryPayload, writeDataFile,
} from './lib/diffusion-pipeline.mjs';
import { fetchWithRetry } from './lib/fetch-retry.mjs';

const ABS_BASE = 'https://api.data.abs.gov.au/data/';
const SOURCE_URL = ABS_BASE + AU_RATE_DATAFLOW;

async function fetchAbs(dataflow, filterPath, startPeriod) {
  const url = `${ABS_BASE}${dataflow}/${filterPath}/?startPeriod=${startPeriod}&dimensionAtObservation=AllDimensions`;
  const res = await fetchWithRetry(url, { headers: { Accept: 'application/vnd.sdmx.data+json' } },
    { label: 'diffusion-au' });
  if (!res.ok) throw new Error(`ABS HTTP ${res.status} for ${dataflow}`);
  const text = await res.text();
  if (text === 'NoRecordsFound' || text.length < 50) return null;
  let json;
  try { json = JSON.parse(text); }
  catch { throw new Error(`ABS non-JSON for ${dataflow}: ${text.slice(0, 100)}`); }
  if (Array.isArray(json.errors) && json.errors.length > 0) {
    throw new Error(`ABS error for ${dataflow}: ${json.errors[0].message ?? 'unknown'}`);
  }
  const ds = json.data?.dataSets?.[0];
  const struct = json.data?.structures?.[0];
  if (!ds || !struct) return null;
  return { ds, struct };
}

function parseDataset(payload) {
  const dims = payload.struct.dimensions.observation;
  const dimValues = {};
  const dimPos = {};
  dims.forEach((d, i) => { dimValues[d.id] = d.values; dimPos[d.id] = i; });
  return { dimValues, dimPos, observations: payload.ds.observations };
}

function findDimIdx(parsed, dim, codeId) {
  return parsed.dimValues[dim]?.findIndex((v) => v.id === codeId) ?? -1;
}

function timePeriods(parsed) {
  return (parsed.dimValues['TIME_PERIOD'] ?? []).map((v, idx) => ({ id: v.id ?? v.value ?? '', idx }));
}

function lookupObs(parsed, positions) {
  const keyParts = [];
  for (const dimId of Object.keys(parsed.dimPos).sort((a, b) => parsed.dimPos[a] - parsed.dimPos[b])) {
    keyParts.push(positions[dimId] ?? 0);
  }
  const obs = parsed.observations[keyParts.join(':')];
  if (!obs) return null;
  const v = obs[0];
  if (v == null) return null;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : null;
}

function valueFor(parsed, indexCode, timeId, measureCode, tsestCode, freqCode) {
  const iIdx = findDimIdx(parsed, 'INDEX', indexCode);
  const tIdx = (parsed.dimValues['TIME_PERIOD'] ?? []).findIndex((v) => (v.id ?? v.value) === timeId);
  if (iIdx < 0 || tIdx < 0) return null;
  const positions = {
    MEASURE: findDimIdx(parsed, 'MEASURE', measureCode),
    INDEX: iIdx,
    TSEST: findDimIdx(parsed, 'TSEST', tsestCode),
    REGION: findDimIdx(parsed, 'REGION', AU_REGION),
    FREQ: findDimIdx(parsed, 'FREQ', freqCode),
    TIME_PERIOD: tIdx,
  };
  for (const k of Object.keys(positions)) {
    if (positions[k] < 0 && parsed.dimValues[k]?.length === 1) positions[k] = 0;
  }
  return lookupObs(parsed, positions);
}

function latestPeriodWithValue(parsed, indexCode, measureCode, tsestCode, freqCode) {
  const periods = timePeriods(parsed).sort((a, b) => b.id.localeCompare(a.id));
  for (const p of periods) {
    if (valueFor(parsed, indexCode, p.id, measureCode, tsestCode, freqCode) != null) return p.id;
  }
  return null;
}

// history fetch: 분기 브리지(pre-2025-11) + 완전 월별(2025-11+). au.ts fetchHistory와 1:1.
async function fetchAuHistory(startPeriod, endPeriod) {
  const { quarterlyRange, monthlyRange } = splitWindow(startPeriod, endPeriod);
  const out = [];

  // ── 분기 브리지 구간 ──
  if (quarterlyRange) {
    const [qStart] = quarterlyRange;
    const startQuarter = periodToQuarter(qStart);
    const [yStr, qStr] = startQuarter.split('-Q');
    const fetchStartQuarter = `${parseInt(yStr, 10) - 1}-Q${qStr}`;  // YoY 앵커용 4분기 전
    const qPayload = await fetchAbs(
      AU_QUARTERLY_DATAFLOW, `..${AU_TSEST_SA}.${AU_REGION}.${AU_FREQ_QUARTERLY}`, fetchStartQuarter,
    );
    if (qPayload) {
      const qDs = parseDataset(qPayload);
      const qPeriods = timePeriods(qDs).sort((a, b) => a.id.localeCompare(b.id));
      const indexLevel = (indexCode, quarter) =>
        valueFor(qDs, indexCode, quarter, AU_MEASURE_INDEX, AU_TSEST_SA, AU_FREQ_QUARTERLY);
      for (const qp of qPeriods) {
        if (qp.id < startQuarter) continue; // warmup 앵커 분기 skip
        const headlineYoy = valueFor(qDs, AU_QUARTERLY_HEADLINE_INDEX, qp.id, AU_MEASURE_YOY, AU_TSEST_SA, AU_FREQ_QUARTERLY);
        if (headlineYoy == null) continue;
        const coreYoy = valueFor(qDs, AU_TRIMMED_MEAN_INDEX, qp.id, AU_MEASURE_YOY, AU_TSEST_SA, AU_FREQ_QUARTERLY);
        const priorQuarter = priorYearQuarter(qp.id);
        const items = AU_CPI_ITEMS.map((it) => {
          let yoy = null;
          const cur = indexLevel(it.code, qp.id);
          const prior = priorQuarter ? indexLevel(it.code, priorQuarter) : null;
          if (cur != null && prior != null && prior !== 0) yoy = (cur / prior - 1) * 100;
          return { code: it.code, name: it.name, weight: lookupAuWeight(it.code), yoy };
        });
        const qSnap = {
          country: 'AU', period: qp.id, headline_yoy: headlineYoy, core_yoy: coreYoy,
          core_yoy_intl: null, items, source_url: SOURCE_URL.replace('/CPI', '/CPI_Q'), fetched_at: '',
        };
        for (const ms of expandQuarterlyToMonthly(qSnap, qp.id)) {
          if (ms.period >= startPeriod && ms.period <= endPeriod && needsQuarterlyBridge(ms.period)) out.push(ms);
        }
      }
    }
  }

  // ── 완전 월별 구간 ──
  if (monthlyRange) {
    const [mStart] = monthlyRange;
    const startMonthly = mStart < COMPLETE_MONTHLY_FIRST_PERIOD ? COMPLETE_MONTHLY_FIRST_PERIOD : mStart;
    const [monthlyPayload, quarterlyPayload] = await Promise.all([
      fetchAbs(AU_RATE_DATAFLOW, `${AU_MEASURE_YOY}..${AU_TSEST_ORIGINAL}.${AU_REGION}.${AU_FREQ_MONTHLY}`, startMonthly),
      fetchAbs(AU_QUARTERLY_DATAFLOW, `${AU_MEASURE_YOY}..${AU_TSEST_SA}.${AU_REGION}.${AU_FREQ_QUARTERLY}`,
        startMonthly < '2025-11' ? '2025-Q4' : `${startMonthly.slice(0, 4)}-Q1`),
    ]);
    if (monthlyPayload) {
      const monthly = parseDataset(monthlyPayload);
      const tmByQuarter = new Map();
      if (quarterlyPayload) {
        const quarterly = parseDataset(quarterlyPayload);
        for (const qp of timePeriods(quarterly)) {
          tmByQuarter.set(qp.id, valueFor(quarterly, AU_TRIMMED_MEAN_INDEX, qp.id, AU_MEASURE_YOY, AU_TSEST_SA, AU_FREQ_QUARTERLY));
        }
      }
      for (const tp of timePeriods(monthly)) {
        if (tp.id < startMonthly || tp.id > endPeriod) continue;
        const headlineYoy = valueFor(monthly, AU_HEADLINE_INDEX, tp.id, AU_MEASURE_YOY, AU_TSEST_ORIGINAL, AU_FREQ_MONTHLY);
        if (headlineYoy == null) continue;
        const coreIntlYoy = valueFor(monthly, AU_CORE_INTL_INDEX, tp.id, AU_MEASURE_YOY, AU_TSEST_ORIGINAL, AU_FREQ_MONTHLY);
        const coreYoy = tmByQuarter.get(periodToQuarter(tp.id)) ?? null;
        const items = AU_CPI_ITEMS.map((it) => ({
          code: it.code, name: it.name, weight: lookupAuWeight(it.code),
          yoy: valueFor(monthly, it.code, tp.id, AU_MEASURE_YOY, AU_TSEST_ORIGINAL, AU_FREQ_MONTHLY),
        }));
        out.push({
          country: 'AU', period: tp.id, headline_yoy: headlineYoy, core_yoy: coreYoy,
          core_yoy_intl: coreIntlYoy, items, source_url: SOURCE_URL, fetched_at: '',
        });
      }
    }
  }

  out.sort((a, b) => a.period.localeCompare(b.period));
  return out;
}

async function main() {
  const { start, end } = computeWindow(new Date());
  console.error(`[diffusion-au] window ${start} ~ ${end} (${BACKFILL_MONTHS}개월), 상세 최근 ${DETAIL_MONTHS}개월`);
  console.error('[diffusion-au] ABS CPI/CPI_Q 조회…');
  const snaps = await fetchAuHistory(start, end);

  const PORT_REF = 'Fenrir a242949 · au.ts/au-bridge.ts 이식';
  const au = buildCountryPayload(snaps, {
    series_id: 'inflation-diffusion-au', display_name: 'AU CPI 확산지수 (ABS, 87품목)',
    country: 'AU', source: 'abs', unit: '%', value_type: 'diffusion', frequency: 'monthly',
    yoy_basis: 'YoY', thresholds: { ge0: 0, ge2: 2, ge25: 2.5, ge3: 3 },
    window: { start, end }, port_ref: PORT_REF,
    footnote: '2025년 11월 이전 호주 데이터는 분기 자료를 월로 펴서 계산 — 변동이 실제보다 작아 보일 수 있음',
    bridge_cutover: COMPLETE_MONTHLY_FIRST_PERIOD,
  });
  console.error(`[diffusion-au] AU ${au.stats.periods}개월(flash skip ${au.stats.flashSkipped}), ${au.stats.earliest}~${au.stats.latest}`);

  const banner = `// data/inflation-diffusion-au.js — 호주 CPI 확산지수 (ABS).\n` +
    `// scripts/fetch-inflation-diffusion-au.mjs 생성. 자동 생성물 — 직접 편집 금지. ${PORT_REF}.\n` +
    `// ⚠️ 2025-11 이전은 분기→월 상수보간(계단형).\n`;
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const { bytes, path } = writeDataFile({
    dataDir: join(scriptDir, '..', 'data'), fileName: 'inflation-diffusion-au.js', banner, logTag: 'diffusion-au',
    entries: [{ key: 'inflation-diffusion-au', payload: au.payload }],
  });
  console.error(`[diffusion-au] 출력 ${(bytes / 1024).toFixed(1)}KB (한도 ${DETAIL_SIZE_LIMIT / 1024}KB) → ${path}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`[diffusion-au] 실패: ${err.message}`); process.exit(1); });
}

export { fetchAuHistory, parseDataset, valueFor };
