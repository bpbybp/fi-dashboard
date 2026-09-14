// fetch-inflation-diffusion-us.mjs — 미국 물가 확산지수(US-CPI·US-PCE)를 BLS·BEA에서
// 조회해 계산까지 수행하고 data/inflation-diffusion-us.js 생성.
//
// ⚠️ fetcher 로직 이식본 — 원본: Fenrir src/lib/inflation-diffusion/fetchers/us-cpi.ts,
//    us-pce.ts + 백필 파이프라인 backfill/route.ts. 기준 커밋 a242949.
//    확산 방법론은 scripts/lib/diffusion-core.mjs (이 역시 Fenrir 이식본). 방법론·시리즈
//    수정 시 반드시 Fenrir 원본과 동시 반영할 것 (이중 구현 드리프트 방지).
//
// 설계 원칙 (bpbybp 규약):
//  - Node 내장 fetch만 사용 (외부 의존성 0). Node 18+ 필요.
//  - BLS/BEA 공개 데이터 → 원값(지수)에서 파생한 확산율만 저장. 원시 지수 미커밋.
//  - 출력 파일에 wall-clock 타임스탬프 금지. 데이터가 바뀔 때만 파일이 바뀌어야
//    워크플로의 "diff 없으면 커밋 skip"이 정확히 동작. (기준일은 데이터에서 파생.)
//  - data/*.js 자기등록: window.FENRIR_SERIES[...] 전역 할당 (file:// 호환, fetch/JSON 금지).
//
// 실행:  BLS_API_KEY=xxxx BEA_API_KEY=yyyy node scripts/fetch-inflation-diffusion-us.mjs
//
// ⚠️ 키 필요 게이트: 이 스크립트의 실제 실행 + Fenrir 값 대조는 키가 있는 환경(개인
//    노트북)에서 수행. 회사 PC는 키 미저장 원칙 → 코드 완성·구조 검증까지만.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  BLS_CPI_ITEMS, HEADLINE_SERIES_ID, CORE_SERIES_ID,
} from './lib/us-cpi-items.mjs';
import { lookupWeight } from './lib/us-cpi-weights.mjs';
import {
  BEA_PCE_ITEMS, PCE_HEADLINE_LINE, PCE_CORE_LINE, PCE_TABLE,
} from './lib/us-pce-items.mjs';
import { lookupPceWeight } from './lib/us-pce-weights.mjs';
// 공통 파이프라인 (국가 공유 — 방법론 드리프트 방지).
import {
  BACKFILL_MONTHS, DETAIL_MONTHS, DETAIL_SIZE_LIMIT,
  monthsBetween, computeWindow, buildCountryPayload, serializeRegistration, writeDataFile,
} from './lib/diffusion-pipeline.mjs';
import { fetchWithRetry } from './lib/fetch-retry.mjs';

const BLS_API_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const BLS_BATCH_SIZE = 50;
const BLS_SOURCE_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const BEA_API_URL = 'https://apps.bea.gov/api/data/';
const BEA_SOURCE_URL = 'https://apps.bea.gov/api/data/?DataSetName=NIUnderlyingDetail&TableName=U20404';

// BLS 배치 유틸.
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// US-CPI (BLS) — 원본: us-cpi.ts
// ══════════════════════════════════════════════════════════════════════
function blsPeriodToMonthCode(p) { return 'M' + String(parseInt(p.slice(5, 7), 10)).padStart(2, '0'); }
function blsIsValid(d) { return d.value !== '-' && !Number.isNaN(parseFloat(d.value)); }
function blsMonthly(series) { return series.data.filter((d) => d.period >= 'M01' && d.period <= 'M12'); }

function blsPickAt(series, period) {
  const monthly = blsMonthly(series);
  const y = period.slice(0, 4), mc = blsPeriodToMonthCode(period);
  return monthly.find((d) => d.year === y && d.period === mc);
}

function blsYoyForPoint(series, current) {
  if (!current || !blsIsValid(current)) return null;
  const priorYear = String(parseInt(current.year, 10) - 1);
  const prior = blsMonthly(series).find((d) => d.year === priorYear && d.period === current.period);
  if (prior && blsIsValid(prior)) {
    const cur = parseFloat(current.value), prv = parseFloat(prior.value);
    if (prv !== 0) return (cur / prv - 1) * 100;
  }
  const apiYoy = current.calculations?.pct_changes?.['12'];
  if (apiYoy != null) { const v = parseFloat(apiYoy); return Number.isNaN(v) ? null : v; }
  return null;
}

async function blsPostBatch(seriesIds, startYear, endYear, apiKey) {
  const body = JSON.stringify({
    seriesid: seriesIds, startyear: String(startYear), endyear: String(endYear),
    registrationkey: apiKey, calculations: true,
  });
  const res = await fetchWithRetry(BLS_API_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  }, { label: 'diffusion-us/bls' });
  if (!res.ok) throw new Error(`BLS HTTP ${res.status}: ${await res.text().catch(() => '<no body>')}`);
  const json = await res.json();
  if (json.status !== 'REQUEST_SUCCEEDED') {
    throw new Error(`BLS API status=${json.status} — ${(json.message ?? []).join('; ')}`);
  }
  return json.Results?.series ?? [];
}

