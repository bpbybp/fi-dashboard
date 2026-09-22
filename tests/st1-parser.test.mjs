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
  assert.equal(r.sector, null, '단기물에는 섹터가 없다');
  assert.equal(r.grade, 'A1');
  assert.equal(r.grade_scale, 'st');
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

// ── 채권 · 장기 등급 ─────────────────────────────────────────────────────
//
// 단기 체계와 장기 체계를 한 열(grade)에 담고 grade_scale 로 가른다.
// 여기서 못 박는 것은 ① 장기 등급 어휘와 "0" 부착, ② 섹터 정규화,
// ③ 겹치는 글자(B·C·D)의 체계 판정, ④ 단독 A 의 거부다.

test('카드채 — kind=채권 · sector=여전채 · 장기등급', () => {
  const r = P('KB국민카드 AA+ 카드채 27.6.20 3.62%');
  assert.equal(r.kind, '채권');
  assert.equal(r.sector, '여전채');
  assert.equal(r.grade, 'AA+');
  assert.equal(r.grade_scale, 'lt');
  assert.equal(r.maturity_date, '2027-06-20');
  assert.equal(r.rate, 3.62);
  assert.equal(r.issuer, 'KB국민카드');
  assert.deepEqual(r.flags, []);
});

test('회사채 — AA0 은 그대로 AA0', () => {
  const r = P('롯데케미칼 AA0 회사채 28년 3월 만기 3.95%');
  assert.equal(r.kind, '채권');
  assert.equal(r.sector, '회사채');
  assert.equal(r.grade, 'AA0');
  assert.equal(r.grade_scale, 'lt');
  assert.equal(r.maturity_ym, '2028-03');
  assert.equal(r.issuer, '롯데케미칼');
});

test('부호 없는 장기 등급에는 "0" 을 붙인다 — AA → AA0', () => {
  const r = P('신한은행 AA 은행채 27/9 3.40');
  assert.equal(r.sector, '은행채');
  assert.equal(r.grade, 'AA0', '"AA" 와 "AA0" 이 갈리면 원장이 두 줄로 쪼개진다');
  assert.equal(r.grade_scale, 'lt');
  assert.equal(r.rate, 3.40);
  assert.equal(r.issuer, '신한은행');
  assert.equal(P('OO 회사채 BBB 27/3 5.0%').grade, 'BBB0');
  assert.equal(P('OO 회사채 BB 27/3 6.0%').grade, 'BB0');
});

test('AAA 는 부호를 붙이지 않는다', () => {
  const r = P('한국도로공사 AAA 공사채 29-12 3.55%');
  assert.equal(r.grade, 'AAA');
  assert.equal(r.grade_scale, 'lt');
  assert.equal(r.sector, '공사채');
  assert.equal(r.maturity_ym, '2029-12');
  assert.equal(r.issuer, '한국도로공사');
});

test('단독 A 는 등급으로 인정하지 않는다 — grade=null + ambiguous_grade', () => {
  const r = P('OO A 회사채 27.3 4.10%');
  assert.equal(r.grade, null, '한 글자 A 를 인정하면 영문 상호가 전부 등급이 된다');
  assert.equal(r.grade_scale, null);
  assert.ok(r.flags.includes('ambiguous_grade'));
  assert.ok(!r.flags.includes('no_grade'), '예담의 "등급 없음" 과는 다른 상태다');
  assert.equal(r.kind, '채권');
  assert.equal(r.sector, '회사채');
  assert.equal(r.rate, 4.10);
});

test('부호가 붙은 A 는 인정한다 — A+ · A0 · A-', () => {
  for (const g of ['A+', 'A0', 'A-']) {
    const r = P(`OO 회사채 ${g} 27/3 4.1%`);
    assert.equal(r.grade, g, g);
    assert.equal(r.grade_scale, 'lt', g);
    assert.deepEqual(r.flags, [], g);
  }
});

test('예담의 등급 없음에는 ambiguous_grade 가 붙지 않는다', () => {
  const r = P('OO은행 예담 26년 12월 3.45%');
  assert.equal(r.grade, null);
  assert.equal(r.grade_scale, null);
  assert.deepEqual(r.flags, []);
});

