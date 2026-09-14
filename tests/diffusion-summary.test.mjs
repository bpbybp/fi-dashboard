// scripts/ci/diffusion-summary.mjs — 워크플로 요약표·결론 판정 테스트.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, resolveResult, lastPeriodOf } from '../scripts/ci/diffusion-summary.mjs';

const latest = { 'US-CPI': '2026-08', 'US-PCE': '2026-07', KR: '2026-07', EU: '2026-08', JP: '2026-08', Trimmed: '2026-08' };
const latestOf = (row) => latest[row.label] ?? null;

test('run #5 재현: KR·AU failed → 표 7행 + failed=true', () => {
  const env = {
    RESULT_US: 'new', RESULT_EU: 'unchanged', RESULT_JP: 'unchanged', RESULT_TRIMMED: 'new',
    RESULT_KR: 'failed:[diffusion-kr] kosis.kr 3회 시도 실패 — timeout 60000ms',
    OUTCOME_KR: 'failure', OUTCOME_AU: 'failure', OUTCOME_COMMIT: 'success',
  };
  const { markdown, failed } = buildSummary(env, latestOf);
  assert.equal(failed, true);
  assert.equal((markdown.match(/^\| (US-CPI|US-PCE|KR|EU|AU|JP|Trimmed) \|/gm) || []).length, 7);
  assert.match(markdown, /\| US-PCE \| new \| 2026-07 \|/);
  assert.match(markdown, /\| KR \| failed:\[diffusion-kr\] kosis\.kr .* \| 2026-07 \|/);
  assert.match(markdown, /\| AU \| failed:사유 미기록 \| — \|/);
});

test('전부 성공·skip이면 failed=false', () => {
  const env = { RESULT_US: 'skipped', RESULT_KR: 'unchanged', RESULT_EU: 'unchanged', RESULT_AU: 'new',
    RESULT_JP: 'unchanged', RESULT_TRIMMED: 'unchanged', OUTCOME_COMMIT: 'success' };
  assert.equal(buildSummary(env, latestOf).failed, false);
});

test('커밋 스텝 실패도 결론 실패', () => {
  const env = { RESULT_US: 'new', RESULT_KR: 'new', RESULT_EU: 'new', RESULT_AU: 'new',
    RESULT_JP: 'new', RESULT_TRIMMED: 'new', OUTCOME_COMMIT: 'failure' };
  const { markdown, failed } = buildSummary(env, latestOf);
  assert.equal(failed, true);
  assert.match(markdown, /커밋 스텝: failure/);
});

test('사유의 파이프 문자는 표를 깨지 않게 치환', () => {
  const { markdown } = buildSummary({ RESULT_EU: 'failed:a|b' }, latestOf);
  assert.match(markdown, /\| EU \| failed:a\/b \|/);
});

test('resolveResult / lastPeriodOf', () => {
  assert.equal(resolveResult('', 'skipped'), 'skipped');
  assert.equal(resolveResult(undefined, 'cancelled'), 'failed:cancelled');
  assert.equal(lastPeriodOf({ series: [{ period: '2026-07' }, { period: '2026-08' }] }), '2026-08');
  assert.equal(lastPeriodOf({ data: [{ period: '2026-08', value: 1 }] }), '2026-08');
  assert.equal(lastPeriodOf(undefined), null);
});
