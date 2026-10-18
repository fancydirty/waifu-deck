import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { metrics } from '@/theme/metrics';
import { pillContainerStyle } from './pill-container';

test('pill container pins the shared mockup geometry', () => {
  expect(pillContainerStyle).toEqual({
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: metrics.radius.circle,
  });
});

test('pill container delegates its radius to the metrics token', () => {
  const source = readFileSync(join(__dirname, 'pill-container.ts'), 'utf8');
  expect(source).toContain('borderRadius: metrics.radius.circle');
  expect(source).not.toMatch(/borderRadius:\s*999\b/);
});
