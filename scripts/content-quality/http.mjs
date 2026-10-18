const SECRET_ASSIGNMENT = /\b(authorization|api[-_]?key|access[-_]?token|token|secret|password)\b\s*[:=]\s*([^\s,;]+)/gi;
const BEARER_TOKEN = /\bbearer\s+[^\s,;]+/gi;
const URL_LIKE = /https?:\/\/[^\s"'<>]+/gi;
const HOME_PATH = /\/Users\/[^/\s]+/g;

export class AuditRequestError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AuditRequestError';
    this.code = code;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[URL REDACTED]';
  }
}

export function redactText(value) {
  return String(value)
    .replace(URL_LIKE, redactUrl)
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(HOME_PATH, '[HOME]');
}

export function toSafeError(error) {
  if (error instanceof AuditRequestError) {
    return {
      reason: error.code,
      message: redactText(error.message),
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
    };
  }
  if (error !== null && typeof error === 'object' && typeof error.code === 'string') {
    return {
      reason: error.code,
      message: redactText(error instanceof Error ? error.message : 'Request failed'),
    };
  }
  return {
    reason: 'network_error',
    message: redactText(error instanceof Error ? error.message : 'Network request failed'),
  };
}

export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const deadline = Date.parse(value);
  return Number.isNaN(deadline) ? null : Math.max(0, deadline - nowMs);
}

function errorForResponse(response, host, nowMs) {
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), nowMs);
  if (response.status === 429) {
    return new AuditRequestError('rate_limited', `HTTP 429 from ${host}`, {
      status: response.status,
      retryAfterMs: retryAfterMs ?? undefined,
    });
  }
  if (response.status >= 500) {
    return new AuditRequestError('upstream_error', `HTTP ${response.status} from ${host}`, {
      status: response.status,
      retryAfterMs: retryAfterMs ?? undefined,
    });
  }
  return new AuditRequestError('http_error', `HTTP ${response.status} from ${host}`, {
    status: response.status,
  });
}

function canRetry(error) {
  return error.code === 'rate_limited' ||
    error.code === 'upstream_error' ||
    error.code === 'network_error' ||
    error.code === 'timeout';
}

function retryDelay(error, retryIndex) {
  if (error.retryAfterMs !== undefined) return error.retryAfterMs;
  return 500 * (2 ** retryIndex);
}

export async function fetchJsonWithRetry({
  url,
  headers,
  fetchImpl = fetch,
  timeoutMs = 8_000,
  maxRetries = 1,
  maxRetryDelayMs = 15_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onAttempt = () => {},
  now = () => Date.now(),
}) {
  const host = new URL(url).hostname;

  for (let retryIndex = 0; retryIndex <= maxRetries; retryIndex += 1) {
    const startedAt = now();
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let failure = null;
    let body;
    let status;

    try {
      const response = await fetchImpl(url, { headers, signal: controller.signal });
      status = response.status;
      if (!response.ok) {
        failure = errorForResponse(response, host, now());
      } else {
        try {
          body = await response.json();
        } catch {
          failure = new AuditRequestError('invalid_json', `Invalid JSON from ${host}`, {
            status: response.status,
          });
        }
      }
    } catch {
      failure = timedOut
        ? new AuditRequestError('timeout', `Request to ${host} timed out`)
        : new AuditRequestError('network_error', `Network request to ${host} failed`);
    } finally {
      clearTimeout(timeout);
    }

    const latencyMs = Math.max(0, Math.round(now() - startedAt));
    if (failure === null) {
      onAttempt({ ok: true, latencyMs, status, host });
      return body;
    }

    onAttempt({
      ok: false,
      latencyMs,
      status,
      host,
      reason: failure.code,
    });
    const delayMs = retryDelay(failure, retryIndex);
    if (retryIndex >= maxRetries || !canRetry(failure) || delayMs > maxRetryDelayMs) {
      throw failure;
    }
    await sleep(delayMs);
  }

  throw new AuditRequestError('network_error', `Network request to ${host} failed`);
}
