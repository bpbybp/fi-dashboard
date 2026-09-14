// fetch-inflation-diffusion-jp.mjs — 일본 CPI 확산지수(e-Stat, 2020기준)를 조회·계산해
// data/inflation-diffusion-jp.js 생성. ESTAT_APP_ID 필요(키드 게이트).
//
// ⚠️ fetcher 로직 이식본 — 원본: Fenrir src/lib/inflation-diffusion/fetchers/jp.ts.
//    기준 커밋 a242949. 방법론은 diffusion-core.mjs·diffusion-pipeline.mjs.
//    수정 시 반드시 Fenrir 원본과 동시 반영 (이중 구현 드리프트 방지).
//
// 특성: e-Stat tab=3(前年同月比 %)를 직접 사용 → 지수 산술 불필요(전년 fetch 없음).
//   전국(area=00000)만 사용, 도쿄 23구 미리보기(13A01) 제외.
//   코어=生鮮食品 제외(0161, 정책), 국제코어=生鮮食品·에너지 제외(0178).
//
// 실행:  ESTAT_APP_ID=xxxx node scripts/fetch-inflation-diffusion-jp.mjs
//    (회사 PC 키 미저장 + 사내 프록시 차단 → 실행·대조는 개인 노트북(clean network).
//     이 스크립트는 키 없이 완성·구조 검증까지만.)

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import {
  JP_AREA_WHOLE_JAPAN, JP_CORE_CAT01, JP_CORE_INTL_CAT01, JP_CPI_ITEMS,
  JP_HEADLINE_CAT01, JP_STATS_DATA_ID, JP_TAB_YOY,
} from './lib/jp-cpi-items.mjs';
import { lookupJpWeight } from './lib/jp-cpi-weights.mjs';
import {
  BACKFILL_MONTHS, DETAIL_MONTHS, DETAIL_SIZE_LIMIT,
  monthsBetween, computeWindow, buildCountryPayload, writeDataFile,
} from './lib/diffusion-pipeline.mjs';
import { fetchWithRetry } from './lib/fetch-retry.mjs';

const ESTAT_BASE = 'https://api.e-stat.go.jp/rest/3.0/app/json/getStatsData';
const SOURCE_URL = ESTAT_BASE;

// "2026-03" → "2026000303" (e-Stat 월별 time: YYYY00MMMM)
function periodToEstatTime(p) { return `${p.slice(0, 4)}00${p.slice(5, 7)}${p.slice(5, 7)}`; }
function estatTimeToPeriod(t) {
  const m = t.match(/^(\d{4})00(\d{2})\d{2}$/);
  if (!m) throw new Error(`Unexpected e-Stat time: ${t}`);
  return `${m[1]}-${m[2]}`;
}

function parseValue(v) {
  if (!v.$) return null;
  if (v.$ === '-' || v.$ === '...' || v.$ === '***') return null;
  const n = parseFloat(v.$);
  return Number.isFinite(n) ? n : null;
}

