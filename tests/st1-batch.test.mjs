// st1-batch 일괄 붙여넣기 파서 테스트 — node --test.
// 입력은 실제 메신저 호가창에서 복사한 형태 그대로다(2026-10-07).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBatch, preprocessLine, gradeHints } from '../js/st1-batch.js';
import { buildSeries } from '../js/st1-curve.js';

const D = '2026-10-07';
const PASTE = `익발) 우리예담 (iM)
27.2.5(금) 3.84% (실효3.889%)
27.3.8(월) 3.88% (실효3.944%)
27.6.8(화) 4.08% (실효4.194%)

황인우(09:09:17) : 10/16 현대차증권 CP 50*2 3.07% 매도
황인우(09:09:47) : [익발] 하나은행 예담
27/1/11 - 3.79% 매출
27/1/22 - 3.81% 매출
27/3/10 - 3.88% 매출

발행확정 추가 중
황인우(09:13:12) : 10/16 현대차증권 CP 50*2 3.07% 매도 - 08 거래
황인우(09:14:07) : iM뱅크: 1년 FRN 3.63%(1개월CD+50bp)
황인우(09:21:10) : SC제일은행 1년 FRN (KOFR + 52bp)에 500억 체결, 추가중입니다`;

const brief = (c) => [c.row.issuer, c.row.kind, c.row.maturity_date, c.row.rate, c.status];

test('실제 호가창 붙여넣기 — 10개 후보, 잡담 1줄 스킵', () => {
  const { candidates, skipped } = parseBatch(PASTE, { date: D });
  assert.deepEqual(candidates.map(brief), [
    ['우리은행', '예담', '2027-02-05', 3.84, 'ok'],
    ['우리은행', '예담', '2027-03-08', 3.88, 'ok'],
    ['우리은행', '예담', '2027-06-08', 4.08, 'ok'],
    ['현대차증권', 'CP', '2026-10-16', 3.07, 'ok'],
    ['하나은행', '예담', '2027-01-11', 3.79, 'ok'],
    ['하나은행', '예담', '2027-01-22', 3.81, 'ok'],
    ['하나은행', '예담', '2027-03-10', 3.88, 'ok'],
    ['현대차증권', 'CP', '2026-10-16', 3.07, 'dup_batch'],
    ['iM뱅크', '채권', '2027-10-07', 3.63, 'ok'],
    ['SC제일은행', '채권', '2027-10-07', null, 'no_rate'],
  ]);
  assert.deepEqual(skipped, ['발행확정 추가 중']);
});

test('헤더 상속 — 발행사·화자·메모가 붙고 원문에 헤더가 남는다', () => {
  const { candidates } = parseBatch(PASTE, { date: D });
  const hana = candidates[4];
  assert.equal(hana.row.source, '황인우');
  assert.equal(hana.extras.note, '익발');
  assert.ok(hana.row.raw.startsWith('황인우(09:09:47) : [익발] 하나은행 예담 | 27/1/11'));
  assert.ok(hana.row.flags.includes('from_header'));
  assert.equal(candidates[0].extras.note, '익발 · iM · 실효 3.889%');
});

test('50*2 → 100억, 연도 없는 MM/DD 는 기준일 이후로', () => {
  const { candidates } = parseBatch('10/16 현대차증권 CP 50*2 3.07%', { date: D });
  assert.equal(candidates[0].row.amount, 100);
  const next = parseBatch('3/10 현대차증권 CP 3.07%', { date: D }).candidates[0];
  assert.equal(next.row.maturity_date, '2027-03-10');
});

test('FRN — rate_type·ref, 은행이면 은행채, 금리 없어도 스프레드 있으면 기본 체크', () => {
  const { candidates } = parseBatch(PASTE, { date: D });
  const im = candidates[8];
  const sc = candidates[9];
  assert.deepEqual(im.extras, { rate_type: 'frn', ref: '1개월CD+50bp' });
  assert.equal(im.row.sector, '은행채');
  assert.equal(sc.extras.ref, 'KOFR+52bp');
  assert.equal(sc.row.amount, 500);
  assert.equal(sc.include, true);
  assert.equal(candidates[7].include, false, '배치 내 중복은 기본 해제');
});

test('원장 중복·등급 힌트', () => {
  const first = parseBatch(PASTE, { date: D }).candidates[0].row;
  const ledger = [{ ...first, grade: 'A1' }, { issuer: '현대차증권', kind: 'CP', grade: 'A1' }];
  const { candidates } = parseBatch(PASTE, { date: D, existing: ledger });
  assert.equal(candidates[3].row.grade, 'A1');
  assert.ok(candidates[3].row.flags.includes('grade_from_ledger'));
  assert.equal(gradeHints(ledger).get('현대차증권|CP'), 'A1');
});

test('"27년 3월" 은 테너(27년)로 오독하지 않는다', () => {
  const c = parseBatch('아이엠증권 A1 CP 27년 3월 3.70%', { date: D }).candidates[0];
  assert.equal(c.row.maturity_ym, '2027-03');
});

test('6개월 테너 · 말일 넘침', () => {
  const c = parseBatch('신한은행 6개월 FRN 3.50%', { date: '2026-08-31' }).candidates[0];
  assert.equal(c.row.maturity_date, '2027-02-28');
});

test('preprocessLine — (주) 는 남기고 요일은 지운다', () => {
  const p = preprocessLine('(주)한화 CP 26.12.1(화) 3.2%', D);
  assert.ok(p.text.includes('(주)'));
  assert.ok(!p.text.includes('화)'));
});

test('커브 적합은 FRN 행을 뺀다', () => {
  const rows = [
    { date: D, kind: '채권', sector: '은행채', grade: 'AAA', maturity_ym: '2027-10', maturity_date: '2027-10-07', rate: 3.63, rate_type: 'frn' },
  ];
  assert.deepEqual(buildSeries(rows, { refDate: D }), {});
});

// ── 화면 경로 (st1-ui 순수 함수) ──────────────────────────────────────────
import { batchItemFromCandidate, rowFromBatchItem, commitBatch } from '../js/st1-ui.js';

test('commitBatch — 체크분만, 중복 건너뜀, 화면에서 고친 값이 저장된다', () => {
  const items = parseBatch(PASTE, { date: D }).candidates.map(batchItemFromCandidate);
  items[3].preview.grade = 'a1'; // 손으로 친 등급
  items[3].include = true;
  items[7].preview.grade = 'A1';
  items[7].include = true; // 배치 내 중복을 억지로 체크해도 원장엔 한 번만
  const out = commitBatch([], [], items, D);
  assert.equal(out.added, 9);
  assert.equal(out.skipped, 1);
  const hd = out.buffer.find((r) => r.issuer === '현대차증권');
  assert.equal(hd.grade, 'A1');
  assert.equal(hd.grade_scale, 'st');
  assert.equal(hd.source, '황인우');
  const im = out.buffer.find((r) => r.issuer === 'iM뱅크');
  assert.equal(im.rate_type, 'frn');
  assert.equal(im.ref, '1개월CD+50bp');
  assert.equal(im.sector, '은행채');
  const hdRow = rowFromBatchItem(items[3], D);
  assert.ok(!('rate_type' in hdRow), '부가필드는 있을 때만 붙는다');
  // 같은 붙여넣기를 다시 하면 전부 중복
  const again = commitBatch(out.buffer, [], items, D);
  assert.equal(again.added, 0);
});
