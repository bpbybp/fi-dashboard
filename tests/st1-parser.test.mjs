// st1-parser 단위 테스트 — node --test (인자 없이 자동탐색).
//
// 초점: **토큰 추출 순서**가 만드는 오탐 차단과 **어순 비의존성**. 두 가지가 ST-1 파서의
// 설계 전체가 걸린 지점이라 렌더·저장과 무관하게 여기서 못 박는다.
// 파생값(잔존개월 등)은 저장 대상이 아니므로 검증하지 않는다 — 렌더 시 계산이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseQuoteLine, normalizeIssuer, dedupeKey, mergeRows, todayLocal,
} from '../js/st1-parser.js';

const D = '2026-08-31';
const P = (line) => parseQuoteLine(line, { date: D });

// ── 기준 예시 ────────────────────────────────────────────────────────────

test('기준 예시 — 전 필드', () => {
  const line = '아이엠증권 A1 CP 27년 3월 만기 3.70%';
  const r = P(line);
  assert.equal(r.date, D);
  assert.equal(r.issuer, '아이엠증권');
  assert.equal(r.issuer_raw, '아이엠증권');
  assert.equal(r.kind, 'CP');
  assert.equal(r.grade, 'A1');
  assert.equal(r.maturity_ym, '2027-03');
  assert.equal(r.maturity_date, null);
  assert.equal(r.rate, 3.70);
  assert.equal(r.amount, null);
  assert.equal(r.source, null);
  assert.equal(r.raw, line, 'raw 는 원문 그대로');
  assert.deepEqual(r.flags, []);
});

test('opts.source 는 그대로 실린다 (Phase 1 에선 null 이 정상)', () => {
  assert.equal(P('아이엠증권 A1 CP 27/3 3.70%').source, null);
  assert.equal(parseQuoteLine('아이엠증권 A1 CP 27/3 3.70%', { date: D, source: 'chat' }).source, 'chat');
});

test('date 미지정 시 로컬 오늘 — UTC 로 자르지 않는다', () => {
  // 한국시간 2026-08-31 08:00 = UTC 2026-08-30 23:00. 로컬 기준이면 08-31 이어야 한다.
  assert.equal(todayLocal(new Date(2026, 7, 31, 8, 0, 0)), '2026-08-31');
  assert.equal(todayLocal(new Date(2026, 0, 9, 23, 30, 0)), '2026-01-09', '한 자리 월·일 0 패딩');
  assert.match(parseQuoteLine('아이엠증권 A1 CP 27/3 3.70%').date, /^\d{4}-\d{2}-\d{2}$/);
});

// ── 어순 비의존 ──────────────────────────────────────────────────────────

test('어순이 뒤바뀌어도 같은 결과 — 위치가 아니라 토큰 모양으로 뽑는다', () => {
  const a = P('아이엠증권 A1 CP 27년 3월 만기 3.70%');
  const b = P('A1 CP 아이엠증권 3.70 27/3');
  for (const k of ['issuer', 'kind', 'grade', 'maturity_ym', 'maturity_date', 'rate', 'amount']) {
    assert.equal(b[k], a[k], `필드 ${k} 불일치`);
  }
  assert.deepEqual(b.flags, []);
  assert.equal(b.raw, 'A1 CP 아이엠증권 3.70 27/3', 'raw 는 각자의 원문');
});

// ── 숫자 오탐 차단 (추출 순서의 존재 이유) ───────────────────────────────

test('만기 오탐 — "27년 3월" 의 3 이 금리로 새지 않는다', () => {
  const r = P('아이엠증권 A1 CP 27년 3월 만기');
  assert.equal(r.maturity_ym, '2027-03');
  assert.equal(r.rate, null, '금리가 없는 라인인데 만기의 월이 금리로 잡혔다');
  assert.ok(r.flags.includes('no_rate'));
  assert.equal(r.issuer, '아이엠증권');
});

test('금액 오탐 — "100억 3.70%" 에서 100 은 금액, 3.70 은 금리', () => {
  const r = P('아이엠증권 A1 CP 27년 3월 100억 3.70%');
  assert.equal(r.amount, 100);
  assert.equal(r.rate, 3.70);
  assert.equal(r.maturity_ym, '2027-03');
  assert.equal(r.issuer, '아이엠증권');
});

test('소수점 없는 정수 단독은 금리가 아니다 (% 가 붙으면 인정)', () => {
  assert.equal(P('아이엠증권 A1 CP 27/3 500').rate, null);
  assert.equal(P('아이엠증권 A1 CP 27/3 3%').rate, 3);
});

