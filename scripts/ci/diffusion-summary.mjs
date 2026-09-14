// diffusion-summary.mjs — inflation-diffusion 워크플로 마지막 Summary 스텝.
//   국가별 한 줄 표(국가 | 결과 | 최신월)를 $GITHUB_STEP_SUMMARY(없으면 stdout)에 쓰고,
//   failed가 하나라도 있거나 커밋 스텝이 실패했으면 exit 1 → 워크플로 결론 실패.
//
// 입력(env): RESULT_<STEP>  = steps.<id>.outputs.result (new/unchanged/skipped/failed:사유)
//            OUTCOME_<STEP> = steps.<id>.outcome        (success/failure/skipped/cancelled)
//            OUTCOME_COMMIT = steps.commit.outcome
//   STEP ∈ US, KR, EU, AU, JP, TRIMMED
//
// 실행: node scripts/ci/diffusion-summary.mjs

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export const ROWS = [
  { label: 'US-CPI', step: 'US', file: 'data/inflation-diffusion-us.js', keys: ['inflation-diffusion-us-cpi'] },
  { label: 'US-PCE', step: 'US', file: 'data/inflation-diffusion-us.js', keys: ['inflation-diffusion-us-pce'] },
  { label: 'KR', step: 'KR', file: 'data/inflation-diffusion-kr.js', keys: ['inflation-diffusion-kr'] },
  { label: 'EU', step: 'EU', file: 'data/inflation-diffusion-eu.js', keys: ['inflation-diffusion-eu'] },
  { label: 'AU', step: 'AU', file: 'data/inflation-diffusion-au.js', keys: ['inflation-diffusion-au'] },
  { label: 'JP', step: 'JP', file: 'data/inflation-diffusion-jp.js', keys: ['inflation-diffusion-jp'] },
  { label: 'Trimmed', step: 'TRIMMED', file: 'data/trimmed-us.js',
    keys: ['trimmed-pce-dallas', 'median-cpi-cleveland', 'trimmed-cpi-cleveland'] },
];

// 자기등록 data/*.js → window.FENRIR_SERIES. 파일 부재 시 {}.
export function loadSeries(path) {
  if (!existsSync(path)) return {};
  const window = {};
  runInNewContext(readFileSync(path, 'utf8'), { window });
  return window.FENRIR_SERIES || {};
}

// payload의 마지막 기준월. 확산 payload=series, trimmed=data.
export function lastPeriodOf(payload) {
  const arr = payload?.series ?? payload?.data;
  return arr && arr.length ? arr[arr.length - 1].period : null;
}

export function resolveResult(result, outcome) {
  if (result) return result;
  if (outcome === 'failure') return 'failed:사유 미기록';
  if (outcome === 'cancelled') return 'failed:cancelled';
  if (outcome === 'skipped') return 'skipped';
  return 'unknown';
}

const cell = (s) => String(s).replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160);

// env + 최신월 조회기 → { markdown, failed }
export function buildSummary(env, latestOf) {
  const lines = ['### 물가 확산지수 적재 결과', '', '| 국가 | 결과 | 최신월 |', '| --- | --- | --- |'];
  let failed = false;
  for (const row of ROWS) {
    const r = resolveResult(env[`RESULT_${row.step}`], env[`OUTCOME_${row.step}`]);
    if (r.startsWith('failed')) failed = true;
    lines.push(`| ${row.label} | ${cell(r)} | ${latestOf(row) ?? '—'} |`);
  }
  const commit = env.OUTCOME_COMMIT;
  if (commit && commit !== 'success') {
    failed = true;
    lines.push('', `커밋 스텝: ${commit}`);
  }
  return { markdown: lines.join('\n') + '\n', failed };
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const cache = new Map();
  const latestOf = (row) => {
    if (!cache.has(row.file)) cache.set(row.file, loadSeries(join(root, row.file)));
    const reg = cache.get(row.file);
    const periods = row.keys.map((k) => lastPeriodOf(reg[k])).filter(Boolean).sort();
    return periods.length ? periods[periods.length - 1] : null;
  };
  const { markdown, failed } = buildSummary(process.env, latestOf);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(markdown);
  if (failed) {
    console.error('[diffusion-summary] 실패 항목 있음 → exit 1');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
