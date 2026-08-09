// 인포맥스 종목별 민평 xlsx → data/onoff-ktb3y.js 변환기 (node)
// 파싱·변환·직렬화·검증은 js/onoff-parse.js 공유 모듈에 위임 — onoff-admin 브라우저 파서와
// 동일 로직을 써 산출물이 바이트 동일함을 보장한다(세대 정렬·스프레드 산출 포함).
// 이 파일은 파일 I/O·SheetJS 로드(node)만 담당한다. 원본 xlsx 는 .gitignore(*.xlsx)로 커밋 금지.
//
// 실행: node tools/convert-onoff.mjs
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildDataset, serialize, validateStructure } from '../js/onoff-parse.js';

const require = createRequire(import.meta.url);
const XLSX = require('../vendor/xlsx.min.js'); // UMD 번들 재사용 (node에서 require 가능)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 루트에 xlsx 가 여럿(크레딧 composite 등) → 종목별 민평 파일만 고른다.
// 파일명에 '지표' 또는 'ktb3y' 포함, 아니면 Sheet1 row1 이 '국고…(태그)' 인 파일.
function pickXlsx() {
  const xs = readdirSync(ROOT).filter(f => f.endsWith('.xlsx'));
  const byName = xs.find(f => /지표|ktb3y/i.test(f));
  if (byName) return byName;
  for (const f of xs) {
    try {
      const wb = XLSX.read(readFileSync(join(ROOT, f)), { type: 'buffer' });
      const ws = wb.Sheets['Sheet1'];
      if (!ws) continue;
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
      if ((aoa[1] || []).some(v => typeof v === 'string' && /^국고\d{5}-\d{4}\(\d{2}-\d+\)/.test(v))) return f;
    } catch { /* skip */ }
  }
  return null;
}

const xlsxName = pickXlsx();
if (!xlsxName) { console.error('❌ 루트에서 종목별 민평 xlsx 를 찾지 못했습니다.'); process.exit(1); }

const wb = XLSX.read(readFileSync(join(ROOT, xlsxName)), { type: 'buffer' });
const ws = wb.Sheets['Sheet1'];
if (!ws) { console.error('❌ 시트 `Sheet1` 없음.'); process.exit(1); }
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

const dataset = buildDataset(aoa);
let stats;
try {
  stats = validateStructure(dataset);
} catch (err) {
  console.error('❌ ' + err.message);
  process.exit(1);
}
const out = serialize(dataset);

const outPath = join(ROOT, 'data', 'onoff-ktb3y.js');

// --- 파괴적 덮어쓰기 방지 ---
// writeFileSync 는 기존 산출물을 통째로 갈아엎는다. xlsx 조회 범위를 좁게 뽑거나 종목 구성이
// 달라지면 과거 이력이 조용히 잘려나가고, update-onoff.bat 은 그 축소분을 '변경'으로 보고
// 그대로 커밋·push 한다. 아래 두 장치로 그 경로를 끊는다: (1) 항상 백업, (2) 축소면 중단.

// 기존 산출물 로드 — data/onoff-ktb3y.js 는 `window.ONOFF_KTB3Y = {…}` 대입문 한 덩어리다.
// 전역 오염 없이 읽으려 vm 샌드박스에 window 만 넣고 평가한다(update-onoff.bat 과 동일 방식).
function readExisting(path) {
  if (!existsSync(path)) return null;
  const sandbox = { window: {} };
  runInNewContext(readFileSync(path, 'utf8'), sandbox);
  const d = sandbox.window.ONOFF_KTB3Y;
  if (!d || !Array.isArray(d.generations) || !d.generations.length) return null;
  return d;
}

// 데이터셋의 최고(最古) 관측일 — 전 세대 start 의 최소값.
const oldestOf = d => d.generations.reduce((m, g) => (m === null || g.start < m ? g.start : m), null);

let prev = null;
try {
  prev = readExisting(outPath);
} catch (err) {
  console.error('❌ 기존 산출물을 읽지 못했습니다 — 축소 감지를 건너뛸 수 없어 중단합니다.');
  console.error('   ' + err.message);
  process.exit(1);
}

if (prev) {
  const prevOldest = oldestOf(prev), nextOldest = oldestOf(dataset);
  const shrinkGen = dataset.generations.length < prev.generations.length;
  const shrinkHist = nextOldest > prevOldest; // 최고 일자가 뒤로 밀림 = 과거 이력 잘림
  if (shrinkGen || shrinkHist) {
    const detail = [
      `   세대 수   기존 ${prev.generations.length} → 신규 ${dataset.generations.length}` +
        (shrinkGen ? '  ← 축소' : ''),
      `   최고 일자 기존 ${prevOldest} → 신규 ${nextOldest}` +
        (shrinkHist ? '  ← 이력 잘림' : ''),
    ];
    if (process.env.ONOFF_ALLOW_SHRINK === '1') {
      console.warn('⚠ 산출물 축소 감지 — ONOFF_ALLOW_SHRINK=1 이므로 우회하고 진행합니다.');
      detail.forEach(l => console.warn(l));
    } else {
      console.error('❌ 산출물 축소 감지 — 쓰기를 중단했습니다. 기존 data/onoff-ktb3y.js 는 그대로입니다.');
      detail.forEach(l => console.error(l));
      console.error('   원본 xlsx 의 조회 기간·종목 구성을 확인하세요.');
      console.error('   의도한 축소라면 ONOFF_ALLOW_SHRINK=1 을 설정하고 다시 실행하세요.');
      process.exit(1);
    }
  }
}

// 백업 — 실패하면 쓰지 않는다(복구 수단 없이 덮어쓰는 상황을 만들지 않기 위함).
if (existsSync(outPath)) {
  const t = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-` +
                `${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
  const backupDir = join(ROOT, 'data', '_backup');
  const backupPath = join(backupDir, `onoff-ktb3y.${stamp}.js`);
  try {
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(outPath, backupPath);
    console.log(`🗄  백업 → ${backupPath}`);
  } catch (err) {
    console.error('❌ 백업 실패 — 덮어쓰지 않고 중단합니다.');
    console.error('   ' + err.message);
    process.exit(1);
  }
}

writeFileSync(outPath, out);

const sizeKB = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log('✅ 구조 검증 통과 —', xlsxName);
console.log(`   세대 수: ${stats.nGen} | updated: ${stats.updated}`);
const c = stats.current;
console.log(`   현재 세대 ${c.tag} (vs ${c.vs}, slope vs ${c.slopeVs}): ${c.rows}행 ${c.first} ~ ${c.last}`);
console.log(`   현재 fly ${c.fly}bp (raw ${c.raw} / slope ${c.slope})`);
console.log(`   → ${outPath} (${sizeKB} KB)`);
