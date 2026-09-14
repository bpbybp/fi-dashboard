// meta.updated_on 스탬프 — 데이터 불변이면 파일 미기록(git diff 없음), 변경 시에만 갱신.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDataFile, resolveStampedBody, todayKst } from '../scripts/lib/diffusion-pipeline.mjs';

const payload = (last) => ({ meta: { series_id: 'x', last_updated: last }, series: [{ period: last }], detail: [] });
const write = (dir, last, today) => writeDataFile({
  dataDir: dir, fileName: 'd.js', banner: '// test\n', logTag: 'stamp-test', today,
  entries: [{ key: 'k', payload: payload(last) }],
});

test('최초 기록 → updated_on=오늘, 동일 데이터 재실행 → 파일 바이트 불변', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
  const a = write(dir, '2026-07', '2026-08-12');
  assert.equal(a.changed, true);
  const body1 = readFileSync(a.path, 'utf8');
  assert.match(body1, /"updated_on":"2026-08-12"/);
  const mtime1 = statSync(a.path).mtimeMs;

  const b = write(dir, '2026-07', '2026-09-15');   // 날짜만 다름, 데이터 동일
  assert.equal(b.changed, false);
  assert.equal(b.updatedOn, '2026-08-12');
  assert.equal(readFileSync(a.path, 'utf8'), body1);
  assert.equal(statSync(a.path).mtimeMs, mtime1);
});

test('데이터 변경 시에만 updated_on 갱신', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
  write(dir, '2026-07', '2026-08-12');
  const c = write(dir, '2026-08', '2026-09-15');
  assert.equal(c.changed, true);
  assert.match(readFileSync(c.path, 'utf8'), /"updated_on":"2026-09-15"/);
});

test('updated_on 도입 전 파일(필드 없음) → 1회 오늘로 기록', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
  const p = join(dir, 'd.js');
  writeFileSync(p, '// legacy\n', 'utf8');
  const r = write(dir, '2026-07', '2026-09-16');
  assert.equal(r.changed, true);
  assert.match(readFileSync(p, 'utf8'), /"updated_on":"2026-09-16"/);
});

test('resolveStampedBody: 이전 본문 없음 → changed', () => {
  const r = resolveStampedBody(null, (on) => `x${on}`, '2026-01-01');
  assert.deepEqual(r, { body: 'x2026-01-01', changed: true, updatedOn: '2026-01-01' });
});

test('todayKst: 21:00 UTC 워크플로 실행은 KST 익일 날짜', () => {
  assert.equal(todayKst(new Date(Date.UTC(2026, 8, 15, 21, 0))), '2026-09-16');
});