async function blsLoadAllSeries(startYear, endYear, apiKey) {
  const allIds = [HEADLINE_SERIES_ID, CORE_SERIES_ID, ...BLS_CPI_ITEMS.map((it) => it.seriesId)];
  const byId = new Map();
  for (const batch of chunk(allIds, BLS_BATCH_SIZE)) {
    for (const s of await blsPostBatch(batch, startYear, endYear, apiKey)) byId.set(s.seriesID, s);
  }
  return byId;
}

function blsBuildSnapshot(byId, period) {
  const headline = byId.get(HEADLINE_SERIES_ID);
  if (!headline) return null;
  const hp = blsPickAt(headline, period);
  const headlineYoy = blsYoyForPoint(headline, hp);
  if (headlineYoy == null) return null;

  const coreSeries = byId.get(CORE_SERIES_ID);
  const coreYoy = coreSeries ? blsYoyForPoint(coreSeries, blsPickAt(coreSeries, period)) : null;

  const items = BLS_CPI_ITEMS.map((it) => {
    const s = byId.get(it.seriesId);
    const yoy = s ? blsYoyForPoint(s, blsPickAt(s, period)) : null;
    return { code: it.code, name: it.name, weight: lookupWeight(it.code), yoy };
  });

  return {
    country: 'US-CPI', period, headline_yoy: headlineYoy, core_yoy: coreYoy,
    core_yoy_intl: null, items, source_url: BLS_SOURCE_URL, fetched_at: '',
  };
}

