import { PROVIDER_LABELS } from './providers.mjs';

function values(value) {
  const entries = Object.entries(value);
  return entries.length === 0
    ? 'none'
    : entries.map(([name, count]) => `${name}:${count}`).join(', ');
}

function dimensions(value) {
  if (value.median === null) return `n/a (${value.missing} missing)`;
  return `min ${value.min.width}x${value.min.height}, median ${value.median.width}x${value.median.height}`;
}

function latency(value) {
  return value.p50 === null ? 'n/a' : `p50 ${value.p50}ms / p95 ${value.p95}ms`;
}

export function formatTerminalReport(report) {
  const lines = [
    `Content quality audit | mode=${report.config.mode} | samples/provider=${report.config.samplesPerProvider}`,
  ];
  for (const provider of report.config.providers) {
    const result = report.providers[provider];
    lines.push(
      `${PROVIDER_LABELS[provider]}: requests ${result.requests.attempts}, success ${result.requests.successes}, failure ${result.requests.failures} (${latency(result.requests.latencyMs)})`,
      `  observed ${result.samples.observed}, accepted ${result.samples.accepted}, rejected ${result.samples.rejected}; ratings ${values(result.ratingDistribution)}`,
      `  dimensions ${dimensions(result.dimensions)}; tags ${result.tagCoverage.coveragePercent}%; duplicate IDs ${result.duplicates.providerIds.duplicateRecords}, sources ${result.duplicates.sourceUrls.duplicateRecords}`,
    );
    if (Object.keys(result.rejectionReasons).length > 0) {
      lines.push(`  rejections ${values(result.rejectionReasons)}`);
    }
  }
  lines.push(
    `Total: requests ${report.summary.requests.attempts}, success ${report.summary.requests.successes}, failure ${report.summary.requests.failures}; accepted ${report.summary.samples.accepted}/${report.summary.samples.target}; cross-source duplicates ${report.summary.duplicates.sourceUrls.duplicateRecords}`,
  );
  return lines.join('\n');
}
