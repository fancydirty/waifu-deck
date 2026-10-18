import assert from 'node:assert/strict';
import test from 'node:test';

import { CliArgumentError, parseArgs } from './cli.mjs';

test('uses gentle all-provider defaults', () => {
  assert.deepEqual(parseArgs([]), {
    samples: 3,
    providers: ['waifu_im', 'nekos_api', 'danbooru'],
    mode: 'sfw',
    output: null,
    help: false,
  });
});

test('parses aliases, repeated providers, equals values, and output', () => {
  assert.deepEqual(
    parseArgs([
      '--samples=12',
      '--provider',
      'waifu,nekos',
      '--provider=danbooru',
      '--mode',
      'mixed',
      '--output',
      'tmp/audit.json',
    ]),
    {
      samples: 12,
      providers: ['waifu_im', 'nekos_api', 'danbooru'],
      mode: 'mixed',
      output: 'tmp/audit.json',
      help: false,
    },
  );
});

test('rejects unknown providers and unsafe sample bounds', () => {
  assert.throws(() => parseArgs(['--provider', 'mystery']), CliArgumentError);
  assert.throws(() => parseArgs(['--samples', '0']), /integer from 1 to 500/);
  assert.throws(() => parseArgs(['--samples', '501']), /integer from 1 to 500/);
});
