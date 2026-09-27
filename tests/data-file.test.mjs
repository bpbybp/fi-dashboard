// data-file 직렬화 테스트 — node --test (인자 없이 자동탐색).
//
// 초점: admin export 와 일회성 스크립트가 공유하는 직렬화가 커밋된 data 파일과 바이트 동일한가.
// (헤더 주석은 인자로 원문을 넘긴다. 줄바꿈은 LF 로 비교 — 작업 사본은 autocrlf 로 CRLF 일 수 있음.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { buildDataFileContent, pyJson } from '../js/data-file.js';

test('pyJson — {"k": v} 형식, ", " 구분, 한글 원문 유지', () => {
  assert.equal(pyJson({ period: '2026-08', value: 120.05 }), '{"period": "2026-08", "value": 120.05}');
  assert.equal(pyJson({ a: '생활물가' }), '{"a": "생활물가"}');
});

for (const id of ['kr-cpi-headline', 'kr-cpi-core']) {
  test(`왕복 — ${id}: 파싱 → 재직렬화가 커밋된 파일과 바이트 동일`, () => {
    const text = readFileSync(new URL(`../data/${id}.js`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    const ctx = { window: {} };
    vm.runInNewContext(text, ctx);
    const { meta, series } = ctx.window.FENRIR_SERIES[id];
    const header = text.split('\n').slice(0, 2).map((l) => l.replace(/^\/\/ /, ''));
    assert.equal(buildDataFileContent(id, series, meta, header), text);
  });
}