// ── 만기 형태 ────────────────────────────────────────────────────────────

test('정확만기 "26.11.20" — maturity_date 채워지고 ym 도 함께', () => {
  const r = P('아이엠증권 A1 CP 26.11.20 만기 3.70%');
  assert.equal(r.maturity_date, '2026-11-20');
  assert.equal(r.maturity_ym, '2026-11');
  assert.equal(r.rate, 3.70, '만기 뒷토막(.20)이 금리를 밀어내면 안 된다');
});

test('정확만기 구분자 이형 — 26/11/20 · 2026-11-20 동일 결과', () => {
  for (const s of ['26/11/20', '2026-11-20']) {
    const r = P(`아이엠증권 A1 CP ${s} 3.70%`);
    assert.equal(r.maturity_date, '2026-11-20', s);
    assert.equal(r.maturity_ym, '2026-11', s);
  }
});

test('연-월 이형 — 27년3월 · 27/3 · 2027-03 동일 결과', () => {
  for (const s of ['27년3월', '27년 3월', '27/3', '2027-03']) {
    const r = P(`아이엠증권 A1 CP ${s} 3.70%`);
    assert.equal(r.maturity_ym, '2027-03', s);
    assert.equal(r.maturity_date, null, s);
    assert.equal(r.rate, 3.70, s);
  }
});

test('만기 없음 — null + flag, 행은 그대로 반환', () => {
  const r = P('아이엠증권 A1 CP 3.70%');
  assert.equal(r.maturity_ym, null);
  assert.equal(r.maturity_date, null);
  assert.ok(r.flags.includes('no_maturity'));
  assert.equal(r.rate, 3.70);
});

// ── 종류 · 등급 ──────────────────────────────────────────────────────────

test('긴 것 우선 — "예담CP" 는 예담이지 CP 가 아니다', () => {
  const r = P('OO증권 A1 예담CP 27년 3월 3.60%');
  assert.equal(r.kind, '예담');
  assert.equal(r.issuer, 'OO증권', 'CP 토막이 발행사에 남으면 안 된다');
  assert.equal(P('아이엠증권 A1 CP 27/3 3.70%').kind, 'CP', '순수 CP 는 그대로 CP');
});

test('예담은 등급 없이 오기도 한다 — grade=null', () => {
  const r = P('OO은행 예담 26년 12월 3.45%');
  assert.equal(r.kind, '예담');
  assert.equal(r.grade, null);
  assert.equal(r.maturity_ym, '2026-12');
  assert.equal(r.rate, 3.45);
  assert.equal(r.issuer, 'OO은행');
});

test('종류 정규화 — 전단→전단채, STB→ABSTB', () => {
  assert.equal(P('OO증권 A1 전단 27/3 3.55%').kind, '전단채');
  assert.equal(P('OO증권 A1 전단채 27/3 3.55%').kind, '전단채');
  assert.equal(P('OO증권 A1 STB 27/3 3.55%').kind, 'ABSTB');
  assert.equal(P('OO증권 A1 ABSTB 27/3 3.55%').kind, 'ABSTB');
});

test('등급 경계 — ABSTB 의 B, CP 의 C 가 등급으로 잡히지 않는다', () => {
  assert.equal(P('OO증권 ABSTB 27/3 3.55%').grade, null, 'ABSTB 안의 B');
  assert.equal(P('OO은행 예담CP 26년 12월 3.45%').grade, null, '예담CP 안의 C');
});

test('등급 이형 — 부호·대소문자', () => {
  assert.equal(P('OO증권 A2+ CP 27/3 3.8%').grade, 'A2+');
  assert.equal(P('OO증권 a2- CP 27/3 3.9%').grade, 'A2-');
  assert.equal(P('OO증권 A3 CP 27/3 4.1%').grade, 'A3');
});

// ── 발행사 정규화 ────────────────────────────────────────────────────────

test('국민은행 — 정규화가 "민" 을 지우지 않는다 (rv2-parser.js:252 함정)', () => {
  assert.equal(normalizeIssuer('국민은행'), '국민은행');
  assert.equal(P('국민은행 예담 26년 12월 3.45%').issuer, '국민은행');
});

test('발행사명의 숫자는 정보다 — 제거하지 않는다', () => {
  assert.equal(normalizeIssuer('SK증권3'), 'SK증권3');
});

