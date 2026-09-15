// gen-fixture-us.mjs — 페이지 개발용 픽스처 생성.
//
// 원칙: 수기 목데이터 금지. 합성 "입력"만 만들고, 실제 파이프라인
//   (buildCountryPayload → buildRecord, buildTrimmedPayload)을 그대로 통과시켜
//   실데이터와 스키마가 100% 동일한 출력을 얻는다. 값만 합성, 구조는 진짜.
//
// 출력: tests/fixtures/{inflation-diffusion-us,trimmed-us}.fixture.js
//   → window.FENRIR_FIXTURE[...] 자기등록 (실데이터 전역 FENRIR_SERIES와 분리).
//   페이지는 data/ 실파일 부재 시에만 이 픽스처로 폴백하고 "샘플 데이터" 배지 표시.
//
// 실행:  node scripts/gen-fixture-us.mjs   (키 불필요)

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BLS_CPI_ITEMS } from './lib/us-cpi-items.mjs';
import { lookupWeight } from './lib/us-cpi-weights.mjs';
import { BEA_PCE_ITEMS } from './lib/us-pce-items.mjs';
import { lookupPceWeight } from './lib/us-pce-weights.mjs';
import { EU_HICP_ITEMS } from './lib/eu-hicp-items.mjs';
import { AU_CPI_ITEMS } from './lib/au-cpi-items.mjs';
import { lookupAuWeight } from './lib/au-cpi-weights.mjs';
import { KR_CPI_ITEMS } from './lib/kr-cpi-items.mjs';
import { lookupKrWeight } from './lib/kr-cpi-weights.mjs';
import { JP_CPI_ITEMS } from './lib/jp-cpi-items.mjs';
import { lookupJpWeight } from './lib/jp-cpi-weights.mjs';
import { computeWindow, monthsBetween, buildCountryPayload } from './fetch-inflation-diffusion-us.mjs';
import { US_THRESHOLD_OPTS } from './lib/diffusion-core.mjs';
import { SERIES as TRIMMED_SERIES, buildTrimmedPayload, serializeTrimmed } from './fetch-trimmed-us.mjs';

// 결정론적 기준일 → 재현 가능한 픽스처 (Date.now 미사용).
const REF_DATE = new Date(Date.UTC(2026, 6, 1)); // 윈도우 종료 2026-06

// ── 합성 입력 생성기 (결정론적, 그럴듯한 분포) ──
const round2 = (x) => Math.round(x * 100) / 100;

// 품목 i, 월 인덱스 t의 합성 YoY. 대부분 양수(+2~4%)에 일부 음수(의류·가전 등 디플레),
// 완만한 시간 파동 → 시계열이 실제처럼 움직임.
function synthYoy(i, t) {
  const bias = ((i * 2654435761) % 1000) / 1000;       // 0..1 결정론적
  const center = -1.5 + bias * 5;                        // -1.5..3.5
  const timeWave = 1.2 * Math.cos((t * Math.PI) / 18);   // 완만한 ±1.2
  const wiggle = 0.4 * Math.sin(i * 0.7 + t * 0.9);
  return round2(center + 1.6 + timeWave + wiggle);
}

function synthSnapshots(items, lookup, country, periods, intl = null) {
  return periods.map((period, t) => ({
    country, period,
    headline_yoy: round2(3.3 + 0.9 * Math.cos((t * Math.PI) / 20)),
    core_yoy: round2(3.0 + 0.6 * Math.cos((t * Math.PI) / 22)),
    core_yoy_intl: intl == null ? null : round2(intl + 0.5 * Math.cos((t * Math.PI) / 21)),
    items: items.map((it, i) => ({
      code: it.code, name: it.name, weight: lookup(it.code), yoy: synthYoy(i, t),
    })),
    source_url: 'FIXTURE (synthetic input through real pipeline)',
    fetched_at: '',
  }));
}

function synthTrimmed(seriesDef, periods, t0) {
  // 3종을 살짝 다른 위상/레벨로. rate 시계열 (연율 %), 완만한 하강 추세.
  return periods.map((period, t) => ({
    period,
    value: round2(2.6 + t0 * 0.4 + 0.8 * Math.cos((t * Math.PI) / 24) - t * 0.006),
  }));
}

