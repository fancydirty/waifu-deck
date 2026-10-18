import { fetchJsonWithRetry, toSafeError } from './http.mjs';
import { matchesMode, normalizeProviderPayload } from './normalize.mjs';
import { providerRequest } from './providers.mjs';
import { aggregateProvider, aggregateTotals } from './stats.mjs';

const NETWORK_DEFAULTS = {
  timeoutMs: 8_000,
  maxRetries: 1,
  maxRetryDelayMs: 15_000,
  requestIntervalMs: 500,
};

function emptyInput(provider, targetSamples) {
  return {
    provider,
    targetSamples,
    requests: [],
    observations: [],
    accepted: 0,
    rejections: [],
    failures: [],
  };
}

export async function runAudit(
  options,
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    network = {},
  } = {},
) {
  const settings = { ...NETWORK_DEFAULTS, ...network };
  const inputs = [];
  const startedAt = new Date(now()).toISOString();

  for (const provider of options.providers) {
    const input = emptyInput(provider, options.samples);
    inputs.push(input);

    for (let sample = 0; sample < options.samples; sample += 1) {
      if (sample > 0) await sleep(settings.requestIntervalMs);
      const request = providerRequest(provider, options.mode);
      let payload;
      try {
        payload = await fetchJsonWithRetry({
          ...request,
          fetchImpl,
          sleep,
          now,
          timeoutMs: settings.timeoutMs,
          maxRetries: settings.maxRetries,
          maxRetryDelayMs: settings.maxRetryDelayMs,
          onAttempt: (attempt) => input.requests.push(attempt),
        });
      } catch (error) {
        const safe = toSafeError(error);
        input.rejections.push(safe.reason);
        input.failures.push(safe);
        continue;
      }

      try {
        const normalized = normalizeProviderPayload(provider, payload);
        input.observations.push(...normalized.observations);
        input.rejections.push(...normalized.rejections);
        for (const record of normalized.observations) {
          if (matchesMode(record, options.mode)) input.accepted += 1;
          else input.rejections.push('mode_mismatch');
        }
      } catch (error) {
        const safe = toSafeError(error);
        input.rejections.push(safe.reason);
        input.failures.push(safe);
      }
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    startedAt,
    config: {
      samplesPerProvider: options.samples,
      providers: [...options.providers],
      mode: options.mode,
      network: {
        sequential: true,
        timeoutMs: settings.timeoutMs,
        maxRetries: settings.maxRetries,
        maxRetryDelayMs: settings.maxRetryDelayMs,
        requestIntervalMs: settings.requestIntervalMs,
      },
      imageBytesDownloaded: false,
    },
    summary: aggregateTotals(inputs),
    providers: Object.fromEntries(
      inputs.map((input) => [input.provider, aggregateProvider(input)]),
    ),
  };
}
