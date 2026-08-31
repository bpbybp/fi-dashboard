// 소스 위생 검사 — node --test (인자 없이 자동탐색).
//
// 왜 있나: 2026-08-05 에 `js/rv2-ui.js` 로 NUL(0x00) 3개가 들어가 원격까지 올라갔다.
// 키 구분자 자리의 공백이 0x00 으로 바뀐 것이라 **동작에는 문제가 없었고**(NUL 도 유효한
// 구분자다) 단위 테스트·렌더 스모크·통합 검증이 전부 통과했다. 발견 계기는 `git diff` 가
// 파일을 바이너리로 판정한 것이었다.
//
// 즉 **테스트가 전부 초록이어도 소스가 성한 건 아니다.** 이 파일이 그 구멍을 막는다.
// 검출 시 파일 경로와 **바이트 오프셋**을 함께 낸다 — 눈으로 안 보이는 문자라 위치가 없으면
// 찾을 수 없다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 검사 대상에서 뺄 디렉터리. 추적하지 않는 백업·의존성은 우리 소스가 아니다. */
const SKIP_DIRS = new Set(['node_modules', '.git', '_backup_untracked', 'vendor', 'tests/local']);

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(ROOT, p).split(sep).join('/');
    if (SKIP_DIRS.has(name) || SKIP_DIRS.has(rel)) continue;
    const st = statSync(p);
    if (st.isDirectory()) collect(p, out);
    else if (/\.(mjs|html)$/.test(name) || (/\.js$/.test(name) && rel.startsWith('js/'))) out.push(rel);
  }
  return out;
}

const FILES = collect(ROOT).sort();

/**
 * 허용 제어문자: TAB(0x09) · LF(0x0a) · CR(0x0d).
 * 그 외 C0 영역(0x00–0x1f)과 DEL(0x7f)은 소스에 있을 이유가 없다.
 */
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function scanControlBytes(relPath) {
  const buf = readFileSync(join(ROOT, relPath));
  const hits = [];
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if ((b < 0x20 && !ALLOWED.has(b)) || b === 0x7f) {
      hits.push({ offset: i, byte: b, context: buf.slice(Math.max(0, i - 30), i + 30).toString('utf8').replace(/[\r\n]/g, '⏎') });
    }
  }
  return hits;
}

test('검사 대상이 실제로 잡힌다 (경로 규칙이 조용히 비지 않게)', () => {
  assert.ok(FILES.length >= 20, `대상 ${FILES.length}개 — 너무 적다. collect() 규칙 확인`);
  for (const must of ['js/rv2-ui.js', 'js/rv2-parser.js', 'js/rv2-buckets.js', 'rv2-quote-rank.html', 'js/st1-parser.js', 'js/st1-ui.js', 'st1-quote-log.html', 'tools/st1-merge.mjs']) {
    assert.ok(FILES.includes(must), `대상 누락: ${must}`);
  }
});

test('소스에 제어문자가 없다 (TAB·LF·CR 제외)', () => {
  const bad = [];
  for (const f of FILES) {
    for (const h of scanControlBytes(f)) {
      bad.push(`${f} @${h.offset} : 0x${h.byte.toString(16).padStart(2, '0')}  …${h.context}…`);
    }
  }
  assert.deepEqual(bad, [], `제어문자 발견 ${bad.length}건:\n  ${bad.join('\n  ')}`);
});

test('소스가 유효한 UTF-8 이다 (한글 주석이 깨지면 여기서 걸린다)', () => {
  const bad = [];
  for (const f of FILES) {
    const buf = readFileSync(join(ROOT, f));
    const text = buf.toString('utf8');
    // 왕복이 어긋나면 원본이 유효한 UTF-8 이 아니다(치환문자 U+FFFD 가 끼어든다).
    if (!Buffer.from(text, 'utf8').equals(buf)) {
      const idx = text.indexOf('�');
      bad.push(`${f}${idx >= 0 ? ` (첫 깨짐 문자 위치 ${idx})` : ''}`);
    }
  }
  assert.deepEqual(bad, [], `UTF-8 이 아닌 파일:\n  ${bad.join('\n  ')}`);
});