const FIXTURE_META = {
  'trimmed-pce-dallas': { title: 'Trimmed Mean PCE Inflation Rate', units: 'Percent Change from Year Ago', units_short: '% Chg. from Yr. Ago', seasonal_adjustment: 'NSA' },
  'median-cpi-cleveland': { title: 'Median Consumer Price Index', units: 'Percent Change at Annual Rate', units_short: '% Chg. at Ann. Rate', seasonal_adjustment: 'SA' },
  'trimmed-cpi-cleveland': { title: '16% Trimmed-Mean Consumer Price Index', units: 'Percent Change at Annual Rate', units_short: '% Chg. at Ann. Rate', seasonal_adjustment: 'SA' },
};

function serializeFixtureDiffusion(banner, entries) {
  let body = banner + `window.FENRIR_FIXTURE = window.FENRIR_FIXTURE || {};\n`;
  for (const e of entries) {
    body += `window.FENRIR_FIXTURE[${JSON.stringify(e.key)}] = ${JSON.stringify(e.payload)};\n`;
  }
  return body;
}

function main() {
  const { start, end } = computeWindow(REF_DATE);
  const periods = [...monthsBetween(start, end)];
  const PORT_REF = 'Fenrir a242949 · FIXTURE(합성입력→실파이프라인)';

  // ── 확산 픽스처 (실제 buildCountryPayload 경로) ──
  const cpi = buildCountryPayload(
    synthSnapshots(BLS_CPI_ITEMS, lookupWeight, 'US-CPI', periods),
    { series_id: 'inflation-diffusion-us-cpi', display_name: 'US CPI 확산지수 (BLS, 136품목)',
      country: 'US-CPI', source: 'bls', unit: '%', value_type: 'diffusion', frequency: 'monthly',
      yoy_basis: 'YoY', thresholds: { ge0: 0, ge2: 2, ge25: 2.5, ge3: 3, ge3_5: 3.5 },
      window: { start, end }, port_ref: PORT_REF },
    US_THRESHOLD_OPTS,
  );
  const pce = buildCountryPayload(
    synthSnapshots(BEA_PCE_ITEMS, lookupPceWeight, 'US-PCE', periods),
    { series_id: 'inflation-diffusion-us-pce', display_name: 'US PCE 확산지수 (BEA, 176품목)',
      country: 'US-PCE', source: 'bea', unit: '%', value_type: 'diffusion', frequency: 'monthly',
      yoy_basis: 'YoY', thresholds: { ge0: 0, ge2: 2, ge25: 2.5, ge3: 3, ge3_5: 3.5 },
      window: { start, end }, port_ref: PORT_REF },
    US_THRESHOLD_OPTS,
  );

  const diffBanner = `// tests/fixtures/inflation-diffusion-us.fixture.js — 페이지 개발용 합성 픽스처.\n` +
    `// scripts/gen-fixture-us.mjs 생성. 합성 입력을 실제 파이프라인에 통과시킨 결과 —\n` +
    `// 스키마는 data/inflation-diffusion-us.js와 100% 동일. window.FENRIR_FIXTURE에 등록.\n` +
    `// ⚠️ 샘플 데이터. 실데이터 생성 후 페이지가 자동으로 이 픽스처를 무시함.\n`;
  const diffBody = serializeFixtureDiffusion(diffBanner, [
    { key: 'inflation-diffusion-us-cpi', payload: cpi.payload },
    { key: 'inflation-diffusion-us-pce', payload: pce.payload },
  ]);

  // ── trimmed 픽스처 (실제 buildTrimmedPayload/serializeTrimmed 경로, FENRIR_FIXTURE 전역) ──
  const tStart = '2015-01';
  const tPeriods = [...monthsBetween(tStart, end)];
  const trimmedRegs = TRIMMED_SERIES.map((s, idx) => ({
    key: s.id,
    payload: buildTrimmedPayload(s, FIXTURE_META[s.id], synthTrimmed(s, tPeriods, idx)),
  }));
  const trimmedBanner = `// tests/fixtures/trimmed-us.fixture.js — 페이지 개발용 합성 픽스처.\n` +
    `// scripts/gen-fixture-us.mjs 생성. buildTrimmedPayload 실경로 통과, 스키마 동일.\n` +
    `// ⚠️ 샘플 데이터. 실데이터(data/trimmed-us.js) 생성 후 자동 무시.\n`;
  const trimmedBody = serializeTrimmed(trimmedRegs, trimmedBanner, 'FENRIR_FIXTURE');

  // ── KR·EU·AU 픽스처 (실 정적표 + 실 buildCountryPayload 경로, 국가 탭용) ──
  const euWeight = () => 5; // EU 가중치는 API 유래 → 픽스처는 상수(커버리지 100% 가정)
  const countries = [
    { file: 'inflation-diffusion-eu', key: 'inflation-diffusion-eu', items: EU_HICP_ITEMS, lookup: euWeight,
      country: 'EU', source: 'eurostat', name: 'EU HICP 확산지수 (Eurostat, 292품목)', intl: null,
      note: 'EU는 최종치 D+15 시차 정상.' },
    { file: 'inflation-diffusion-au', key: 'inflation-diffusion-au', items: AU_CPI_ITEMS, lookup: lookupAuWeight,
      country: 'AU', source: 'abs', name: 'AU CPI 확산지수 (ABS, 87품목)', intl: 3.4,
      footnote: '2025년 11월 이전 호주 데이터는 분기 자료를 월로 펴서 계산 — 변동이 실제보다 작아 보일 수 있음' },
    { file: 'inflation-diffusion-kr', key: 'inflation-diffusion-kr', items: KR_CPI_ITEMS, lookup: lookupKrWeight,
      country: 'KR', source: 'kosis', name: 'KR CPI 확산지수 (KOSIS, 458품목)', intl: 2.4,
      note: '코어=농산물·석유류 제외(정책), 국제코어=식료품·에너지 제외.' },
    { file: 'inflation-diffusion-jp', key: 'inflation-diffusion-jp', items: JP_CPI_ITEMS, lookup: lookupJpWeight,
      country: 'JP', source: 'estat', name: 'JP CPI 확산지수 (e-Stat, 582품목)', intl: 1.8,
      note: '전국만, 코어=生鮮食品 제외, 국제코어=生鮮食品·에너지 제외.' },
  ];
  const countryBodies = {};
  for (const c of countries) {
    const built = buildCountryPayload(
      synthSnapshots(c.items, c.lookup, c.country, periods, c.intl),
      { series_id: c.key, display_name: c.name, country: c.country, source: c.source, unit: '%',
        value_type: 'diffusion', frequency: 'monthly', yoy_basis: 'YoY',
        thresholds: { ge0: 0, ge2: 2, ge25: 2.5, ge3: 3 }, window: { start, end }, port_ref: PORT_REF,
        ...(c.note ? { note: c.note } : {}), ...(c.footnote ? { footnote: c.footnote } : {}) },
    );
    const banner = `// tests/fixtures/${c.file}.fixture.js — 페이지 개발용 합성 픽스처(${c.country}).\n` +
      `// scripts/gen-fixture-us.mjs 생성. 실 buildCountryPayload 경로 통과, 스키마 동일.\n` +
      `// ⚠️ 샘플 데이터. 실데이터(data/${c.file}.js) 생성 후 자동 무시.\n`;
    countryBodies[c.file] = { body: serializeFixtureDiffusion(banner, [{ key: c.key, payload: built.payload }]), built };
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const fixDir = join(scriptDir, '..', 'tests', 'fixtures');
  mkdirSync(fixDir, { recursive: true });
  writeFileSync(join(fixDir, 'inflation-diffusion-us.fixture.js'), diffBody, 'utf8');
  writeFileSync(join(fixDir, 'trimmed-us.fixture.js'), trimmedBody, 'utf8');
  for (const [file, { body }] of Object.entries(countryBodies)) {
    writeFileSync(join(fixDir, `${file}.fixture.js`), body, 'utf8');
  }

  const kb = (s) => (Buffer.byteLength(s, 'utf8') / 1024).toFixed(1);
  console.error(`[gen-fixture] window ${start}~${end}, ${periods.length}개월`);
  console.error(`[gen-fixture] CPI 최신 ${cpi.stats.latest} ge2=${cpi.payload.series.at(-1).weighted.ge2}%  PCE ge2=${pce.payload.series.at(-1).weighted.ge2}%`);
  console.error(`[gen-fixture] diffusion(us) ${kb(diffBody)}KB, trimmed ${kb(trimmedBody)}KB`);
  for (const [file, { body, built }] of Object.entries(countryBodies)) {
    console.error(`[gen-fixture] ${file} ${kb(body)}KB · ${built.payload.meta.item_count}품목 · ge2=${built.payload.series.at(-1).weighted.ge2}%`);
  }
  console.error(`[gen-fixture] 저장 → tests/fixtures/*.fixture.js (US·trimmed·EU·AU·KR)`);
}

main();
