function round(value, places = 2) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export function percentile(values, percent) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percent / 100) * ordered.length) - 1);
  return ordered[index];
}

function distribution(values) {
  return Object.fromEntries(
    [...values.reduce((counts, value) => {
      counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    }, new Map())].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function duplicateSummary(records, valueFor) {
  const values = records.map(valueFor)
    .filter((value) => typeof value === 'string' && value !== '');
  const groups = Object.entries(distribution(values))
    .filter(([, count]) => count > 1)
    .map(([value, count]) => ({ value, count }));
  return {
    groups,
    duplicateRecords: groups.reduce((total, group) => total + group.count - 1, 0),
  };
}

function dimensionSummary(records) {
  const known = records.filter((record) => record.width !== null && record.height !== null);
  if (known.length === 0) {
    return { known: 0, missing: records.length, min: null, median: null };
  }
  const ordered = [...known].sort((left, right) =>
    (left.width * left.height) - (right.width * right.height) ||
    left.width - right.width ||
    left.height - right.height,
  );
  const median = ordered[Math.max(0, Math.ceil(ordered.length / 2) - 1)];
  return {
    known: known.length,
    missing: records.length - known.length,
    min: { width: ordered[0].width, height: ordered[0].height },
    median: { width: median.width, height: median.height },
  };
}

function tagSummary(records) {
  const withTags = records.filter((record) => record.tags.length > 0).length;
  const totalTags = records.reduce((total, record) => total + record.tags.length, 0);
  return {
    withTags,
    withoutTags: records.length - withTags,
    coveragePercent: records.length === 0 ? 0 : round((withTags / records.length) * 100),
    averageTags: records.length === 0 ? 0 : round(totalTags / records.length),
    withNsfwTags: records.filter((record) => record.hasNsfwTag).length,
  };
}

function requestSummary(requests) {
  const latencies = requests.map((request) => request.latencyMs);
  return {
    attempts: requests.length,
    successes: requests.filter((request) => request.ok).length,
    failures: requests.filter((request) => !request.ok).length,
    latencyMs: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
    },
  };
}

export function aggregateProvider({
  provider,
  targetSamples,
  requests,
  observations,
  accepted,
  rejections,
  failures = [],
}) {
  return {
    provider,
    requests: requestSummary(requests),
    samples: {
      target: targetSamples,
      observed: observations.length,
      accepted,
      rejected: rejections.length,
    },
    ratingDistribution: distribution(observations.map((record) => record.rawRating)),
    safetyDistribution: distribution(observations.map((record) => record.safety)),
    dimensions: dimensionSummary(observations),
    tagCoverage: tagSummary(observations),
    duplicates: {
      providerIds: duplicateSummary(observations, (record) => record.providerId),
      sourceIds: duplicateSummary(observations, (record) => record.sourceId),
      sourceUrls: duplicateSummary(observations, (record) => record.sourceUrl),
    },
    rejectionReasons: distribution(rejections),
    failureSamples: failures.slice(0, 5),
  };
}

export function aggregateTotals(providerInputs) {
  const requests = providerInputs.flatMap((input) => input.requests);
  const observations = providerInputs.flatMap((input) => input.observations);
  const rejections = providerInputs.flatMap((input) => input.rejections);
  return {
    requests: requestSummary(requests),
    samples: {
      target: providerInputs.reduce((total, input) => total + input.targetSamples, 0),
      observed: observations.length,
      accepted: providerInputs.reduce((total, input) => total + input.accepted, 0),
      rejected: rejections.length,
    },
    ratingDistribution: distribution(observations.map((record) => record.rawRating)),
    safetyDistribution: distribution(observations.map((record) => record.safety)),
    dimensions: dimensionSummary(observations),
    tagCoverage: tagSummary(observations),
    duplicates: {
      providerIds: duplicateSummary(
        observations,
        (record) => `${record.provider}:${record.providerId}`,
      ),
      sourceIds: duplicateSummary(
        observations,
        (record) => typeof record.sourceId === 'string' && record.sourceId !== ''
          ? `${record.provider}:${record.sourceId}`
          : null,
      ),
      sourceUrls: duplicateSummary(observations, (record) => record.sourceUrl),
    },
    rejectionReasons: distribution(rejections),
  };
}
