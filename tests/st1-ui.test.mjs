// st1-ui 순수 로직 테스트 — node --test (인자 없이 자동탐색).
//
// 초점: **화면값이 파싱값을 이긴다**는 규약. Phase 2 에서 파서의 역할이 "완벽한 추출기"에서
// "실시간 입력 보조"로 바뀐 만큼, 기록되는 값이 파싱 결과가 아니라 프리뷰 값인지가
// 설계 전체가 걸린 지점이다.
// DOM 을 건드리는 렌더·이벤트 함수는 여기서 다루지 않는다(모듈 최상위에 DOM 접근이 없어
// import 가 가능하다 — rv2-ui.test.mjs 와 같은 규약).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  previewFromParsed, mergePreview, parseMaturityField, rowFromPreview,
  appendRow, removeByKey, monthsRemaining, uniqueIssuers, issuerSuggestions,
  applyFilters, PREVIEW_FIELDS, FILTER_NONE,
  readEnvelope, bufferEnvelope, exportPayload, exportFilename, readCommitted,
  LS_BUFFER, EXPORT_KIND, ENVELOPE_VERSION,
} from '../js/st1-ui.js';
import { parseQuoteLine, dedupeKey, mergeRows } from '../js/st1-parser.js';

const D = '2026-08-31';
const LINE = '아이엠증권 A1 CP 27년 3월 만기 3.70%';
const previewOf = (line) => previewFromParsed(parseQuoteLine(line, { date: D }));

// ── 프리뷰 ───────────────────────────────────────────────────────────────

test('파싱 결과 → 프리뷰 6필드(전부 문자열)', () => {
  const p = previewOf(LINE);
  assert.deepEqual(p, {
    issuer: '아이엠증권', kind: 'CP', grade: 'A1', maturity: '2027-03', rate: '3.7', amount: '',
  });
  assert.deepEqual(Object.keys(p).sort(), [...PREVIEW_FIELDS].sort());
});

test('프리뷰 만기는 정확일자가 있으면 그쪽을 보여준다', () => {
  assert.equal(previewOf('아이엠증권 A1 CP 26.11.20 3.70%').maturity, '2026-11-20');
});

test('사용자가 고친 필드는 재파싱이 덮지 않는다 (dirty 보호)', () => {
  const current = { ...previewOf(LINE), issuer: '아이엠증권(수정)' };
  const next = previewOf('A1 CP 27년 3월 3.72%'); // 원문에서 발행사가 빠진 상태로 재파싱
  const merged = mergePreview(next, current, { issuer: true });
  assert.equal(merged.issuer, '아이엠증권(수정)', '손댄 필드가 되돌아갔다');
  assert.equal(merged.rate, '3.72', '손대지 않은 필드는 재파싱을 따른다');
});

test('dirty 가 없으면 전부 재파싱값', () => {
  const merged = mergePreview(previewOf('OO은행 예담 26년 12월 3.45%'), previewOf(LINE), {});
  assert.equal(merged.issuer, 'OO은행');
  assert.equal(merged.kind, '예담');
  assert.equal(merged.grade, '', '재파싱에서 비면 비운다');
});

// ── 만기 입력 필드 ───────────────────────────────────────────────────────

test('만기 필드 — 파서 문법을 그대로 재사용한다', () => {
  assert.deepEqual(parseMaturityField('2026-11-20'), { maturity_ym: '2026-11', maturity_date: '2026-11-20' });
  assert.deepEqual(parseMaturityField('2026-11'), { maturity_ym: '2026-11', maturity_date: null });
  assert.deepEqual(parseMaturityField('27/3'), { maturity_ym: '2027-03', maturity_date: null });
  assert.deepEqual(parseMaturityField('27년 3월'), { maturity_ym: '2027-03', maturity_date: null });
  assert.deepEqual(parseMaturityField(''), { maturity_ym: null, maturity_date: null });
});

// ── 행 생성: 화면값 우선 ─────────────────────────────────────────────────