test('법인격 꼬리만 정리 — (주) · 주식회사 · 공백', () => {
  assert.equal(normalizeIssuer('(주)국민은행'), '국민은행');
  assert.equal(normalizeIssuer('주식회사 국민은행'), '국민은행');
  assert.equal(normalizeIssuer('  국민은행  '), '국민은행');
  assert.equal(normalizeIssuer(''), null);
  assert.equal(normalizeIssuer(null), null);
});

test('issuer_raw 는 정규화 이전, issuer 는 이후', () => {
  const r = P('(주)국민은행 예담 26년 12월 3.45%');
  assert.equal(r.issuer_raw, '(주)국민은행');
  assert.equal(r.issuer, '국민은행');
});

test('불용어 제거 — 만기·호가는 발행사에 남지 않는다', () => {
  assert.equal(P('아이엠증권 A1 CP 27년 3월 만기 호가 3.70%').issuer, '아이엠증권');
});

// ── 실패 라인도 버리지 않는다 ────────────────────────────────────────────

test('파싱 실패 라인 — raw 보존 + flags, 행은 반드시 반환', () => {
  const line = '확인 요망';
  const r = P(line);
  assert.equal(r.raw, line);
  assert.equal(r.rate, null);
  assert.equal(r.maturity_ym, null);
  assert.equal(r.kind, null);
  assert.equal(r.grade, null);
  assert.deepEqual(r.flags, ['no_rate', 'no_maturity']);
  assert.equal(r.issuer, '확인 요망', '읽지 못한 잔여물도 남긴다 — 사전 확장의 입력');
});

test('발행사가 통째로 비면 no_issuer', () => {
  const r = P('3.70');
  assert.equal(r.rate, 3.70);
  assert.equal(r.issuer, null);
  assert.equal(r.issuer_raw, null);
  assert.deepEqual(r.flags, ['no_maturity', 'no_issuer']);
  assert.equal(r.raw, '3.70');
});

test('빈 입력·비문자열도 행을 반환한다', () => {
  for (const bad of ['', null, undefined, 42]) {
    const r = parseQuoteLine(bad, { date: D });
    assert.equal(r.raw, '', String(bad));
    assert.deepEqual(r.flags, ['no_rate', 'no_maturity', 'no_issuer'], String(bad));
  }
});

// ── dedupeKey · mergeRows ────────────────────────────────────────────────

test('dedupeKey — null 필드는 빈 문자열로 접는다(자릿수 고정)', () => {
  const r = P('OO은행 예담 26년 12월 3.45%');
  assert.equal(dedupeKey(r), '2026-08-31|OO은행|예담||2026-12|3.45');
});

test('mergeRows 멱등 — 같은 입력 2회 병합 시 added=0', () => {
  const rows = [
    P('아이엠증권 A1 CP 27년 3월 3.70%'),
    P('OO은행 예담 26년 12월 3.45%'),
  ];
  const first = mergeRows([], rows);
  assert.equal(first.added, 2);
  assert.equal(first.skipped, 0);

  const second = mergeRows(first.rows, rows);
  assert.equal(second.added, 0, '재병합이 행을 늘렸다 — 멱등성 깨짐');
  assert.equal(second.skipped, 2);
  assert.equal(second.rows.length, 2);
});

test('mergeRows — incoming 내부 중복도 걷는다 (겹치는 구간 재붙여넣기)', () => {
  const a = P('아이엠증권 A1 CP 27년 3월 3.70%');
  const b = P('아이엠증권 A1 CP 27년 3월 3.70%');
  const { rows, added, skipped } = mergeRows([], [a, b]);
  assert.equal(added, 1);
  assert.equal(skipped, 1);
  assert.equal(rows.length, 1);
});

test('mergeRows — 같은 종목 다른 금리는 새 기록이다 (added=1)', () => {
  const base = mergeRows([], [P('아이엠증권 A1 CP 27년 3월 3.70%')]);
  const next = mergeRows(base.rows, [P('아이엠증권 A1 CP 27년 3월 3.72%')]);
  assert.equal(next.added, 1);
  assert.equal(next.rows.length, 2);
});

test('mergeRows — existing 을 변형하지 않는다', () => {
  const existing = [P('아이엠증권 A1 CP 27년 3월 3.70%')];
  const out = mergeRows(existing, [P('OO은행 예담 26년 12월 3.45%')]);
  assert.equal(existing.length, 1, 'existing 이 변형됐다');
  assert.equal(out.rows.length, 2);
});