async function fetchEstat(apiKey, params) {
  const url = new URL(ESTAT_BASE);
  url.searchParams.set('appId', apiKey);
  url.searchParams.set('statsDataId', JP_STATS_DATA_ID);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchWithRetry(url.toString(), {}, { label: 'diffusion-jp' });
  if (!res.ok) throw new Error(`e-Stat HTTP ${res.status}`);
  const json = await res.json();
  const status = json.GET_STATS_DATA?.RESULT?.STATUS;
  if (status !== 0) throw new Error(`e-Stat status=${status}: ${json.GET_STATS_DATA?.RESULT?.ERROR_MSG ?? 'unknown'}`);
  const v = json.GET_STATS_DATA?.STATISTICAL_DATA?.DATA_INF?.VALUE;
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

async function loadEstatWindow(apiKey, cdTimeFrom, cdTimeTo) {
  const values = await fetchEstat(apiKey, {
    cdArea: JP_AREA_WHOLE_JAPAN, cdTab: JP_TAB_YOY, cdTimeFrom, cdTimeTo,
  });
  const byCat01 = new Map();
  for (const v of values) {
    const cat = v['@cat01'], time = v['@time'], num = parseValue(v);
    if (!cat || !time || num == null) continue;
    if (!byCat01.has(cat)) byCat01.set(cat, new Map());
    byCat01.get(cat).set(time, num);
  }
  return byCat01;
}

function buildSnapshotFromIndex(byCat01, targetTime) {
  const headlineYoy = byCat01.get(JP_HEADLINE_CAT01)?.get(targetTime);
  if (headlineYoy == null) return null;
  const coreYoy = byCat01.get(JP_CORE_CAT01)?.get(targetTime) ?? null;
  const coreYoyIntl = byCat01.get(JP_CORE_INTL_CAT01)?.get(targetTime) ?? null;
  const items = JP_CPI_ITEMS.map((it) => ({
    code: it.code, name: it.name, weight: lookupJpWeight(it.code),
    yoy: byCat01.get(it.code)?.get(targetTime) ?? null,
  }));
  return {
    country: 'JP', period: estatTimeToPeriod(targetTime), headline_yoy: headlineYoy,
    core_yoy: coreYoy, core_yoy_intl: coreYoyIntl, items, source_url: SOURCE_URL, fetched_at: '',
  };
}

async function fetchJpHistory(apiKey, startPeriod, endPeriod) {
  // tab=3(YoY 직접) → 전년 앵커 불필요.
  const byCat01 = await loadEstatWindow(apiKey, periodToEstatTime(startPeriod), periodToEstatTime(endPeriod));
  const out = [];
  for (const period of monthsBetween(startPeriod, endPeriod)) {
    const snap = buildSnapshotFromIndex(byCat01, periodToEstatTime(period));
    if (snap) out.push(snap);
  }
  return out;
}

async function main() {
  const apiKey = process.env.ESTAT_APP_ID;
  if (!apiKey) { console.error('[diffusion-jp] ESTAT_APP_ID 환경변수가 없습니다.'); process.exit(1); }

  const { start, end } = computeWindow(new Date());
  console.error(`[diffusion-jp] window ${start} ~ ${end} (${BACKFILL_MONTHS}개월), 상세 최근 ${DETAIL_MONTHS}개월`);
  console.error('[diffusion-jp] e-Stat 0003427113(全国, tab=3 前年同月比) 조회…');
  const snaps = await fetchJpHistory(apiKey, start, end);

  const PORT_REF = 'Fenrir a242949 · jp.ts 이식';
  const jp = buildCountryPayload(snaps, {
    series_id: 'inflation-diffusion-jp', display_name: 'JP CPI 확산지수 (e-Stat, 582품목)',
    country: 'JP', source: 'estat', unit: '%', value_type: 'diffusion', frequency: 'monthly',
    yoy_basis: 'YoY', thresholds: { ge0: 0, ge2: 2, ge25: 2.5, ge3: 3 },
    window: { start, end }, port_ref: PORT_REF,
    note: '전국(area=00000)만, 도쿄23구 미리보기 제외. 코어=生鮮食品 제외, 국제코어=生鮮食品·에너지 제외.',
  });
  console.error(`[diffusion-jp] JP ${jp.stats.periods}개월(flash skip ${jp.stats.flashSkipped}), ${jp.stats.earliest}~${jp.stats.latest}`);

  const banner = `// data/inflation-diffusion-jp.js — 일본 CPI 확산지수 (e-Stat 2020기준).\n` +
    `// scripts/fetch-inflation-diffusion-jp.mjs 생성. 자동 생성물 — 직접 편집 금지. ${PORT_REF}.\n`;
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const { bytes, path } = writeDataFile({
    dataDir: join(scriptDir, '..', 'data'), fileName: 'inflation-diffusion-jp.js', banner, logTag: 'diffusion-jp',
    entries: [{ key: 'inflation-diffusion-jp', payload: jp.payload }],
  });
  console.error(`[diffusion-jp] 출력 ${(bytes / 1024).toFixed(1)}KB (한도 ${DETAIL_SIZE_LIMIT / 1024}KB) → ${path}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`[diffusion-jp] 실패: ${err.message}`); process.exit(1); });
}

export { fetchJpHistory, buildSnapshotFromIndex, periodToEstatTime, estatTimeToPeriod };
