import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// K1: the composition root must run mirror-up BEFORE the download pass inside
// one round; board #27 S3 made the round mode-aware and moved its body into
// `library-sync-round.ts`, where behaviour tests pin the ordering and the
// best-effort upload (`library-sync-round.test.ts`). What only the composition
// can get wrong is which round the trigger drives, so this guard pins that.
test('library-integration-impl hands the trigger the mode-aware round', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/features/library/library-integration-impl.ts'),
    'utf8',
  );
  expect(source).toMatch(/const round = createLibrarySyncRound\(\{/);
  expect(source).toMatch(/createLibrarySyncTrigger\(\{\s*sync,\s*round,/);
  expect(source).not.toContain('afterCycle:');
});
