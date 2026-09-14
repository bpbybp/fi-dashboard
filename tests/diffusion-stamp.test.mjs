// meta.updated_on 스탬프 — 데이터 불변이면 파일 미기록(git diff 없음), 변경 시에만 갱신.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeDataFile, resolveStampedBody, latestPeriodInBody, todayKst } from '../scripts/lib/diffusion-pipeline.mjs';

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

// 같은 기준월에서 본문만 바뀌는 경우(윈도우 밀림·상세 재계산) 모사.
const writeWith = (dir, last, today, extra) => writeDataFile({
  dataDir: dir, fileName: 'd.js', banner: '// test\n', logTag: 'stamp-test', today,
  entries: [{ key: 'k', payload: { ...payload(last), meta: { ...payload(last).meta, window: extra } } }],
});

test('같은 기준월로 재실행 → 파일은 재기록돼도 updated_on 불변', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
  writeWith(dir, '2026-08', '2026-09-12', { start: '2021-09', end: '2026-08' });
  const r = writeWith(dir, '2026-08', '2026-10-01', { start: '2021-10', end: '2026-09' }); // 1일 윈도우 밀림
  assert.equal(r.changed, true);
  assert.equal(r.updatedOn, '2026-09-12');
  const body = readFileSync(r.path, 'utf8');
  assert.match(body, /"updated_on":"2026-09-12"/);
  assert.match(body, /"end":"2026-09"/);
});

test('기준월 후퇴(flash skip 등) → updated_on 불변', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stamp-'));
  write(dir, '2026-08', '2026-09-12');
  const r = write(dir, '2026-07', '2026-09-20');
  assert.equal(r.updatedOn, '2026-09-12');
});

test('trimmed형(data 배열) 본문도 최신 기준월 판독', () => {
  const body = 'window.FENRIR_SERIES = window.FENRIR_SERIES || {};\n' +
    'window.FENRIR_SERIES["a"] = {"meta":{},"data":[{"period":"2026-07","value":1}]};\n' +
    'window.FENRIR_SERIES["b"] = {"meta":{},"data":[{"period":"2026-08","value":1}]};\n';
  assert.equal(latestPeriodInBody(body), '2026-08');
  assert.equal(latestPeriodInBody(null), null);
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
