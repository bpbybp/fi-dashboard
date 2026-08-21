// build-cs1.mjs — CS-1 크레딧 섹터 스프레드 모니터 빌더.
//   composite xlsx 의 `yield` 시트 → data/cs1/spreads.json
//
// 확장자 주: 명령서는 build-cs1.js 였으나 이 레포엔 package.json 이 없어 `.js` 는 CJS 로
//   해석된다(= import 문 불가). ESM 툴은 전부 `.mjs` 라는 기존 관례(convert-composite.mjs,
//   update-curve-data.mjs)를 따랐다.
//
// 실행: node tools/build-cs1.mjs [xlsx경로]
//   인자를 안 주면 레포 루트에서 '만기확장' → 'composite' 순으로 찾는다
//   (convert-composite.mjs 와 같은 탐색 규칙. *.xlsx 는 .gitignore 대상이라 레포에 안 들어간다).
//
// ─────────────────────────────────────────────────────────────────────────────
// [전량 재생성 — first-print append-only 원칙의 명시적 예외]
//   이 레포의 다른 데이터 모듈(ECOS·FRED 등 외부 API 수집분)은 한 번 찍힌 값을 덮지 않는
//   append-only 규약을 따른다. 그 규약은 "원본이 사라지고 우리 파일만 남는" 수집형에서
//   의미가 있다. CS-1 은 다르다 — 진실의 소스가 매일 통째로 갱신되는 xlsx 자체이고,
//   과거 구간까지 포함한 전체 히스토리가 항상 그 안에 들어 있다. 따라서 매 빌드마다
//   전량 재생성하며, 소스가 과거 값을 정정하면 산출물도 따라 정정되는 것이 옳다.
//   (민평 소급 정정이 실제로 일어난다. append-only 로 묶으면 그 정정을 반영할 길이 없다.)
// ─────────────────────────────────────────────────────────────────────────────
//
// 파싱·계산·직렬화는 전부 js/cs1/cs1-parse.js 에 있다. 이 파일은 파일 I/O 와
// SheetJS 로드만 한다. 공유 모듈(js/credit-parse.js 등)은 import 하지 않는다 — CS-1 의
// 변경이 라이브 커브 RV 파이프라인으로 새지 않게 하려는 의도적 분리다.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import {
  KTB_CODE, SCAN_ROWS, buildSpreads, extractBlocks, findLayout, serialize,
} from '../js/cs1/cs1-parse.js';

const require = createRequire(import.meta.url);
const XLSX = require('../vendor/xlsx.min.js'); // UMD 번들 재사용 (node 에서 require 가능)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = join(ROOT, 'data', 'cs1', 'spreads.json');
const SCHEMA_VERSION = 1;

const die = (msg) => { console.error('❌ ' + msg); process.exit(1); };

// ── 1) 소스 xlsx 찾기 ──
function resolveSource(argPath) {
  if (argPath) {
    const p = resolve(argPath);
    if (!existsSync(p)) die(`xlsx 를 찾을 수 없습니다: ${p}`);
    return p;
  }
  const xs = readdirSync(ROOT).filter((f) => f.endsWith('.xlsx') && !f.startsWith('~$'));
  const pick = xs.find((f) => f.includes('만기확장')) || xs.find((f) => f.includes('composite'));
  if (!pick) {
    die('레포 루트에서 composite xlsx 를 찾지 못했습니다.\n' +
        `   루트의 xlsx: ${xs.length ? xs.join(', ') : '(없음)'}\n` +
        '   경로를 직접 주려면: node tools/build-cs1.mjs <xlsx경로>');
  }
  return join(ROOT, pick);
}

const srcPath = resolveSource(process.argv[2]);
console.log(`소스: ${basename(srcPath)}`);

// ── 2) 시트 로드 ──
// cellFormula:true — 블록 매핑이 17행 수식 문자열에 들어 있는 BONDAVG 코드와 출력 범위에
//   전적으로 의존한다. 캐시된 값만으로는 어느 열이 어느 시리즈인지 알 방법이 없다.
const wb = XLSX.read(readFileSync(srcPath), { type: 'buffer', cellFormula: true });
const ws = wb.Sheets['yield'];
if (!ws) die(`시트 \`yield\` 가 없습니다. 발견된 시트: ${wb.SheetNames.join(', ')}`);

const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

// 수식은 AOA 에 안 실린다. 앞쪽 SCAN_ROWS 행만 셀 단위로 훑어 수식 격자를 만든다.
const range = XLSX.utils.decode_range(ws['!ref']);
const formulaRows = [];
for (let r = range.s.r; r <= Math.min(range.e.r, SCAN_ROWS); r++) {
  const row = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    row[c] = cell && cell.f ? cell.f : null;
  }
  formulaRows[r] = row;
}

