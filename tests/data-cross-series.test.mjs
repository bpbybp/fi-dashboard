// data/kr-cpi-*.js 교차 시리즈 무결성 — node --test (인자 없이 자동탐색).
//
// 서로 다른 시리즈 파일이 겹치는 기간 값이 전부 같으면 한쪽이 다른 시리즈 행으로 만들어진 것이다.
// 66652f9(2026-08-03) 생활물가지수가 총지수 값 375개월로 채워진 오염을 커밋 시점에 잡았을 검사.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const DATA = new URL('../data/', import.meta.url);
const FILES = readdirSync(DATA).filter((f) => /^kr-cpi-.+\.js$/.test(f)).sort();

function load(file) {
  const ctx = { window: {} };
  vm.runInNewContext(readFileSync(new URL(file, DATA), 'utf8'), ctx);
  const [id, entry] = Object.entries(ctx.window.FENRIR_SERIES)[0];
  return { id, map: new Map(entry.series.map((p) => [p.period, p.value])) };
}
const SERIES = FILES.map(load);

test('전제 — KR CPI data 파일이 2개 이상', () => {
  assert.ok(SERIES.length >= 2, FILES.join(', '));
});

for (let i = 0; i < SERIES.length; i++) {
  for (let j = i + 1; j < SERIES.length; j++) {
    const a = SERIES[i];
    const b = SERIES[j];
    test(`${a.id} ↔ ${b.id} — 겹치는 기간 값이 전부 같으면 실패(다른 시리즈 행 혼입)`, () => {
      const overlap = [...a.map.keys()].filter((k) => b.map.has(k));
      const same = overlap.filter((k) => a.map.get(k) === b.map.get(k));
      assert.ok(overlap.length === 0 || same.length < overlap.length,
        `겹치는 ${overlap.length}개월 전부 동일 (${overlap[0]}~${overlap.at(-1)})`);
    });
  }
}
