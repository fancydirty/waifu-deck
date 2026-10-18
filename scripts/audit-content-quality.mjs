#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parseArgs, usage } from './content-quality/cli.mjs';
import { toSafeError } from './content-quality/http.mjs';
import { formatTerminalReport } from './content-quality/report.mjs';
import { runAudit } from './content-quality/runner.mjs';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const report = await runAudit(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  process.stderr.write(`${formatTerminalReport(report)}\n`);
  if (options.output !== null) {
    const output = path.resolve(options.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, json, 'utf8');
    process.stderr.write(`JSON written to ${output}\n`);
  }
  process.stdout.write(json);
}

main().catch((error) => {
  const safe = toSafeError(error);
  process.stderr.write(`Audit failed (${safe.reason}): ${safe.message}\n`);
  if (safe.reason === 'invalid_arguments') process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
});
