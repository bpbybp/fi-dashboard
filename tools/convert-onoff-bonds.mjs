// 인포맥스 종목별 민평 xlsx → data/onoff-bonds.js 변환기 (node)
// 종목 단위 상대금리 파이프라인. 세대 파이프라인(tools/convert-onoff.mjs → data/onoff-ktb3y.js)과
// 병행하며 서로의 산출물을 건드리지 않는다. 파싱·상대화·직렬화·검증은 js/onoff-bonds-parse.js 에
// 위임하고, 이 파일은 파일 I/O·SheetJS 로드·가드만 담당한다.
// 원본 xlsx 는 .gitignore(*.xlsx)로 커밋 금지. 산출물에는 상대 bp 만 들어간다(라이선스).
//
// 실행: node tools/convert-onoff-bonds.mjs
//   ONOFF_BONDS_ALLOW_SHRINK=1 이면 축소 감지 가드를 우회한다.
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseBonds, classifyTenor, buildRelative, serializeBonds, validateBonds,
} from '../js/onoff-bonds-parse.js';

const require = createRequire(import.meta.url);
const XLSX = require('../vendor/xlsx.min.js'); // UMD 번들 재사용 (node에서 require 가능)

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// 루트 xlsx 중 '내용'으로만 고른다 — 파일명 규칙(지표/ktb3y)은 쓰지 않는다.
// 판정: Sheet1 row1 에 '국고NNNNN-YYMM(YY-N)' 형태 종목명이 하나라도 있으면 대상.
function pickXlsx() {
  for (const f of readdirSync(ROOT).filter(x => x.endsWith('.xlsx'))) {
    try {
      const ws = XLSX.read(readFileSync(join(ROOT, f)), { type: 'buffer' }).Sheets['Sheet1'];
      if (!ws) continue;
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
      if ((aoa[1] || []).some(v => typeof v === 'string' && /^국고\d{5}-\d{4}\(\d{2}-\d+\)/.test(v))) return f;
    } catch { /* 열리지 않는 파일은 후보에서 제외 */ }
  }
  return null;
}

const xlsxName = pickXlsx();
if (!xlsxName) { console.error('❌ 루트에서 종목별 민평 xlsx 를 찾지 못했습니다.'); process.exit(1); }

const ws = XLSX.read(readFileSync(join(ROOT, xlsxName)), { type: 'buffer' }).Sheets['Sheet1'];
if (!ws) { console.error('❌ 시트 `Sheet1` 없음.'); process.exit(1); }
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });

// 경고는 모아서 마지막에 한 번에 보여준다(단계별로 흩뿌리면 요약이 묻힌다).
const warnings = [];
const onWarn = m => warnings.push(m);

let dataset, out, stats;
try {
  const parsed = parseBonds(aoa, onWarn);
  for (const b of parsed) b.tenor = classifyTenor(b, onWarn);

  const rel = buildRelative(parsed, onWarn);

  const bonds = parsed
    .map(b => {
      const series = rel.byTag.get(b.tag) || [];
      return {
        tag: b.tag, tenor: b.tenor, maturity: b.maturity, coupon: b.coupon,
        first: series.length ? series[0][0] : b.first,
        last: series.length ? series[series.length - 1][0] : b.last,
        series,
      };
    })
    .sort((a, b) => (a.maturity < b.maturity ? -1 : a.maturity > b.maturity ? 1 : (a.tag < b.tag ? -1 : 1)));

  dataset = {
    updated: bonds.reduce((m, b) => (b.last > m ? b.last : m), ''),
    anchorNote:
      `일자별 최단만기 종목을 앵커로 잡고 앵커 대비 bp 로 상대화한 뒤, 앵커 교체 ${rel.anchorLog.length}회를 ` +
      `구·신 앵커가 함께 관측된 직전 영업일의 스프레드로 이어 붙여 단일 기준(base ${rel.baseTag})으로 통일했다. ` +
      `절대 레벨은 복원되지 않으며, 서로 다른 일자의 레벨 비교는 누적 오차를 포함한다.`,
    anchorLog: rel.anchorLog,
    bonds,
  };

  out = serializeBonds(dataset);
  stats = validateBonds(dataset, onWarn);
} catch (err) {
  console.error('❌ ' + err.message);
  if (warnings.length) { console.error('   (경고 ' + warnings.length + '건)'); warnings.forEach(m => console.error('   ⚠ ' + m)); }
  process.exit(1);
}

