// Not a route parameter: a deep link must never name a file.
// Reading does not consume the seed. StrictMode replays initializers, and
// the next set replaces whatever is stored for that id or digest.
const seeds = new Map<number | string, string>();

export function setDetailOpenSeed(target: number | string, uri: string | null): void {
  if (uri === null) seeds.delete(target);
  else seeds.set(target, uri);
}

export function readDetailOpenSeed(target: number | string): string | null {
  return seeds.get(target) ?? null;
}
