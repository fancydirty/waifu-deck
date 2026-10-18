export const MAX_WAIFU_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

export function shouldRetryWaifu(failureCount: number, error: unknown): boolean {
  if (
    failureCount >= MAX_WAIFU_RETRIES ||
    error === null ||
    typeof error !== 'object' ||
    !('code' in error)
  ) {
    return false;
  }

  const providerError = error as { code: unknown; status?: unknown };
  if (
    providerError.code === 'timeout' ||
    providerError.code === 'network' ||
    providerError.code === 'rate_limited'
  ) {
    return true;
  }

  return providerError.code === 'http' &&
    typeof providerError.status === 'number' &&
    providerError.status >= 500;
}

export function waifuRetryDelay(attempt: number, error: unknown): number {
  if (
    error !== null &&
    typeof error === 'object' &&
    'retryAfterMs' in error &&
    typeof error.retryAfterMs === 'number'
  ) {
    return error.retryAfterMs;
  }

  return Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}
