import { createHandedOverPublishers } from '@/providers/handed-over-publishers';

test('count follows registrations, and a release is idempotent', () => {
  const publishers = createHandedOverPublishers();

  const first = publishers.register();
  const second = publishers.register();
  expect(publishers.count()).toBe(2);

  first();
  first();
  expect(publishers.count()).toBe(1);

  second();
  expect(publishers.count()).toBe(0);
});
