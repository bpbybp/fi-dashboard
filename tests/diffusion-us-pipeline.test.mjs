// US 확산 파이프라인 오프라인 테스트 — node --test (키 불필요).
// fetch 부분은 제외하고, 스냅샷 시계열 → 확산 레코드(누적 z) → 출력 구조 변환만 검증.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeWindow, monthsBetween, buildCountryPayload, serializeRegistration, DETAIL_MONTHS,
} from '../scripts/fetch-inflation-diffusion-us.mjs';
import { US_THRESHOLD_OPTS } from '../scripts/lib/diffusion-core.mjs';

const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

// 합성 스냅샷: period별로 3품목, yoy를 살짝 흔들어 분산 확보.
function synthSnaps(periods) {
  return periods.map((period, k) => ({
    country: 'US-CPI', period, headline_yoy: 3 + (k % 5) * 0.1, core_yoy: 2.5,
    core_yoy_intl: null, source_url: 'test', fetched_at: '',
    items: [
      { code: 'A', name: 'A', weight: 50, yoy: 3.0 + (k % 7) * 0.2 },
      { code: 'B', name: 'B', weight: 30, yoy: 1.0 + (k % 3) * 0.5 },
      { code: 'C', name: 'C', weight: 20, yoy: -1.0 + (k % 4) * 0.3 },
    ],
  }));
}

test('computeWindow: 60개월, 종료=전월, 시작=종료−59', () => {
  const { start, end } = computeWindow(new Date(Date.UTC(2026, 6, 14))); // 2026-07-14
  assert.equal(end, '2026-06');    // 전월
  assert.equal(start, '2021-07');  // 60개월 전
});

test('computeWindow: 1월 경계 정규화', () => {
  const { start, end } = computeWindow(new Date(Date.UTC(2026, 0, 5))); // 2026-01
  assert.equal(end, '2025-12');
  assert.equal(start, '2021-01');
});

test('monthsBetween: 경계 포함 개수', () => {
  const arr = [...monthsBetween('2021-07', '2026-06')];
  assert.equal(arr.length, 60);
  assert.equal(arr[0], '2021-07');
  assert.equal(arr[59], '2026-06');
});

test('buildCountryPayload: series 길이=입력 개월, warmup z=0 이후 비-warmup', () => {
  const periods = [...monthsBetween('2021-07', '2026-06')];
  const { payload, stats } = buildCountryPayload(synthSnaps(periods), { series_id: 'x' });
  assert.equal(stats.periods, 60);
  assert.equal(payload.series.length, 60);
  // 첫 12개월(warmup, history<12)은 z=0
  assert.equal(payload.series[0].z.ge2, 0);
  assert.equal(payload.series[11].z.ge2, 0);
  // 이후엔 z가 계산됨(분산 있으므로 0이 아닐 수 있음 — 최소한 숫자)
  assert.equal(typeof payload.series[40].z.ge2, 'number');
  // 단조성: 각 period에서 ge0 ≥ ge2 ≥ ge25 ≥ ge3
  for (const s of payload.series) {
    assert.ok(s.weighted.ge0 >= s.weighted.ge2);
    assert.ok(s.weighted.ge2 >= s.weighted.ge25);
    assert.ok(s.weighted.ge25 >= s.weighted.ge3);
  }
});

test('buildCountryPayload: detail은 최근 DETAIL_MONTHS개월만', () => {
  const periods = [...monthsBetween('2021-07', '2026-06')];
  const { payload } = buildCountryPayload(synthSnaps(periods), { series_id: 'x' });
  assert.equal(payload.detail.length, DETAIL_MONTHS);
  assert.equal(payload.detail[payload.detail.length - 1].period, '2026-06');
  // yoy!=null 품목만 detail에 포함 (합성은 전부 non-null → 3개)
  assert.equal(payload.detail[0].items.length, 3);
});

test('buildCountryPayload: meta.last_updated = 최신 period', () => {
  const periods = [...monthsBetween('2021-07', '2026-06')];
  const { payload } = buildCountryPayload(synthSnaps(periods), { series_id: 'x' });
  assert.equal(payload.meta.last_updated, '2026-06');
  assert.equal(payload.meta.item_count, 3);
});

test('buildCountryPayload: flash 월(유효 yoy<20%)은 series에서 제외', () => {
  const periods = [...monthsBetween('2025-01', '2025-03')];
  const snaps = synthSnaps(periods);
  // 가운데 월을 flash로 (100품목 중 5개만 non-null)
  snaps[1].items = Array.from({ length: 100 }, (_, i) => ({
    code: 'F' + i, name: 'f', weight: 1, yoy: i < 5 ? 2 : null,
  }));
  const { payload, stats } = buildCountryPayload(snaps, { series_id: 'x' });
  assert.equal(stats.flashSkipped, 1);
  assert.equal(payload.series.length, 2);
  assert.equal(payload.meta.flash_skipped, 1);
});

test('US 임계값 확장: 기존 키 값·순서 불변 + ge3_5/ex_energy 확장 직렬화 + 단조성', () => {
  const periods = [...monthsBetween('2021-07', '2026-06')];
  const snaps = synthSnaps(periods).map((s) => ({ ...s, items: [...s.items,
    { code: 'SETB01', name: 'Gasoline', weight: 10, yoy: 4.0 }] }));
  const base = buildCountryPayload(snaps, { series_id: 'x' }).payload;
  const ext = buildCountryPayload(snaps, { series_id: 'x' }, US_THRESHOLD_OPTS).payload;
  const strip = (s) => ({
    ...s,
    weighted: pick(s.weighted, ['ge0', 'ge2', 'ge25', 'ge3']),
    unweighted: pick(s.unweighted, ['ge0', 'ge2', 'ge25', 'ge3']),
    ex_energy: pick(s.ex_energy, ['ge0', 'ge2']),
    z: pick(s.z, ['ge0', 'ge2', 'ge25', 'ge3']),
  });
  // 확장 키 제거 시 opts 미지정 결과와 JSON 바이트 동일 (ge2 계열·z zero-diff)
  assert.equal(JSON.stringify(ext.series.map(strip)), JSON.stringify(base.series));
  assert.equal(JSON.stringify(ext.detail), JSON.stringify(base.detail));
  assert.doesNotMatch(JSON.stringify(base), /ge3_5/);
  for (const s of ext.series) {
    assert.deepEqual(Object.keys(s.weighted), ['ge0', 'ge2', 'ge25', 'ge3', 'ge3_5']);
    assert.deepEqual(Object.keys(s.ex_energy), ['ge0', 'ge2', 'ge25', 'ge3', 'ge3_5']);
    assert.equal(typeof s.z.ge3_5, 'number');
    for (const o of [s.weighted, s.ex_energy]) {
      assert.ok(o.ge2 >= o.ge25 && o.ge25 >= o.ge3 && o.ge3 >= o.ge3_5);
    }
  }
});

test('serializeRegistration: window.FENRIR_SERIES 자기등록 + file://안전(fetch 없음)', () => {
  const js = serializeRegistration('inflation-diffusion-us-cpi', { meta: { a: 1 }, series: [] });
  assert.match(js, /window\.FENRIR_SERIES = window\.FENRIR_SERIES \|\| \{\};/);
  assert.match(js, /window\.FENRIR_SERIES\["inflation-diffusion-us-cpi"\] =/);
  // 출력에 wall-clock ISO 타임스탬프가 새지 않았는지 (diff-skip 안정성)
  assert.doesNotMatch(js, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
});
