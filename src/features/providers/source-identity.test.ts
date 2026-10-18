import { canonicalizeSourceUrl, normalizedMd5Hex } from './source-identity';

test.each([
  ['https://www.pixiv.net/en/artworks/12345', 'pixiv:12345'],
  [
    'https://i.pximg.net/img-original/img/2025/01/02/03/04/05/12345_p0.png',
    'pixiv:12345',
  ],
  ['https://x.com/artist/status/98765?s=20', 'x:98765'],
  ['https://twitter.com/artist/status/98765', 'x:98765'],
  ['https://danbooru.donmai.us/post/show/456', 'danbooru:456'],
  ['https://danbooru.donmai.us/posts/456', 'danbooru:456'],
])('canonicalizes %s', (source, expected) => {
  expect(canonicalizeSourceUrl(source)).toBe(expected);
});

test('normalizes a generic source without accepting unsafe protocols', () => {
  expect(canonicalizeSourceUrl('https://Example.com/post/7/#preview'))
    .toBe('url:https://example.com/post/7');
  expect(canonicalizeSourceUrl('javascript:alert(1)')).toBeNull();
});

test.each([
  ['https://mypixiv.net/artworks/12345', 'url:https://mypixiv.net/artworks/12345'],
  [
    'https://evilpximg.net/img-original/12345_p0.png',
    'url:https://evilpximg.net/img-original/12345_p0.png',
  ],
  ['https://notdonmai.us/posts/456', 'url:https://notdonmai.us/posts/456'],
])('does not trust a lookalike provider host: %s', (source, expected) => {
  expect(canonicalizeSourceUrl(source)).toBe(expected);
});

test.each([
  ['https://subdomain.pixiv.net/artworks/12345', 'pixiv:12345'],
  [
    'https://images.pximg.net/img-original/12345_p2.png',
    'pixiv:12345',
  ],
  ['https://beta.donmai.us/posts/456', 'danbooru:456'],
])('accepts a real provider subdomain: %s', (source, expected) => {
  expect(canonicalizeSourceUrl(source)).toBe(expected);
});

test.each([
  ['http://www.pixiv.net/member_illust.php?mode=medium&illust_id=123', 'pixiv:123'],
  ['https://pixiv.net/member_illust.php?mode=medium&illust_id=123', 'pixiv:123'],
  ['https://www.pixiv.net/member_illust.php?illust_id=123&mode=medium', 'pixiv:123'],
  [
    'https://www.pixiv.net/member_illust.php?mode=medium&illust_id=123&ref=twitter',
    'pixiv:123',
  ],
  ['https://www.pixiv.net/member_illust.php/?illust_id=123', 'pixiv:123'],
])('canonicalizes old-style pixiv member_illust URL: %s', (source, expected) => {
  expect(canonicalizeSourceUrl(source)).toBe(expected);
});

test.each([
  ['http://e621.net/posts/55', 'e621:55'],
  ['https://www.e621.net/posts/55', 'e621:55'],
  ['https://e621.net/posts/55/', 'e621:55'],
  ['https://e926.net/posts/55', 'e621:55'],
  ['https://www.e926.net/posts/55', 'e621:55'],
])('canonicalizes e621/e926 post URL to the shared scheme: %s', (source, expected) => {
  expect(canonicalizeSourceUrl(source)).toBe(expected);
});

test.each([
  ['http://konachan.com/post/show/789', 'konachan:789'],
  ['https://www.konachan.com/post/show/789', 'konachan:789'],
  ['https://konachan.com/post/show/789/', 'konachan:789'],
  ['https://konachan.net/post/show/789', 'konachan:789'],
])('canonicalizes konachan post URL: %s', (source, expected) => {
  expect(canonicalizeSourceUrl(source)).toBe(expected);
});

test.each([
  ['http://yande.re/post/show/321', 'yandere:321'],
  ['https://www.yande.re/post/show/321', 'yandere:321'],
  ['https://yande.re/post/show/321/', 'yandere:321'],
])('canonicalizes yande.re post URL: %s', (source, expected) => {
  expect(canonicalizeSourceUrl(source)).toBe(expected);
});

test.each([
  ['http://safebooru.org/index.php?page=post&s=view&id=999', 'safebooru:999'],
  ['https://www.safebooru.org/index.php?page=post&s=view&id=999', 'safebooru:999'],
  ['https://safebooru.org/index.php?s=view&id=999&page=post', 'safebooru:999'],
  ['https://safebooru.org/index.php?page=post&s=view&id=999&tags=foo', 'safebooru:999'],
])('canonicalizes safebooru post URL: %s', (source, expected) => {
  expect(canonicalizeSourceUrl(source)).toBe(expected);
});

test.each([
  ['http://gelbooru.com/index.php?page=post&s=view&id=999', 'gelbooru:999'],
  ['https://www.gelbooru.com/index.php?page=post&s=view&id=999', 'gelbooru:999'],
  ['https://gelbooru.com/index.php?s=view&id=999&page=post', 'gelbooru:999'],
])('canonicalizes gelbooru post URL: %s', (source, expected) => {
  expect(canonicalizeSourceUrl(source)).toBe(expected);
});

test('old-style and new-style pixiv URLs collide on the same scheme', () => {
  expect(
    canonicalizeSourceUrl('https://www.pixiv.net/member_illust.php?mode=medium&illust_id=123'),
  ).toBe('pixiv:123');
  expect(canonicalizeSourceUrl('https://pixiv.net/en/artworks/123')).toBe('pixiv:123');
  expect(
    canonicalizeSourceUrl('https://www.pixiv.net/member_illust.php?mode=medium&illust_id=123'),
  ).toBe(canonicalizeSourceUrl('https://pixiv.net/en/artworks/123'));
});