test('행은 프리뷰 값으로 만든다 — 파싱값이 아니라 화면값', () => {
  const parsed = parseQuoteLine(LINE, { date: D });
  const edited = { ...previewFromParsed(parsed), issuer: 'OO은행', rate: '3.95' };
  const row = rowFromPreview(edited, { date: D, raw: LINE });

  assert.equal(row.issuer, 'OO은행', '파싱값(아이엠증권)이 아니라 화면값이어야 한다');
  assert.equal(row.rate, 3.95);
  assert.equal(row.kind, 'CP');
  assert.equal(row.maturity_ym, '2027-03');
  assert.equal(row.date, D);
  assert.equal(row.raw, LINE, 'raw 는 입력 원문 그대로');
  assert.deepEqual(row.flags, []);
});

test('행 스키마 — Phase 1 파서 출력과 같은 키 집합', () => {
  const row = rowFromPreview(previewOf(LINE), { date: D, raw: LINE });
  assert.deepEqual(Object.keys(row).sort(), Object.keys(parseQuoteLine(LINE, { date: D })).sort());
  assert.equal(row.source, null);
});

test('빈 프리뷰 필드는 null + flags 로 남는다', () => {
  const row = rowFromPreview({ issuer: '', kind: '', grade: '', maturity: '', rate: '', amount: '' },
    { date: D, raw: '알 수 없음' });
  assert.equal(row.issuer, null);
  assert.equal(row.rate, null);
  assert.equal(row.maturity_ym, null);
  assert.deepEqual(row.flags, ['no_rate', 'no_maturity', 'no_issuer']);
  assert.equal(row.raw, '알 수 없음');
});

test('숫자 필드는 단위를 붙여 쳐도 읽는다', () => {
  const row = rowFromPreview({ ...previewOf(LINE), rate: '3.70%', amount: '100억' }, { date: D, raw: LINE });
  assert.equal(row.rate, 3.70);
  assert.equal(row.amount, 100);
});

test('등급 표기는 대문자로 고정 — 안 하면 a1/A1 이 원장을 가른다', () => {
  assert.equal(rowFromPreview({ ...previewOf(LINE), grade: 'a2+' }, { date: D, raw: LINE }).grade, 'A2+');
});

test('발행사는 issuer_raw(입력 그대로) + issuer(정규화) 로 갈린다', () => {
  const row = rowFromPreview({ ...previewOf(LINE), issuer: '(주)국민은행' }, { date: D, raw: LINE });
  assert.equal(row.issuer_raw, '(주)국민은행');
  assert.equal(row.issuer, '국민은행');
});

// ── 원장 추가·삭제 ───────────────────────────────────────────────────────

const mk = (over = {}) => rowFromPreview({ ...previewOf(LINE), ...over }, { date: D, raw: LINE });

test('중복 기록은 거부한다', () => {
  const a = appendRow([], mk());
  assert.equal(a.added, true);
  assert.equal(a.rows.length, 1);

  const b = appendRow(a.rows, mk());
  assert.equal(b.added, false, 'dedupeKey 가 같은데 들어갔다');
  assert.equal(b.rows.length, 1);
});

test('금리가 다르면 새 기록이다', () => {
  const a = appendRow([], mk());
  const b = appendRow(a.rows, mk({ rate: '3.72' }));
  assert.equal(b.added, true);
  assert.equal(b.rows.length, 2);
});

test('appendRow 는 원본 배열을 변형하지 않는다', () => {
  const base = [mk()];
  appendRow(base, mk({ rate: '3.80' }));
  assert.equal(base.length, 1);
});

test('dedupeKey 로 삭제', () => {
  const rows = appendRow(appendRow([], mk()).rows, mk({ rate: '3.72' })).rows;
  assert.equal(rows.length, 2);
  const left = removeByKey(rows, dedupeKey(rows[0]));
  assert.equal(left.length, 1);
  assert.equal(left[0].rate, 3.72);
});

