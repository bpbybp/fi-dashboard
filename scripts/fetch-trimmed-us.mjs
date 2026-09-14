// fetch-trimmed-us.mjs — "튀는 품목을 빼고 본 미국 물가" 3종을 FRED에서 조회해
// data/trimmed-us.js 생성.
//
// 설계 원칙 (bpbybp 규약, fetch-us-inflation.mjs 패턴 준수):
//  - Node 내장 fetch만 사용 (외부 의존성 0). Node 18+ 필요.
//  - FRED 공개 데이터 → 발표된 rate 시계열 그대로 저장 무방.
//  - 출력 파일에 wall-clock 타임스탬프 금지 (기준일은 데이터에서 파생 → diff-skip 정확).
//  - data/*.js 자기등록: window.FENRIR_SERIES[...] 전역 할당 (file:// 호환).
//
// ⚠️ 시리즈 ID는 후보 — 실행 시 FRED /series 메타(title·units)로 정체 검증할 것.
//    이 스크립트는 조회와 동시에 메타를 stderr로 출력해 대조를 돕는다. ID/정의가
//    다르면 임의 교체하지 말고 중단·질문 (Fenrir 방법론 각주와 정합 유지).
//
// 실행:  FRED_API_KEY=xxxx node scripts/fetch-trimmed-us.mjs
//    (키 필요 게이트 — 회사 PC 미저장 원칙. 개인 노트북에서 실행·검증.)

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchWithRetry } from './lib/fetch-retry.mjs';

// 백필 시작: 15년+ 확보 (다른 물가 모듈과 정합). rate 시계열이라 크기 작음.
const OBSERVATION_START = '2009-01-01';

// 3종 — "가장 많이 오르내린 품목을 잘라내고 남은 몸통 물가".
// blurb: Phase 2 페이지 카드의 "쉬운 설명 한 줄"로 사용.
export const SERIES = [
  {
    id: 'trimmed-pce-dallas', fred: 'PCETRIM12M159SFRBDAL',
    display_name: '댈러스 연은 Trimmed Mean PCE (12M)',
    blurb: '위아래로 가장 많이 튄 품목을 잘라내고 남은 물가 — 1년 전과 비교한 값',
  },
  {
    id: 'median-cpi-cleveland', fred: 'MEDCPIM158SFRBCLE',
    display_name: '클리블랜드 연은 Median CPI',
    blurb: '품목을 물가상승률 순으로 줄 세웠을 때 딱 한가운데 품목의 물가 — 최근 한 달 변화를 1년치로 환산한 값 (댈러스 지표와 잣대가 다름)',
  },
  {
    id: 'trimmed-cpi-cleveland', fred: 'TRMMEANCPIM158SFRBCLE',
    display_name: '클리블랜드 연은 16% Trimmed-Mean CPI',
    blurb: '양 끝 16%씩 튀는 품목을 잘라내고 남은 몸통 물가 — 최근 한 달 변화를 1년치로 환산한 값 (댈러스 지표와 잣대가 다름)',
  },
];

const API_KEY = process.env.FRED_API_KEY;

function toPeriod(fredDate) { return fredDate.slice(0, 7); }

// 시리즈 정의 + FRED 메타 + 관측치 → 출력 payload. fetch와 픽스처 생성이 공유하는
// 단일 직렬화 경로 (스키마 100% 동일 보장).
export function buildTrimmedPayload(s, fredMeta, data) {
  const last = data[data.length - 1];
  return {
    meta: {
      series_id: s.id, fred_code: s.fred, display_name: s.display_name,
      blurb: s.blurb, source: 'fred',
      fred_title: fredMeta.title, unit: fredMeta.units, unit_short: fredMeta.units_short,
      value_type: 'rate', frequency: 'monthly',
      seasonal_adjustment: fredMeta.seasonal_adjustment,
      last_updated: last.period,
    },
    data,
  };
}

