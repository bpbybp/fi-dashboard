// fetch-retry.mjs — 확산지수 fetcher 공통 HTTP 헬퍼 (타임아웃 + 재시도 + 원인 로그).
//   US(BLS·BEA)·KR·EU·AU·JP·Trimmed 6개 fetcher가 모두 이 경로로 요청한다.
//
// 정책:
//  - 시도별 타임아웃 기본 60s, 환경변수 FETCH_TIMEOUT_MS로 덮어쓰기.
//  - 최대 3회(최초 + 재시도 2회), 간격 3s → 9s.
//  - 재시도 대상: 타임아웃 · 네트워크 오류(fetch reject) · 5xx.
//    4xx는 즉시 반환(재시도 없음) — 키·파라미터 오류는 반복해도 같다.
//  - 최종 실패 시 error.cause(code, errno, syscall, hostname 등)를 메시지에 포함해 throw.
//    5xx가 끝까지 이어지면 마지막 Response를 반환 → 호출자의 기존 !res.ok 처리 유지.
//
// 방법론 무관(전송 계층) — diffusion-core.mjs와 독립.

export const DEFAULT_TIMEOUT_MS = 60_000;
export const RETRY_DELAYS_MS = [3_000, 9_000];

export function resolveTimeoutMs(env = process.env) {
  const n = Number(env.FETCH_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// error(+cause 체인) → 한 줄 진단 문자열.
export function describeError(err) {
  if (!err) return String(err);
  let out = `${err.name || 'Error'}: ${err.message}`;
  const c = err.cause;
  if (c && typeof c === 'object') {
    const fields = ['code', 'errno', 'syscall', 'hostname', 'address', 'port']
      .filter((k) => c[k] != null).map((k) => `${k}=${c[k]}`);
    if (c.message) fields.push(`message=${c.message}`);
    if (fields.length) out += ` [cause: ${fields.join(', ')}]`;
  } else if (c != null) {
    out += ` [cause: ${c}]`;
  }
  return out;
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(url, init = {}, opts = {}) {
  const {
    label = 'fetch',
    timeoutMs = resolveTimeoutMs(),
    delays = RETRY_DELAYS_MS,
    fetchImpl = globalThis.fetch,
    sleep = realSleep,
    log = (msg) => console.error(msg),
  } = opts;
  const attempts = delays.length + 1;
  const host = (() => { try { return new URL(String(url)).host; } catch { return String(url); } })();

  for (let i = 0; i < attempts; i++) {
    const last = i === attempts - 1;
    try {
      const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 500 && !last) {
        log(`[${label}] ${host} HTTP ${res.status} — 재시도 ${i + 1}/${attempts - 1} (${delays[i] / 1000}s 후)`);
        await sleep(delays[i]);
        continue;
      }
      return res;
    } catch (err) {
      const detail = err?.name === 'TimeoutError'
        ? `timeout ${timeoutMs}ms` : describeError(err);
      if (last) {
        throw new Error(`[${label}] ${host} ${attempts}회 시도 실패 — ${detail}`, { cause: err });
      }
      log(`[${label}] ${host} ${detail} — 재시도 ${i + 1}/${attempts - 1} (${delays[i] / 1000}s 후)`);
      await sleep(delays[i]);
    }
  }
  throw new Error(`[${label}] unreachable`);
}
