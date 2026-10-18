const PROVIDER_ALIASES = new Map([
  ['waifu', 'waifu_im'],
  ['waifu.im', 'waifu_im'],
  ['waifu_im', 'waifu_im'],
  ['nekos', 'nekos_api'],
  ['nekos-api', 'nekos_api'],
  ['nekos_api', 'nekos_api'],
  ['danbooru', 'danbooru'],
]);

const ALL_PROVIDERS = ['waifu_im', 'nekos_api', 'danbooru'];
const MODES = new Set(['sfw', 'mixed', 'nsfw']);

export class CliArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliArgumentError';
    this.code = 'invalid_arguments';
  }
}

function optionValue(args, index, option) {
  const argument = args[index];
  const equals = argument.indexOf('=');
  if (equals !== -1) return { value: argument.slice(equals + 1), consumed: 0 };
  if (index + 1 >= args.length || args[index + 1].startsWith('--')) {
    throw new CliArgumentError(`${option} requires a value`);
  }
  return { value: args[index + 1], consumed: 1 };
}

function parseProviders(values) {
  if (values.length === 0) return [...ALL_PROVIDERS];
  const requested = values.flatMap((value) => value.split(','))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (requested.includes('all')) {
    if (requested.length !== 1) {
      throw new CliArgumentError('--provider all cannot be combined with another provider');
    }
    return [...ALL_PROVIDERS];
  }

  const providers = requested.map((value) => {
    const provider = PROVIDER_ALIASES.get(value);
    if (provider === undefined) {
      throw new CliArgumentError(`Unknown provider: ${value}`);
    }
    return provider;
  });
  return [...new Set(providers)];
}

export function parseArgs(args) {
  let samples = 3;
  let mode = 'sfw';
  let output = null;
  let help = false;
  const providerValues = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--samples' || argument.startsWith('--samples=')) {
      const parsed = optionValue(args, index, '--samples');
      index += parsed.consumed;
      samples = Number(parsed.value);
      continue;
    }
    if (argument === '--provider' || argument.startsWith('--provider=')) {
      const parsed = optionValue(args, index, '--provider');
      index += parsed.consumed;
      providerValues.push(parsed.value);
      continue;
    }
    if (argument === '--mode' || argument.startsWith('--mode=')) {
      const parsed = optionValue(args, index, '--mode');
      index += parsed.consumed;
      mode = parsed.value.trim().toLowerCase();
      continue;
    }
    if (argument === '--output' || argument.startsWith('--output=')) {
      const parsed = optionValue(args, index, '--output');
      index += parsed.consumed;
      output = parsed.value.trim();
      continue;
    }
    throw new CliArgumentError(`Unknown option: ${argument}`);
  }

  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 500) {
    throw new CliArgumentError('--samples must be an integer from 1 to 500');
  }
  if (!MODES.has(mode)) {
    throw new CliArgumentError('--mode must be sfw, mixed, or nsfw');
  }
  if (output === '') throw new CliArgumentError('--output cannot be empty');

  return {
    samples,
    providers: parseProviders(providerValues),
    mode,
    output,
    help,
  };
}

export function usage() {
  return [
    'Usage: node scripts/audit-content-quality.mjs [options]',
    '',
    'Options:',
    '  --samples N                  Metadata requests per provider (default: 3, max: 500)',
    '  --provider NAME[,NAME...]    waifu, nekos, danbooru, or all (default: all)',
    '  --mode MODE                  sfw, mixed, or nsfw (default: sfw)',
    '  --output PATH                Also write the JSON report to PATH',
    '  --help                       Show this help',
  ].join('\n');
}
