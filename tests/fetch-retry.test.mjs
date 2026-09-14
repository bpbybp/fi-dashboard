// fetch-retry 헬퍼 단위 테스트 — mock fetch, 실제 대기 없음(sleep 주입).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchWithRetry, describeError, resolveTimeoutMs, DEFAULT_TIMEOUT_MS, RETRY_DELAYS_MS,
} from '../scripts/lib/fetch-retry.mjs';

const resp = (status) => ({ status, ok: status >= 200 && status < 300 });

function harness(script) {
  const calls = [];
  const slept = [];
  const fetchImpl = (url, init) => {
    const step = script[calls.length];
    calls.push({ url, init });
    return step(init);
  };
  return { calls, slept, opts: { fetchImpl, sleep: async (ms) => { slept.push(ms); }, log: () => {} } };
}

// signal 만료 시 reject하는 hang 응답 (실제 fetch의 AbortSignal.timeout 동작 모사).
const hang = (init) => new Promise((_, reject) => {
  init.signal.addEventListener('abort', () => reject(init.signal.reason));
});

test('timeout → 재시도 → 성공', async () => {
  const h = harness([hang, hang, async () => resp(200)]);
  const res = await fetchWithRetry('https://example.test/a', {}, { ...h.opts, timeoutMs: 20 });
  assert.equal(res.status, 200);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.slept, RETRY_DELAYS_MS);   // 3s · 9s
});

test('4xx는 재시도하지 않고 즉시 반환', async () => {
  const h = harness([async () => resp(404), async () => resp(200)]);
  const res = await fetchWithRetry('https://example.test/b', {}, h.opts);
  assert.equal(res.status, 404);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.slept, []);
});

test('5xx는 재시도, 끝까지 5xx면 마지막 응답 반환', async () => {
  const h = harness([async () => resp(503), async () => resp(502), async () => resp(500)]);
  const res = await fetchWithRetry('https://example.test/c', {}, h.opts);
  assert.equal(res.status, 500);
  assert.equal(h.calls.length, 3);
});

test('네트워크 오류 3회 → error.cause 필드 포함 throw', async () => {
  const netErr = () => {
    const cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.data.abs.gov.au'),
      { code: 'ENOTFOUND', errno: -3008, syscall: 'getaddrinfo', hostname: 'api.data.abs.gov.au' });
    return Promise.reject(new TypeError('fetch failed', { cause }));
  };
  const h = harness([netErr, netErr, netErr]);
  await assert.rejects(
    fetchWithRetry('https://api.data.abs.gov.au/data/x', {}, { ...h.opts, label: 'diffusion-au' }),
    (err) => {
      assert.match(err.message, /\[diffusion-au\] api\.data\.abs\.gov\.au 3회 시도 실패/);
      assert.match(err.message, /code=ENOTFOUND/);
      assert.match(err.message, /errno=-3008/);
      assert.match(err.message, /hostname=api\.data\.abs\.gov\.au/);
      return true;
    });
  assert.equal(h.calls.length, 3);
});

test('시도별 init 보존 + signal 주입', async () => {
  const h = harness([async () => resp(200)]);
  await fetchWithRetry('https://example.test/d', { method: 'POST', body: 'x' }, h.opts);
  assert.equal(h.calls[0].init.method, 'POST');
  assert.equal(h.calls[0].init.body, 'x');
  assert.ok(h.calls[0].init.signal instanceof AbortSignal);
});

test('FETCH_TIMEOUT_MS 환경변수 덮어쓰기, 비정상값은 기본 60s', () => {
  assert.equal(resolveTimeoutMs({}), DEFAULT_TIMEOUT_MS);
  assert.equal(DEFAULT_TIMEOUT_MS, 60_000);
  assert.equal(resolveTimeoutMs({ FETCH_TIMEOUT_MS: '90000' }), 90_000);
  assert.equal(resolveTimeoutMs({ FETCH_TIMEOUT_MS: 'abc' }), DEFAULT_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ FETCH_TIMEOUT_MS: '0' }), DEFAULT_TIMEOUT_MS);
});

test('describeError: cause 없는 에러도 안전', () => {
  assert.equal(describeError(new Error('x')), 'Error: x');
});