// index 시트의 코드→이름은 Title= 이 없는 시리즈에 대한 fallback 으로만 쓴다.
//   (index 는 '금융채 산금채 AAA', Title= 은 '산금채AAA' — 후자가 기존 섹터 표기와 일치한다.)
const codeNames = {};
const idxWs = wb.Sheets['index'];
if (idxWs) {
  for (const row of XLSX.utils.sheet_to_json(idxWs, { header: 1, raw: true })) {
    const [name, code] = row || [];
    if (typeof code === 'string' && /^BONDAVG\d+$/.test(code.trim()) && name) codeNames[code.trim()] = String(name).trim();
  }
}

// ── 3) 파싱 → 스프레드 ──
let layout, blocks, skipped, built;
try {
  layout = findLayout({ formulaRows, aoa });
  ({ blocks, skipped } = extractBlocks({ formulaRow: layout.formulaRow, labelRow: layout.labelRow, codeNames }));
  built = buildSpreads({ blocks, rows: aoa.slice(layout.labelRowIdx + 1) });
} catch (err) {
  die(err.message);
}

console.log(`레이아웃: 수식 ${layout.formulaRowIdx + 1}행 · 만기라벨 ${layout.labelRowIdx + 1}행`);
console.log(`블록 ${blocks.length}개 (국고 ${KTB_CODE} 포함) · 만기 ${built.tenors.length} · 데이터 ${built.dates.length}행`);
for (const s of skipped) console.warn(`⚠️  블록 제외: ${s.code} (${s.name}) — ${s.reason}`);
for (const m of built.crossMissing) console.warn(`⚠️  섹터간 페어 생략: ${m.x}${m.y} — 소스에 없음: ${m.missing.join(', ')}`);

// index 시트에도 Title= 에도 없어 코드가 그대로 이름이 된 시리즈 — 실패시키지 않고 알리기만 한다.
const unnamed = blocks.filter((b) => b.name === b.code || b.name.startsWith(b.code + '('));
for (const b of unnamed) console.warn(`⚠️  이름 미상 시리즈: ${b.code} → 코드를 그대로 씁니다(수록은 정상).`);

// ── 4) 산출물 검증 (조용한 퇴화 방지) ──
if (!built.dates.length) die('데이터 행이 0건입니다.');
for (let i = 1; i < built.dates.length; i++) {
  if (built.dates[i] <= built.dates[i - 1]) {
    die(`일자 정렬 위반: ${built.dates[i - 1]}${built.dates[i]} (행 ${i}). 소스 정렬을 확인하세요.`);
  }
}
if (!built.seriesOrder.length) die('스프레드 시리즈가 0건입니다.');
for (const id of built.seriesOrder) {
  for (const t of built.tenors) {
    const arr = built.series[id][t];
    if (!arr || arr.length !== built.dates.length) die(`길이 불일치: ${id}/${t} — ${arr ? arr.length : 'undefined'} ≠ ${built.dates.length}`);
  }
}

const doc = {
  meta: {
    schema_version: SCHEMA_VERSION,
    module: 'cs1',
    source: 'composite-xlsx/yield',   // spread 시트가 아니라 원데이터에서 직접 계산했음을 남긴다
    source_file: basename(srcPath),
    built: new Date().toISOString().slice(0, 10),
    sourceLastDate: built.dates[built.dates.length - 1],
    firstDate: built.dates[0],
    unit: 'bp',
    benchmark: built.sectors[0],
    rounding: 'bp, 1 decimal, at computation',
    sectors: built.sectors,
    codes: built.codes,
    tenors: built.tenors,
    tenorYears: built.tenorYears,
    seriesOrder: built.seriesOrder,
  },
  dates: built.dates,
  series: built.series,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
const text = serialize(doc);
writeFileSync(OUT_PATH, text);

// ── 5) 요약 ──
const vsKtb = built.seriesOrder.filter((id) => id.endsWith('_vs_' + built.sectors[0]));
const cross = built.seriesOrder.filter((id) => !id.endsWith('_vs_' + built.sectors[0]));
const lastOf = (id, t) => { const a = built.series[id][t]; for (let i = a.length - 1; i >= 0; i--) if (a[i] != null) return a[i]; return null; };
const show = (id) => `   ${id}  3년 ${lastOf(id, '3년')}bp`;

console.log(`\n✅ ${built.dates[0]} ~ ${built.dates[built.dates.length - 1]} · vs-국고 ${vsKtb.length} + 섹터간 ${cross.length} = ${built.seriesOrder.length}페어 × ${built.tenors.length}만기`);
for (const id of [...vsKtb.slice(0, 4), ...cross]) console.log(show(id));
console.log(`   → ${OUT_PATH} (${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)} MB)`);