// ── 잔존개월 (렌더 시 계산 · 저장 안 함) ─────────────────────────────────

test('잔존개월 — 연-월 기준', () => {
  assert.equal(monthsRemaining('2026-08-31', '2027-03'), 7);
  assert.equal(monthsRemaining('2026-08-31', '2026-08'), 0);
  assert.equal(monthsRemaining('2026-08-31', '2026-06'), -2, '과거 만기는 음수');
  assert.equal(monthsRemaining('2026-12-01', '2027-01'), 1, '연 경계');
});

test('잔존개월 — 정확일자를 알면 일 비교로 한 달 깎는다', () => {
  // 기준 8/31, 만기 9/1 을 "1개월"로 읽으면 곤란하다.
  assert.equal(monthsRemaining('2026-08-31', '2026-09', '2026-09-01'), 0);
  assert.equal(monthsRemaining('2026-08-01', '2026-09', '2026-09-30'), 1);
});

test('잔존개월 — 입력이 없으면 null', () => {
  assert.equal(monthsRemaining('2026-08-31', null), null);
  assert.equal(monthsRemaining(null, '2027-03'), null);
  assert.equal(monthsRemaining('bad', '2027-03'), null);
});

// ── 발행사 자동완성 ──────────────────────────────────────────────────────

const ledger = () => [
  mk({ issuer: '아이엠증권' }),
  mk({ issuer: '아이엠증권', rate: '3.72' }),
  mk({ issuer: '아이엠캐피탈', rate: '3.80' }),
  mk({ issuer: '국민은행', kind: '예담', grade: '', rate: '3.45' }),
];

test('고유 발행사 — 중복 제거 + 가나다순', () => {
  assert.deepEqual(uniqueIssuers(ledger()), ['국민은행', '아이엠증권', '아이엠캐피탈']);
  assert.deepEqual(uniqueIssuers([]), []);
});

test('자동완성 — 접두사 매칭', () => {
  const rows = ledger();
  assert.deepEqual(issuerSuggestions(rows, '아이엠'), ['아이엠증권', '아이엠캐피탈']);
  assert.deepEqual(issuerSuggestions(rows, '아이엠캐'), ['아이엠캐피탈']);
  assert.deepEqual(issuerSuggestions(rows, '은행'), [], '접두사 매칭이지 부분일치가 아니다');
  assert.equal(issuerSuggestions(rows, '').length, 3, '접두사가 없으면 전체');
  assert.deepEqual(issuerSuggestions(rows, '아이엠', 1), ['아이엠증권'], 'limit');
});

// ── 필터 ─────────────────────────────────────────────────────────────────

test('필터 — 발행사는 부분일치(타이핑 중에도 걸린다)', () => {
  assert.equal(applyFilters(ledger(), { issuer: '아이엠' }).length, 3);
  assert.equal(applyFilters(ledger(), { issuer: '캐피탈' }).length, 1);
  assert.equal(applyFilters(ledger(), { issuer: '없는회사' }).length, 0);
});

test('필터 — 종류·등급은 완전일치, 빈 값은 전체', () => {
  const rows = ledger();
  assert.equal(applyFilters(rows, {}).length, 4);
  assert.equal(applyFilters(rows, { kind: 'CP' }).length, 3);
  assert.equal(applyFilters(rows, { kind: '예담' }).length, 1);
  assert.equal(applyFilters(rows, { grade: 'A1' }).length, 3);
});

test('필터 — FILTER_NONE 은 값이 빈 행만', () => {
  assert.equal(applyFilters(ledger(), { grade: FILTER_NONE }).length, 1, '등급 없는 예담 1건');
});

test('필터 — 세 조건은 AND', () => {
  assert.equal(applyFilters(ledger(), { issuer: '아이엠', kind: 'CP', grade: 'A1' }).length, 3);
  assert.equal(applyFilters(ledger(), { issuer: '아이엠', kind: '예담' }).length, 0);
});

