// st1-merge.mjs — ST-1 내보내기 파일 → data/st1/quotes.json 불변 append 병합.
//
// 흐름: 화면에서 "미내보내기 내보내기" → `st1-YYYY-MM-DD.json` 을 `_local/st1/` 에 두고 이 스크립트 실행.
//       (원문·발행사 정보가 들어 있어 `_local/` 은 .gitignore 대상이다. 파생 결과인
//        data/st1/quotes.json 만 커밋한다 — on/off·RV-2 와 같은 규약.)
//
// 사용:
//   node tools/st1-merge.mjs                 # _local/st1/st1-*.json 전부
//   node tools/st1-merge.mjs <파일…>          # 지정 파일만
//
// ── 규약 ────────────────────────────────────────────────────────────────
//   · 중복 제거는 `mergeRows`(js/st1-parser.js)를 **그대로 재사용**한다. 병합 규칙이
//     화면과 갈라지면 같은 파일을 두 번 넣었을 때 결과가 달라진다 — 로직 중복 금지.
//   · **데이터가 안 바뀌면 파일 바이트도 안 바뀐다.** meta.updated 는 wall-clock 이 아니라
//     rows 의 최대 date 이고, 행 순서도 append 순 그대로 둔다(정렬하지 않는다).
//     update-data.bat 의 staged-diff 변경감지가 이 성질에 의존한다.
//   · `_local/st1/` 이 없으면 에러가 아니라 **조용히 종료**한다(exit 0). 다른 모듈의
//     "입력 없으면 스킵" 관례(update-data.bat:112)와 같다.
//
// 종료 코드: 0 정상·스킵 / 1 입력 오류(형식 불일치 등)

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mergeRows } from '../js/st1-parser.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IN_DIR = join(ROOT, '_local', 'st1');
const OUT_PATH = join(ROOT, 'data', 'st1', 'quotes.json');

export const EXPORT_KIND = 'st1-export';
export const EXPORT_VERSION = 1;

// ── 순수 로직 (테스트 대상) ──────────────────────────────────────────────

/**
 * 내보내기 파일 본문 → rows.
 * kind·version 이 어긋나면 **던진다** — 조용히 빈 배열로 넘기면 "0건 병합"이 성공처럼 보인다.
 */
export function readPayload(text, name = '(입력)') {
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`${name}: JSON 파싱 실패`); }
  if (!json || json.kind !== EXPORT_KIND || json.version !== EXPORT_VERSION) {
    throw new Error(`${name}: 형식 불일치 — { kind:'${EXPORT_KIND}', version:${EXPORT_VERSION} } 이어야 한다`);
  }
  if (!Array.isArray(json.rows)) throw new Error(`${name}: rows 가 배열이 아니다`);
  return json.rows;
}

/**
 * rows → 저장 형태. meta 는 rows 에서만 유도한다(외부 상태·시각 없음).
 * updated = 최신 기록 일자(vintage). rows 가 비면 null.
 */
export function buildOutput(rows) {
  const dates = rows.map((r) => r && r.date).filter(Boolean).sort();
  return {
    meta: { updated: dates.length ? dates[dates.length - 1] : null, count: rows.length },
    rows,
  };
}

/**
 * 기존 산출물 + 내보내기 payload 들 → { json, report }.
 * @param {{rows:object[]}|null} existing
 * @param {{name:string, rows:object[]}[]} payloads
 */
export function mergePayloads(existing, payloads) {
  let rows = existing && Array.isArray(existing.rows) ? existing.rows : [];
  const report = [];
  for (const p of payloads || []) {
    const out = mergeRows(rows, p.rows);
    rows = out.rows;
    report.push({ name: p.name, read: p.rows.length, added: out.added, skipped: out.skipped });
  }
  return { json: buildOutput(rows), report };
}

/** gc-io.mjs writeJson 패턴 — 2스페이스 들여쓰기 + 개행 종료. */
export function serialize(json) {
  return `${JSON.stringify(json, null, 2)}\n`;
}

// ── 실행 ─────────────────────────────────────────────────────────────────

function loadExisting(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function main(argv) {
  let files = argv.slice(2);
  if (!files.length) {
    if (!existsSync(IN_DIR)) {
      console.log(`_local/st1/ 없음 — 병합할 내보내기 파일이 없습니다. 건너뜁니다.`);
      return 0;
    }
    files = readdirSync(IN_DIR)
      .filter((f) => /^st1-.*\.json$/i.test(f))
      .sort()
      .map((f) => join(IN_DIR, f));
  }
  if (!files.length) {
    console.log('_local/st1/ 에 st1-*.json 이 없습니다. 건너뜁니다.');
    return 0;
  }

  const payloads = [];
  for (const f of files) {
    const name = basename(f);
    try { payloads.push({ name, rows: readPayload(readFileSync(f, 'utf8'), name) }); }
    catch (e) { console.error(`[실패] ${e.message}`); return 1; }
  }

  const existing = loadExisting(OUT_PATH);
  const before = existing && Array.isArray(existing.rows) ? existing.rows.length : 0;
  const { json, report } = mergePayloads(existing, payloads);

  for (const r of report) console.log(`  ${r.name}: 읽음 ${r.read} / 신규 ${r.added} / 중복 ${r.skipped}`);

  const next = serialize(json);
  const prev = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : null;
  if (prev === next) {
    console.log(`변경 없음 — ${json.rows.length}행 (기준일 ${json.meta.updated ?? '없음'})`);
    return 0;
  }
  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, next, 'utf8');
  console.log(`data/st1/quotes.json: ${before} → ${json.rows.length}행 (기준일 ${json.meta.updated ?? '없음'})`);
  return 0;
}

// 직접 실행일 때만 돈다(테스트가 import 해도 부작용이 없게).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv));
}