test('겹치는 글자 B — 종류가 체계를 가른다', () => {
  const lt = P('OO B 회사채 27/3 4.50%');
  assert.equal(lt.grade, 'B');
  assert.equal(lt.grade_scale, 'lt');
  assert.deepEqual(lt.flags, []);

  const st = P('OO B CP 27/3 4.50%');
  assert.equal(st.grade, 'B');
  assert.equal(st.grade_scale, 'st');
  assert.deepEqual(st.flags, []);
});

test('겹치는 글자인데 종류가 없으면 장기로 두고 추측을 남긴다', () => {
  const r = P('OO B 27/3 4.50%');
  assert.equal(r.grade, 'B');
  assert.equal(r.grade_scale, 'lt');
  assert.ok(r.flags.includes('grade_scale_guessed'));
});

test('섹터 정규화 — 특수채→공사채, 카드·캐피탈→여전채', () => {
  assert.equal(P('OO 특수채 AAA 30/6 3.3%').sector, '공사채');
  assert.equal(P('OO 여전채 AA0 27/3 3.9%').sector, '여전채');
  assert.equal(P('OO 캐피탈채 A+ 27/3 4.0%').sector, '여전채');
  assert.equal(P('OO 지방채 AA0 28/1 3.5%').sector, '지방채');
  assert.equal(P('OO 채권 AA0 27/5 3.6%').sector, null, '"채권" 단독은 섹터를 모른다');
});

test('긴 것 우선 — "카드채" 가 "채권" 보다 먼저다', () => {
  assert.equal(P('OO 카드채권 AA0 27/3 3.9%').sector, '여전채');
});

test('장기 등급만 있고 종류가 없으면 채권으로 본다 — kind_inferred', () => {
  const r = P('롯데케미칼 AA0 28년 3월 3.95%');
  assert.equal(r.kind, '채권');
  assert.equal(r.sector, null, '섹터까지 지어내지는 않는다');
  assert.ok(r.flags.includes('kind_inferred'));
});

test('단기 등급은 종류를 지어내지 않는다', () => {
  const r = P('아이엠증권 A1 27년 3월 3.70%');
  assert.equal(r.kind, null);
  assert.equal(r.grade_scale, 'st');
  assert.ok(!r.flags.includes('kind_inferred'));
});

test('채권 어휘가 단기물 판정을 밀어내지 않는다', () => {
  assert.equal(P('아이엠증권 A1 CP 27/3 3.70%').kind, 'CP');
  assert.equal(P('OO은행 예담CP 26년 12월 3.45%').kind, '예담');
  assert.equal(P('OO증권 A1 ABSTB 27/3 3.55%').kind, 'ABSTB');
});

test('행 스키마 — sector·grade_scale 은 항상 존재한다(값이 없으면 null)', () => {
  for (const line of ['확인 요망', '', '아이엠증권 A1 CP 27/3 3.70%']) {
    const r = parseQuoteLine(line, { date: D });
    assert.ok('sector' in r, line);
    assert.ok('grade_scale' in r, line);
  }
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
  assert.equal(dedupeKey(r), '2026-08-31|OO은행|예담||2026-12|3.45|');
});

test('dedupeKey — sector 없는 기존 행과 sector=null 신규 행의 키가 같다', () => {
  // Phase 1 이전에 적힌 행에는 sector 키가 아예 없다. 마이그레이션 없이 같은 키여야 한다.
  const legacy = {
    date: '2026-08-31', issuer: 'OO은행', kind: '예담', grade: null,
    maturity_ym: '2026-12', rate: 3.45,
  };
  const fresh = P('OO은행 예담 26년 12월 3.45%');
  assert.equal(fresh.sector, null);
  assert.equal(dedupeKey(legacy), dedupeKey(fresh), '기존 원장 행이 새 행으로 재계상된다');
  assert.equal(mergeRows([legacy], [fresh]).added, 0, '기존 행 위에 같은 호가가 또 쌓였다');
});

test('dedupeKey — 섹터가 다르면 다른 기록이다', () => {
  const a = P('OO 은행채 AA0 27/3 3.5%');
  const b = P('OO 회사채 AA0 27/3 3.5%');
  assert.notEqual(dedupeKey(a), dedupeKey(b));
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
