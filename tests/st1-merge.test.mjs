// st1-merge 단위 테스트 — node --test (인자 없이 자동탐색).
//
// 초점: **멱등성과 바이트 안정성**. 같은 내보내기 파일을 두 번 넣어도 행이 늘면 안 되고,
// 데이터가 안 바뀌면 직렬화 결과 바이트도 같아야 한다(update-data.bat 의 staged-diff
// 변경감지가 이 성질에 의존한다).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readPayload, buildOutput, mergePayloads, serialize, EXPORT_KIND, EXPORT_VERSION } from '../tools/st1-merge.mjs';
import { parseQuoteLine } from '../js/st1-parser.js';

const row = (line, date) => parseQuoteLine(line, { date });
const A = row('아이엠증권 A1 CP 27년 3월 만기 3.70%', '2026-08-31');
const B = row('OO은행 예담 26년 12월 3.45%', '2026-08-31');
const C = row('OO증권 A1 전단채 27/6 3.55%', '2026-09-01');
const payload = (name, rows) => ({ name, rows });
const EMPTY = { meta: { updated: null, count: 0 }, rows: [] };

// ── payload 읽기 ─────────────────────────────────────────────────────────

test('내보내기 payload 읽기 — 정상', () => {
  const text = JSON.stringify({ kind: EXPORT_KIND, version: EXPORT_VERSION, rows: [A, B] });
  assert.deepEqual(readPayload(text, 'x.json'), [A, B]);
});

test('형식이 어긋나면 던진다 — 조용한 0건 병합이 성공처럼 보이면 안 된다', () => {
  const bad = [
    JSON.stringify({ kind: 'st1-buffer', version: 1, rows: [] }),   // 남의 kind
    JSON.stringify({ kind: EXPORT_KIND, version: 2, rows: [] }),    // 다른 version
    JSON.stringify({ kind: EXPORT_KIND, version: 1, rows: 'no' }),  // rows 가 배열 아님
    '{ 깨진 json',
  ];
  for (const t of bad) assert.throws(() => readPayload(t, 'bad.json'), /bad\.json/);
});

// ── 첫 병합 ──────────────────────────────────────────────────────────────

test('빈 quotes.json 에 첫 병합', () => {
  const { json, report } = mergePayloads(EMPTY, [payload('st1-2026-08-31.json', [A, B])]);
  assert.equal(json.rows.length, 2);
  assert.equal(json.meta.count, 2);
  assert.equal(json.meta.updated, '2026-08-31');
  assert.deepEqual(report, [{ name: 'st1-2026-08-31.json', read: 2, added: 2, skipped: 0 }]);
});

test('existing 이 null 이어도(파일 없음) 첫 병합이 된다', () => {
  const { json } = mergePayloads(null, [payload('a.json', [A])]);
  assert.equal(json.rows.length, 1);
});

// ── 멱등 ─────────────────────────────────────────────────────────────────

test('같은 파일 2회 병합 — 멱등', () => {
  const p = payload('st1-2026-08-31.json', [A, B]);
  const first = mergePayloads(EMPTY, [p]);
  const second = mergePayloads(first.json, [p]);

  assert.equal(second.json.rows.length, 2, '재병합이 행을 늘렸다');
  assert.deepEqual(second.report, [{ name: 'st1-2026-08-31.json', read: 2, added: 0, skipped: 2 }]);
  assert.equal(serialize(second.json), serialize(first.json), '데이터 불변인데 바이트가 달라졌다');
});

test('한 번에 같은 payload 를 두 번 넘겨도 멱등', () => {
  const p = payload('a.json', [A, B]);
  const { json, report } = mergePayloads(EMPTY, [p, { ...p, name: 'b.json' }]);
  assert.equal(json.rows.length, 2);
  assert.equal(report[1].added, 0);
  assert.equal(report[1].skipped, 2);
});

test('겹치는 파일 — 새 행만 들어간다', () => {
  const first = mergePayloads(EMPTY, [payload('a.json', [A, B])]);
  const second = mergePayloads(first.json, [payload('b.json', [B, C])]);
  assert.equal(second.json.rows.length, 3);
  assert.deepEqual(second.report, [{ name: 'b.json', read: 2, added: 1, skipped: 1 }]);
});

// ── meta ─────────────────────────────────────────────────────────────────

test('meta.updated 는 rows 의 최대 date (wall-clock 아님)', () => {
  // 나중 일자를 먼저 넣어도 최대값이어야 한다 — 순서가 아니라 최대다.
  const { json } = mergePayloads(EMPTY, [payload('a.json', [C, A])]);
  assert.equal(json.meta.updated, '2026-09-01');
  assert.equal(json.meta.count, 2);
});

test('meta.updated — rows 가 비면 null', () => {
  assert.deepEqual(buildOutput([]).meta, { updated: null, count: 0 });
});

test('행 순서는 append 순 그대로 — 정렬하지 않는다(바이트 안정성)', () => {
  const { json } = mergePayloads(EMPTY, [payload('a.json', [C, A, B])]);
  assert.deepEqual(json.rows.map((r) => r.date), ['2026-09-01', '2026-08-31', '2026-08-31']);
});

// ── 직렬화 ───────────────────────────────────────────────────────────────

test('직렬화 — 2스페이스 + 개행 종료 (gc-io.mjs writeJson 패턴)', () => {
  const s = serialize(EMPTY);
  assert.ok(s.endsWith('\n'));
  assert.ok(s.includes('\n  "meta"'), `2스페이스 들여쓰기여야 한다:\n${s}`);
  assert.deepEqual(JSON.parse(s), EMPTY);
});

test('빈 산출물의 직렬화가 커밋된 초기 파일과 같다', () => {
  assert.equal(serialize(buildOutput([])), '{\n  "meta": {\n    "updated": null,\n    "count": 0\n  },\n  "rows": []\n}\n');
});
