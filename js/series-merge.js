// series-merge.js — 저장된 월간 이력(기준) + 업로드(증분) 병합. DOM 무관 순수 모듈.
// Phase 1: 계약만 고정한 스텁. 구현은 Phase 2 (tests/series-merge.test.mjs 가 명세).

export const REVISION_WARN_PT = 0.3;

export function normalizeMonthKey(_raw) {
  throw new Error('normalizeMonthKey: 미구현 (Phase 2)');
}

export function mergeSeries(_existing, _upload) {
  throw new Error('mergeSeries: 미구현 (Phase 2)');
}