async function fetchCpiHistory(start, end, apiKey) {
  const startYear = parseInt(start.slice(0, 4), 10) - 1;  // YoY 앵커용 전년
  const endYear = parseInt(end.slice(0, 4), 10);
  const byId = await blsLoadAllSeries(startYear, endYear, apiKey);
  const out = [];
  for (const period of monthsBetween(start, end)) {
    const snap = blsBuildSnapshot(byId, period);
    if (snap) out.push(snap);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// US-PCE (BEA) — 원본: us-pce.ts
// ══════════════════════════════════════════════════════════════════════
function beaPeriodToTimePeriod(p) { return `${p.slice(0, 4)}M${p.slice(5, 7)}`; }
function beaParseValue(d) {
  const raw = (d.DataValue ?? '').replace(/,/g, '');
  if (!raw || raw === '...' || raw === '-') return null;
  const v = parseFloat(raw);
  return Number.isNaN(v) ? null : v;
}

async function beaFetchTable(table, yearsCsv, apiKey) {
  const url = new URL(BEA_API_URL);
  url.searchParams.set('UserID', apiKey);
  url.searchParams.set('Method', 'GetData');
  url.searchParams.set('DataSetName', 'NIUnderlyingDetail');
  url.searchParams.set('TableName', table);
  url.searchParams.set('Frequency', 'M');
  url.searchParams.set('Year', yearsCsv);
  url.searchParams.set('ResultFormat', 'JSON');
  const res = await fetchWithRetry(url.toString(), {}, { label: 'diffusion-us/bea' });
  if (!res.ok) throw new Error(`BEA HTTP ${res.status}: ${await res.text().catch(() => '<no body>')}`);
  const json = await res.json();
  const err = json.BEAAPI?.Results?.Error ?? json.BEAAPI?.Error;
  if (err) throw new Error(`BEA error: ${err.APIErrorDescription ?? 'unknown'}`);
  return json.BEAAPI?.Results?.Data ?? [];
}

function beaBuildIndex(rows) {
  const out = new Map();
  for (const r of rows) {
    const ln = parseInt(r.LineNumber, 10);
    if (!out.has(ln)) out.set(ln, []);
    out.get(ln).push(r);
  }
  for (const arr of out.values()) arr.sort((a, b) => b.TimePeriod.localeCompare(a.TimePeriod));
  return out;
}

function beaPickAt(points, period) {
  if (!points) return undefined;
  const tp = beaPeriodToTimePeriod(period);
  return points.find((p) => p.TimePeriod === tp);
}

function beaYoyForPoint(points, current) {
  const cur = beaParseValue(current);
  if (cur == null || cur === 0) return null;
  const priorYear = String(parseInt(current.TimePeriod.slice(0, 4), 10) - 1);
  const prior = points.find((p) => p.TimePeriod === `${priorYear}${current.TimePeriod.slice(4)}`);
  if (!prior) return null;
  const prv = beaParseValue(prior);
  if (prv == null || prv === 0) return null;
  return (cur / prv - 1) * 100;
}

function beaBuildSnapshot(byLine, period) {
  const headlinePoints = byLine.get(PCE_HEADLINE_LINE);
  if (!headlinePoints || headlinePoints.length === 0) return null;
  const hp = beaPickAt(headlinePoints, period);
  if (!hp) return null;
  const headlineYoy = beaYoyForPoint(headlinePoints, hp);
  if (headlineYoy == null) return null;

  const corePoints = byLine.get(PCE_CORE_LINE);
  const cp = beaPickAt(corePoints, period);
  const coreYoy = corePoints && cp ? beaYoyForPoint(corePoints, cp) : null;

  const items = BEA_PCE_ITEMS.map((it) => {
    const points = byLine.get(it.lineNumber);
    const p = beaPickAt(points, period);
    const yoy = points && p ? beaYoyForPoint(points, p) : null;
    return { code: it.code, name: it.name, weight: lookupPceWeight(it.code), yoy };
  });

  return {
    country: 'US-PCE', period, headline_yoy: headlineYoy, core_yoy: coreYoy,
    core_yoy_intl: null, items, source_url: BEA_SOURCE_URL, fetched_at: '',
  };
}

async function fetchPceHistory(start, end, apiKey) {
  const startYear = parseInt(start.slice(0, 4), 10) - 1;
  const endYear = parseInt(end.slice(0, 4), 10);
  const years = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);
  const rows = await beaFetchTable(PCE_TABLE, years.join(','), apiKey);
  const byLine = beaBuildIndex(rows);
  const out = [];
  for (const period of monthsBetween(start, end)) {
    const snap = beaBuildSnapshot(byLine, period);
    if (snap) out.push(snap);
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// 파이프라인/출력은 공통 diffusion-pipeline.mjs 사용 (국가 공유).
// ══════════════════════════════════════════════════════════════════════
async function main() {
  const blsKey = process.env.BLS_API_KEY;
  const beaKey = process.env.BEA_API_KEY;
  if (!blsKey) { console.error('[diffusion-us] BLS_API_KEY 환경변수가 없습니다.'); process.exit(1); }
  if (!beaKey) { console.error('[diffusion-us] BEA_API_KEY 환경변수가 없습니다.'); process.exit(1); }

  const { start, end } = computeWindow(new Date());
  console.error(`[diffusion-us] window ${start} ~ ${end} (${BACKFILL_MONTHS}개월), 상세 최근 ${DETAIL_MONTHS}개월`);

  console.error('[diffusion-us] BLS US-CPI 조회…');
  const cpiSnaps = await fetchCpiHistory(start, end, blsKey);
  console.error('[diffusion-us] BEA US-PCE 조회…');
  const pceSnaps = await fetchPceHistory(start, end, beaKey);

  const PORT_REF = 'Fenrir a242949 · calculator.ts/us-cpi.ts/us-pce.ts 이식';
  const cpi = buildCountryPayload(cpiSnaps, {
    series_id: 'inflation-diffusion-us-cpi', display_name: 'US CPI 확산지수 (BLS, 136품목)',
    country: 'US-CPI', source: 'bls', unit: '%', value_type: 'diffusion', frequency: 'monthly',
    yoy_basis: 'YoY', thresholds: { ge0: 0, ge2: 2, ge25: 2.5, ge3: 3 },
    window: { start, end }, port_ref: PORT_REF,
  });
  const pce = buildCountryPayload(pceSnaps, {
    series_id: 'inflation-diffusion-us-pce', display_name: 'US PCE 확산지수 (BEA, 176품목)',
    country: 'US-PCE', source: 'bea', unit: '%', value_type: 'diffusion', frequency: 'monthly',
    yoy_basis: 'YoY', thresholds: { ge0: 0, ge2: 2, ge25: 2.5, ge3: 3 },
    window: { start, end }, port_ref: PORT_REF,
  });

  const banner = `// data/inflation-diffusion-us.js — 미국 물가 확산지수(US-CPI·US-PCE).\n` +
    `// scripts/fetch-inflation-diffusion-us.mjs 생성. 원시 지수 미저장, 파생 확산율만.\n` +
    `// ⚠️ 자동 생성물 — 직접 편집 금지. 방법론은 ${PORT_REF}.\n`;
  console.error(`[diffusion-us] US-CPI ${cpi.stats.periods}개월(flash skip ${cpi.stats.flashSkipped}), 최신 ${cpi.stats.latest}`);
  console.error(`[diffusion-us] US-PCE ${pce.stats.periods}개월(flash skip ${pce.stats.flashSkipped}), 최신 ${pce.stats.latest}`);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const { bytes, path } = writeDataFile({
    dataDir: join(scriptDir, '..', 'data'), fileName: 'inflation-diffusion-us.js', banner, logTag: 'diffusion-us',
    entries: [
      { key: 'inflation-diffusion-us-cpi', payload: cpi.payload },
      { key: 'inflation-diffusion-us-pce', payload: pce.payload },
    ],
  });
  console.error(`[diffusion-us] 출력 ${(bytes / 1024).toFixed(1)}KB (한도 ${DETAIL_SIZE_LIMIT / 1024}KB) → ${path}`);
}

// 파이프라인 헬퍼는 공통 lib에서 재수출 (기존 테스트·픽스처 생성기 import 호환).
export { computeWindow, monthsBetween, buildCountryPayload, serializeRegistration, DETAIL_MONTHS, DETAIL_SIZE_LIMIT };

// CLI로 직접 실행할 때만 fetch 수행 (테스트에서 import 시 main 미실행).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[diffusion-us] 실패: ${err.message}`);
    process.exit(1);
  });
}
