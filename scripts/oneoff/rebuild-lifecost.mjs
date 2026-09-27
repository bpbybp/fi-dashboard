// rebuild-lifecost.mjs — 일회성. 재실행 금지. 정상 갱신은 admin 병합.
//
// 66652f9(2026-08-03)부터 data/kr-cpi-lifecost.js 가 총지수 값(375개월)으로 오염돼 있어,
// "저장 이력이 기준" 원칙의 admin 병합으로는 복구할 수 없다(기준년 변경 의심으로 중단됨).
// KOSIS 생활물가지수 전체 기간 CSV 로 파일을 한 번 재생성한다. 검증 전부 통과 + --write 일 때만 교체.
//
// 사용:
//   node scripts/oneoff/rebuild-lifecost.mjs --csv <전체기간 CSV> --check-csv <최근 CSV> [--expect-start YYYY-MM] [--write]

import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

import { parseKosisCsv, matchRow, normKey } from '../../js/csv-parse.js';
import { getConfig } from '../../js/series-config.js';
import { computeYY } from '../../js/calc.js';
import { buildDataFileContent } from '../../js/data-file.js';

const ID = 'kr-cpi-lifecost';
const DATA = new URL('../../data/', import.meta.url);
const EXPECT_END = '2026-08';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}
const csvPath = arg('csv');
const checkPath = arg('check-csv');
const expectStart = arg('expect-start', '1995-01'); // 2026-09-27 실행: KOSIS 생활물가지수 시작월(오염본 1995-04는 당시 CSV 조회 기간)
const write = process.argv.includes('--write');
if (!csvPath || !checkPath) {
  console.error('사용: --csv <전체기간 CSV> --check-csv <최근 CSV> [--expect-start YYYY-MM] [--write]');
  process.exit(2);
}

function loadStored(id) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(new URL(`${id}.js`, DATA), 'utf8'), ctx);
  return ctx.window.FENRIR_SERIES[id];
}
function lifecostRow(path) {
  const row = matchRow(parseKosisCsv(readFileSync(path, 'utf8')), getConfig(ID).kosis_hint);
  if (!row) throw new Error(`${path}: 생활물가지수 행을 찾지 못함`);
  if (normKey(row.account) !== '생활물가지수') throw new Error(`${path}: 매칭 행이 생활물가지수가 아님 (${row.account})`);
  return row;
}
const shift = (k, n) => {
  const [y, m] = k.split('-').map(Number);
  const t = y * 12 + m - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};

const row = lifecostRow(csvPath);
const series = [...row.points].sort((a, b) => (a.period < b.period ? -1 : 1));
const checkRow = lifecostRow(checkPath);
const headline = new Map(loadStored('kr-cpi-headline').series.map((p) => [p.period, p.value]));
const yy = new Map(computeYY(series).map((p) => [p.period, p.value]));

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// a) 총지수와 값이 같은 달 0개
const same = series.filter((p) => headline.get(p.period) === p.value).map((p) => p.period);
check('a) 총지수와 값이 같은 달 0개', same.length === 0, `${same.length}개${same.length ? ` (${same.slice(0, 5).join(', ')}…)` : ''}`);

// b) 마지막 13개월 = 최근 CSV 값
const checkMap = new Map(checkRow.points.map((p) => [p.period, p.value]));
const last13 = series.slice(-13);
const mism = last13.filter((p) => checkMap.get(p.period) !== p.value)
  .map((p) => `${p.period} ${p.value}≠${checkMap.get(p.period)}`);
check('b) 마지막 13개월 = 최근 CSV', last13.length === 13 && mism.length === 0,
  `${last13[0]?.period}~${last13.at(-1)?.period}${mism.length ? ` 불일치 ${mism.join('; ')}` : ' 일치'}`);

// c) 전년동월비 2026-08 = 3.2, 2026-07 = 2.5±0.1
const y08 = yy.get('2026-08');
const y07 = yy.get('2026-07');
check('c) y-y 2026-08 → 3.2, 2026-07 → 2.5±0.1',
  y08 !== undefined && Math.round(y08 * 10) / 10 === 3.2 && y07 !== undefined && Math.abs(y07 - 2.5) <= 0.1 + 1e-9,
  `2026-07 ${y07?.toFixed(3)}, 2026-08 ${y08?.toFixed(3)}`);

// d) 기간 expectStart~2026-08, 누락 0
const gaps = [];
for (let i = 1; i < series.length; i++) {
  if (series[i].period !== shift(series[i - 1].period, 1)) gaps.push(`${shift(series[i - 1].period, 1)}~${shift(series[i].period, -1)}`);
}
check(`d) 기간 ${expectStart}~${EXPECT_END}, 누락 0`,
  series[0]?.period === expectStart && series.at(-1)?.period === EXPECT_END && gaps.length === 0,
  `실제 ${series[0]?.period}~${series.at(-1)?.period} (${series.length}개월), 누락 ${gaps.length ? gaps.join(', ') : '0'}`);

console.log(`입력 행: "${row.account}" (${csvPath})`);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name} — ${c.detail}`);

if (!checks.every((c) => c.ok)) {
  console.log('검증 실패 — 파일을 교체하지 않습니다.');
  process.exit(1);
}
if (!write) {
  console.log('검증 통과 (dry-run). 교체하려면 --write.');
  process.exit(0);
}
const { meta } = loadStored(ID);
const content = buildDataFileContent(ID, series, meta, [
  'KR 생활물가지수 (KOSIS, 2020=100)',
  `일회성 재생성 — scripts/oneoff/rebuild-lifecost.mjs (${new Date().toISOString().slice(0, 10)}). 66652f9 총지수 오염 복구. 이후 갱신은 admin 병합.`,
]);
writeFileSync(new URL(`${ID}.js`, DATA), content);
console.log(`교체 완료: data/${ID}.js (${series.length}개월, ${series[0].period}~${series.at(-1).period})`);