test('e621 and e926 mirrors collide on the same scheme', () => {
  expect(canonicalizeSourceUrl('https://e926.net/posts/55')).toBe(
    canonicalizeSourceUrl('https://e621.net/posts/55'),
  );
});

test.each([
  ['https://not-e621.example/posts/123', 'url:https://not-e621.example/posts/123'],
  ['https://not-konachan.example/post/show/123', 'url:https://not-konachan.example/post/show/123'],
  ['https://not-yandere.example/post/show/123', 'url:https://not-yandere.example/post/show/123'],
  [
    'https://not-safebooru.example/index.php?page=post&s=view&id=123',
    'url:https://not-safebooru.example/index.php?page=post&s=view&id=123',
  ],
])('does not trust a lookalike host for the new schemes: %s', (source, expected) => {
  expect(canonicalizeSourceUrl(source)).toBe(expected);
});

test('a member_illust URL without a numeric illust_id falls back to the generic bucket', () => {
  expect(canonicalizeSourceUrl('https://www.pixiv.net/member_illust.php?mode=medium')).toBe(
    'url:https://pixiv.net/member_illust.php?mode=medium',
  );
  expect(
    canonicalizeSourceUrl('https://www.pixiv.net/member_illust.php?illust_id=abc'),
  ).toBe('url:https://pixiv.net/member_illust.php?illust_id=abc');
});

test('distinct garbage/truncated URLs do not collide in the generic bucket', () => {
  const first = canonicalizeSourceUrl('https://example.com/gone/aaaa');
  const second = canonicalizeSourceUrl('https://example.com/gone/bbbb');
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(first).not.toBe(second);
});

test('the generic bucket keeps http/www normalization but preserves the query string as a distinguishing signal', () => {
  expect(canonicalizeSourceUrl('http://www.example.com/gallery/1?ref=abc')).toBe(
    'url:https://example.com/gallery/1?ref=abc',
  );
  const withQuery = canonicalizeSourceUrl('https://example.com/gallery/1?ref=abc');
  const withoutQuery = canonicalizeSourceUrl('https://example.com/gallery/1');
  const differentQuery = canonicalizeSourceUrl('https://example.com/gallery/1?ref=xyz');
  expect(withQuery).not.toBe(withoutQuery);
  expect(withQuery).not.toBe(differentQuery);
});

test.each([
  ['https://danbooru.donmai.us/posts/123abc', 'url:https://danbooru.donmai.us/posts/123abc'],
  [
    'https://danbooru.donmai.us/posts/2026-happy-new-year',
    'url:https://danbooru.donmai.us/posts/2026-happy-new-year',
  ],
  [
    'https://danbooru.donmai.us/post/show/789xyz',
    'url:https://danbooru.donmai.us/post/show/789xyz',
  ],
  ['https://e621.net/posts/123abc', 'url:https://e621.net/posts/123abc'],
  [
    'https://e621.net/posts/2026-happy-new-year',
    'url:https://e621.net/posts/2026-happy-new-year',
  ],
  ['https://e926.net/posts/2026-other-post', 'url:https://e926.net/posts/2026-other-post'],
  [
    'https://konachan.com/post/show/789xyz',
    'url:https://konachan.com/post/show/789xyz',
  ],
  ['https://yande.re/post/show/789xyz', 'url:https://yande.re/post/show/789xyz'],
])(
  'does not extract a scheme from an id run trailed by non-boundary characters: %s',
  (source, expected) => {
    expect(canonicalizeSourceUrl(source)).toBe(expected);
  },
);

test('a digit-prefixed post id that is really a different post does not collide with the numeric prefix', () => {
  const first = canonicalizeSourceUrl('https://e621.net/posts/2026-happy-new-year');
  const second = canonicalizeSourceUrl('https://e621.net/posts/2026-other-post');
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(first).not.toBe(second);
  expect(first).not.toBe('e621:2026');
  expect(second).not.toBe('e621:2026');
});

test.each([
  ['https://danbooru.donmai.us/posts/123/', 'danbooru:123'],
  ['https://danbooru.donmai.us/posts/123?q=foo', 'danbooru:123'],
  ['https://danbooru.donmai.us/post/show/123/', 'danbooru:123'],
  ['https://e621.net/posts/123/', 'e621:123'],
  ['https://e621.net/posts/123?q=foo', 'e621:123'],
  ['https://konachan.com/post/show/123/', 'konachan:123'],
  ['https://konachan.com/post/show/123?q=foo', 'konachan:123'],
  ['https://yande.re/post/show/123/', 'yandere:123'],
  ['https://yande.re/post/show/123?q=foo', 'yandere:123'],
])(
  'the path-boundary anchor does not over-reject a clean numeric id: %s',
  (source, expected) => {
    expect(canonicalizeSourceUrl(source)).toBe(expected);
  },
);

describe('normalizedMd5Hex', () => {
  const VALID = '0123456789ABCDEF0123456789abcdef';

  it('lowercases a valid 32-char hex digest', () => {
    expect(normalizedMd5Hex(VALID)).toBe(VALID.toLowerCase());
    expect(normalizedMd5Hex(`  ${VALID}  `)).toBe(VALID.toLowerCase());
  });

  it.each([
    ['sentinel zero', '0'],
    ['sentinel word', 'none'],
    ['31 chars', 'a'.repeat(31)],
    ['33 chars', 'a'.repeat(33)],
    ['non-hex chars', 'g'.repeat(32)],
    ['empty', ''],
    ['whitespace', '   '],
  ])('rejects %s', (_label, value) => {
    expect(normalizedMd5Hex(value)).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizedMd5Hex(null)).toBeNull();
    expect(normalizedMd5Hex(12345678901234567890123456789012)).toBeNull();
    expect(normalizedMd5Hex({})).toBeNull();
  });
});
