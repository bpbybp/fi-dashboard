// rv2-ui 순수 로직 테스트 — node --test (인자 없이 자동탐색).
// 초점: **§1.7 저장 규약**. RV-1 은 동일 키를 덮어쓰고 RV-2 는 append 하는데,
// 이 차이가 설계 전체가 걸린 지점이라 렌더와 무관하게 따로 못 박는다.
// DOM 을 건드리는 렌더 함수는 여기서 다루지 않는다(모듈 최상위에 DOM 접근이 없어 import 가능).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { accumulate, currentQuotes, todayKey } from '../js/rv2-ui.js';
import { parseRv2 } from '../js/rv2-parser.js';

const emptySession = () => ({ dateKey: '2026-08-05', instruments: {}, demand: [], unclassified: [] });
const quotesOf = (...lines) => parseRv2(lines.join('\n')).quotes;

test('todayKey — 로컬 날짜를 쓴다 (UTC 로 자르면 오전 9시 이전이 전날이 된다)', () => {
  // 한국시간 2026-08-05 08:00 = UTC 2026-08-04 23:00. 로컬 기준이면 08-05 여야 한다.
  assert.equal(todayKey(new Date(2026, 7, 5, 8, 0, 0)), '2026-08-05');
  assert.equal(todayKey(new Date(2026, 0, 9, 23, 30, 0)), '2026-01-09', '한 자리 월·일 0 패딩');
});

test('§1.7 — 같은 레벨 재게시는 관측을 늘리지 않는다 (광고 반복)', () => {
  const s = emptySession();
  const q = quotesOf('트레이더01 (09:00:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]');
  assert.equal(accumulate(s, q).added, 1);

  // 같은 딜러·같은 종목·같은 레벨을 30분 뒤 다시 던졌다.
  const again = quotesOf('트레이더01 (09:30:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]');
  const c = accumulate(s, again);
  assert.deepEqual(c, { added: 0, appended: 0, repeated: 1 });

  const inst = Object.values(s.instruments)[0];
  assert.equal(inst.observations.length, 1, '관측은 하나');
  assert.equal(inst.observations[0].timestamp, '09:00:00', '최초 시각은 유지한다');
  assert.equal(inst.observations[0].last_seen, '09:30:00', 'last_seen 만 갱신');
});

test('§1.7 — 레벨이 바뀌면 덮어쓰지 않고 관측을 쌓는다 (수명주기 데이터)', () => {
  const s = emptySession();
  accumulate(s, quotesOf('트레이더01 (09:00:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]'));
  const c = accumulate(s, quotesOf('트레이더01 (10:00:00) : 28.1.10 중금(사) 언더1 팔자 (민3.751) [한화 0000-1021]'));
  assert.deepEqual(c, { added: 0, appended: 1, repeated: 0 });

  const inst = Object.values(s.instruments)[0];
  assert.equal(inst.observations.length, 2);
  assert.deepEqual(inst.observations.map((o) => o.q.offset_bp), [-3, -1], '−3bp → −1bp 로 물러선 이력이 남는다');
  assert.equal(inst.latest.offset_bp, -1, '랭킹에는 최신 관측을 쓴다');
  assert.equal(currentQuotes(s).length, 1, '호가는 여전히 1건');
});

test('§1.7 — 딜러가 다르면 같은 종목·같은 레벨이어도 별개 호가다', () => {
  const s = emptySession();
  accumulate(s, quotesOf(
    '트레이더01 (09:00:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]',
    '트레이더02 (09:01:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [케이프 0000-1099]',
  ));
  assert.equal(Object.keys(s.instruments).length, 2, '전화번호가 딜러 ID — 중복제거 주 키');
});

test('§1.7 — 방향이 다르면 별개 호가다', () => {
  const s = emptySession();
  accumulate(s, quotesOf(
    '트레이더01 (09:00:00) : 중금채 27.8.3 3.650 팔자 (민 3.610) [한화 0000-1021]',
    '트레이더01 (09:01:00) : 중금채 27.8.3 3.650 사자 (민 3.610) [한화 0000-1021]',
  ));
  assert.equal(Object.keys(s.instruments).length, 2);
});

test('§1.7 — 오프셋 미상 호가도 저장한다 (랭킹에서만 빠진다)', () => {
  const s = emptySession();
  accumulate(s, quotesOf('트레이더01 (09:00:00) : 27.5.4(화) 지에스리테일34-2 (민 3.802) 팔자 [한화 0000-1021]'));
  const [q] = currentQuotes(s);
  assert.equal(q.offset_bp, null);
  assert.equal(q.offset_basis, 'unknown');
  assert.equal(Object.keys(s.instruments).length, 1, '버리지 않는다 — 미상 카운트의 모집단');
});

test('currentQuotes — instrument 당 최신 1건만 돌려준다', () => {
  const s = emptySession();
  accumulate(s, quotesOf('트레이더01 (09:00:00) : 28.1.10 중금(사) 언더3 팔자 (민3.751) [한화 0000-1021]'));
  accumulate(s, quotesOf('트레이더01 (10:00:00) : 28.1.10 중금(사) 언더1 팔자 (민3.751) [한화 0000-1021]'));
  const cur = currentQuotes(s);
  assert.equal(cur.length, 1);
  assert.equal(cur[0].offset_bp, -1);
});