const outPath = join(ROOT, 'data', 'onoff-bonds.js');

// --- 파괴적 덮어쓰기 방지 (세대 파이프라인과 같은 규약) ---
function readExisting(path) {
  if (!existsSync(path)) return null;
  const sandbox = { window: {} };
  runInNewContext(readFileSync(path, 'utf8'), sandbox);
  const d = sandbox.window.ONOFF_BONDS;
  if (!d || !Array.isArray(d.bonds) || !d.bonds.length) return null;
  return d;
}
const oldestOf = d => d.bonds.reduce((m, b) => (m === null || b.first < m ? b.first : m), null);

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
  const shrinkCount = dataset.bonds.length < prev.bonds.length;
  const shrinkHist = nextOldest > prevOldest; // 최고 일자가 뒤로 밀림 = 과거 이력 잘림
  if (shrinkCount || shrinkHist) {
    const detail = [
      `   종목 수   기존 ${prev.bonds.length} → 신규 ${dataset.bonds.length}` + (shrinkCount ? '  ← 축소' : ''),
      `   최고 일자 기존 ${prevOldest} → 신규 ${nextOldest}` + (shrinkHist ? '  ← 이력 잘림' : ''),
    ];
    if (process.env.ONOFF_BONDS_ALLOW_SHRINK === '1') {
      console.warn('⚠ 산출물 축소 감지 — ONOFF_BONDS_ALLOW_SHRINK=1 이므로 우회하고 진행합니다.');
      detail.forEach(l => console.warn(l));
    } else {
      console.error('❌ 산출물 축소 감지 — 쓰기를 중단했습니다. 기존 data/onoff-bonds.js 는 그대로입니다.');
      detail.forEach(l => console.error(l));
      console.error('   원본 xlsx 의 조회 기간·종목 구성을 확인하세요.');
      console.error('   의도한 축소라면 ONOFF_BONDS_ALLOW_SHRINK=1 을 설정하고 다시 실행하세요.');
      process.exit(1);
    }
  }
}

// 백업 — 실패하면 쓰지 않는다.
if (existsSync(outPath)) {
  const t = new Date();
  const p = n => String(n).padStart(2, '0');
  const stamp = `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}-` +
                `${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`;
  const backupDir = join(ROOT, 'data', '_backup');
  const backupPath = join(backupDir, `onoff-bonds.${stamp}.js`);
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

// --- 콘솔 요약 ---
const sizeKB = (Buffer.byteLength(out) / 1024).toFixed(0);
const tenorStr = Object.entries(stats.tenorCount).sort().map(([k, v]) => `${k} ${v}`).join(' / ');
console.log('✅ 구조 검증 통과 —', xlsxName);
console.log(`   종목 수: ${stats.nBonds} (${tenorStr})`);
console.log(`   일자 범위: ${stats.first} ~ ${stats.last} | updated: ${stats.updated}`);
console.log(`   총 관측 수: ${stats.totalObs}`);
console.log(`   앵커 전환: ${dataset.anchorLog.length}회 | 최종 누적 오프셋: ${dataset.anchorLog.length ? dataset.anchorLog[dataset.anchorLog.length - 1].cumBp : 0}bp`);
console.log(`   → ${outPath} (${sizeKB} KB)`);
if (warnings.length) {
  console.log(`   경고 ${warnings.length}건:`);
  warnings.forEach(m => console.log('   ⚠ ' + m));
} else {
  console.log('   경고 없음');
}