// key→payload 등록 목록 → 자기등록 JS 본문. globalName으로 실데이터/픽스처 전역 분리.
export function serializeTrimmed(registrations, banner, globalName = 'FENRIR_SERIES') {
  let body = banner + `window.${globalName} = window.${globalName} || {};\n`;
  for (const r of registrations) {
    body += `window.${globalName}[${JSON.stringify(r.key)}] = ${JSON.stringify(r.payload)};\n`;
  }
  return body;
}

async function fredGet(path, params) {
  const url = new URL(`https://api.stlouisfed.org/fred/${path}`);
  url.searchParams.set('api_key', API_KEY);
  url.searchParams.set('file_type', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'fi-dashboard/trimmed-us' } },
    { label: 'trimmed-us' });
  if (!res.ok) {
    throw new Error(`FRED ${path} HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  return res.json();
}

// 시리즈 메타(정체 검증용) — title·units·frequency·seasonal_adjustment.
async function fetchSeriesMeta(fredCode) {
  const json = await fredGet('series', { series_id: fredCode });
  const s = json?.seriess?.[0];
  if (!s) throw new Error(`FRED ${fredCode}: series 메타 누락`);
  return {
    title: s.title, units: s.units, units_short: s.units_short,
    frequency: s.frequency_short, seasonal_adjustment: s.seasonal_adjustment_short,
    last_updated: s.last_updated,
  };
}

async function fetchObservations(fredCode, start) {
  const json = await fredGet('series/observations', {
    series_id: fredCode, observation_start: start,
  });
  if (!json || !Array.isArray(json.observations)) throw new Error(`FRED ${fredCode}: observations 누락`);
  const data = json.observations
    .filter((o) => o.value !== '.' && o.value !== '' && o.value != null)
    .map((o) => ({ period: toPeriod(o.date), value: Number(o.value) }))
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  if (data.length === 0) throw new Error(`FRED ${fredCode}: 유효 관측치 0`);
  return data;
}

async function main() {
  if (!API_KEY) { console.error('[trimmed-us] FRED_API_KEY 환경변수가 없습니다.'); process.exit(1); }
  console.error(`[trimmed-us] observation_start=${OBSERVATION_START}, 시리즈 ${SERIES.length}종`);
  const registrations = [];

  for (const s of SERIES) {
    const meta = await fetchSeriesMeta(s.fred);
    const data = await fetchObservations(s.fred, OBSERVATION_START);
    const last = data[data.length - 1];
    // 정체 검증 대조 출력.
    console.error(`  ${s.id.padEnd(22)} ${s.fred}`);
    console.error(`      title="${meta.title}"`);
    console.error(`      units="${meta.units}" freq=${meta.frequency} SA=${meta.seasonal_adjustment} · ${data.length}개월 최신 ${last.period}=${last.value}`);
    registrations.push({ key: s.id, payload: buildTrimmedPayload(s, meta, data) });
  }

  const banner = `// data/trimmed-us.js — "튀는 품목을 빼고 본 미국 물가" 3종 (FRED).\n` +
    `// scripts/fetch-trimmed-us.mjs 생성. 자동 생성물 — 직접 편집 금지.\n`;
  const body = serializeTrimmed(registrations, banner);

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const dataDir = join(scriptDir, '..', 'data');
  mkdirSync(dataDir, { recursive: true });
  const outPath = join(dataDir, 'trimmed-us.js');
  writeFileSync(outPath, body, 'utf8');
  console.error(`[trimmed-us] 출력 크기 ${(Buffer.byteLength(body, 'utf8') / 1024).toFixed(1)}KB`);
  console.error(`[trimmed-us] 저장 완료 → ${outPath}`);
}

// CLI로 직접 실행할 때만 fetch (테스트·픽스처 생성 시 import는 main 미실행).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[trimmed-us] 실패: ${err.message}`);
    process.exit(1);
  });
}