// ── 저장 계층 (Phase 3) ──────────────────────────────────────────────────

test('봉투 파싱 — kind·version 이 다르면 무시하고 빈 배열', () => {
  const good = JSON.stringify(bufferEnvelope([mk()]));
  assert.equal(readEnvelope(good).length, 1);

  const bad = [
    JSON.stringify({ kind: 'rv2-session', version: 1, rows: [mk()] }), // 남의 키
    JSON.stringify({ kind: LS_BUFFER, version: 2, rows: [mk()] }),     // 구·신 버전 불일치
    JSON.stringify({ kind: LS_BUFFER, version: 1, rows: 'nope' }),     // rows 가 배열 아님
    JSON.stringify([mk()]),                                            // 봉투 없음
    '{ 깨진 json',
    null,
    '',
  ];
  for (const t of bad) assert.deepEqual(readEnvelope(t), [], String(t).slice(0, 40));
});

test('버퍼 봉투 형식', () => {
  const env = bufferEnvelope([mk()]);
  assert.equal(env.kind, LS_BUFFER);
  assert.equal(env.version, ENVELOPE_VERSION);
  assert.equal(env.rows.length, 1);
  assert.deepEqual(bufferEnvelope(null).rows, []);
});

test('quotes.json 읽기 — 형식이 어긋나면 빈 배열(404 와 같은 취급)', () => {
  assert.equal(readCommitted({ meta: {}, rows: [mk()] }).length, 1);
  assert.deepEqual(readCommitted({ meta: {}, rows: null }), []);
  assert.deepEqual(readCommitted(null), []);
});

test('중복 판정은 확정분 + 버퍼 합집합 기준', () => {
  const committed = [mk()];
  const buffer = [mk({ rate: '3.72' })];
  const all = mergeRows(committed, buffer).rows;
  assert.equal(all.length, 2);

  // 확정분에 이미 있는 호가 → 버퍼가 비어 있어도 거부돼야 한다.
  assert.equal(appendRow(all, mk()).added, false, '확정분 중복이 통과했다');
  // 버퍼에 있는 호가도 마찬가지.
  assert.equal(appendRow(all, mk({ rate: '3.72' })).added, false, '버퍼 중복이 통과했다');
  // 둘 다에 없으면 통과.
  assert.equal(appendRow(all, mk({ rate: '3.80' })).added, true);
});

test('내보내기 payload 형식 — 버퍼 행만', () => {
  const buffer = [mk(), mk({ rate: '3.72' })];
  const p = exportPayload(buffer);
  assert.equal(p.kind, EXPORT_KIND);
  assert.equal(p.version, ENVELOPE_VERSION);
  assert.equal(p.rows.length, 2);
  assert.deepEqual(p.rows, buffer, '확정분이 섞이면 안 된다');
  assert.deepEqual(exportPayload(null).rows, []);
});

test('내보내기 파일명 — st1-YYYY-MM-DD.json', () => {
  assert.equal(exportFilename('2026-08-31'), 'st1-2026-08-31.json');
  assert.match(exportFilename(), /^st1-\d{4}-\d{2}-\d{2}\.json$/);
});

test('버퍼를 비워도 확정분은 남는다', () => {
  const committed = [mk()];
  let buffer = [mk({ rate: '3.72' }), mk({ rate: '3.80' })];
  assert.equal(mergeRows(committed, buffer).rows.length, 3);

  buffer = []; // 내보내기 후
  const after = mergeRows(committed, buffer).rows;
  assert.equal(after.length, 1);
  assert.equal(after[0].rate, 3.70, '남은 것은 확정분이어야 한다');
});

test('버퍼 행 삭제는 확정분에 영향이 없다', () => {
  const committed = [mk()];
  const buffer = [mk({ rate: '3.72' })];
  const left = removeByKey(buffer, dedupeKey(buffer[0]));
  assert.equal(left.length, 0);
  assert.equal(mergeRows(committed, left).rows.length, 1);
});
