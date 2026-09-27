// csv-parse 매칭 테스트 — node --test (인자 없이 자동탐색).
//
// 초점: 실제 KOSIS 특수분류 CSV 행명(끝 각주 번호 포함)으로 시리즈 자동매칭이 되는가.
// 각주 때문에 매칭이 실패하면 수동 선택에서 엉뚱한 행이 골라질 수 있다(생활물가 오염, 66652f9).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseKosisCsv, matchRow, normKey } from '../js/csv-parse.js';
import { getConfig } from '../js/series-config.js';

// 2026-09-27 받은 KOSIS CSV(소비자물가지수(특수분류)_27131849.csv)의 행명 그대로. 값은 앞 2개월만.
const KOSIS_CSV = [
  '﻿통계표,계정항목,단위,가중치,변환,2025/06,2025/07',
  '"4.2.2. 소비자물가지수(특수분류)","총지수","2020=100","1000","원자료","116.31","116.52"',
  '"4.2.2. 소비자물가지수(특수분류)","농산물및석유류제외지수 2)","2020=100","909.8","원자료","115.25","115.29"',
  '"4.2.2. 소비자물가지수(특수분류)","식료품 및 에너지제외 지수 3)","2020=100","782.2","원자료","113.17","113.47"',
  '"4.2.2. 소비자물가지수(특수분류)","생활물가지수 4)","2020=100","528.4","원자료","119.22","119.22"',
].join('\n');

test('normKey — 끝 각주 번호와 공백 제거', () => {
  assert.equal(normKey('생활물가지수 4)'), '생활물가지수');
  assert.equal(normKey('식료품 및 에너지제외 지수 3)'), '식료품및에너지제외지수');
  assert.equal(normKey('농산물및석유류제외지수 2)'), '농산물및석유류제외지수');
  assert.equal(normKey('생활물가지수4)'), '생활물가지수');
  assert.equal(normKey('총지수'), '총지수');
});

test('normKey — 끝이 아닌 괄호 숫자는 건드리지 않는다', () => {
  assert.equal(normKey('A 1) B'), 'A1)B');
});

test('실제 KOSIS 행명으로 3종 자동매칭 — 각주 번호가 붙어도 자기 행', () => {
  const parsed = parseKosisCsv(KOSIS_CSV);
  const want = {
    'kr-cpi-headline': '총지수',
    'kr-cpi-core': '식료품 및 에너지제외 지수 3)',
    'kr-cpi-lifecost': '생활물가지수 4)',
  };
  for (const [id, account] of Object.entries(want)) {
    assert.equal(matchRow(parsed, getConfig(id).kosis_hint)?.account, account, id);
  }
});

test('생활물가 힌트는 "전월세포함 생활물가지수" 파생 라벨과 매칭하지 않는다', () => {
  const csv = KOSIS_CSV.replace('"생활물가지수 4)"', '"전월세포함 생활물가지수 5)"');
  assert.equal(matchRow(parseKosisCsv(csv), getConfig('kr-cpi-lifecost').kosis_hint), null);
});
