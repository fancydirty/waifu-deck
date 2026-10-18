import {
  detectS3ApiKeyProvider,
  extractB2Region,
  isB2MasterKeyId,
  parseBackblazePair,
  provisionS3FromApiKey,
  sha256HexString,
} from './s3-api-key-provisioner';
import type { S3FetchPort } from './s3-transport';

function jsonResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => text,
    json: async () => JSON.parse(text),
  } as unknown as Response;
}

describe('s3-api-key-provisioner', () => {
  it('detectS3ApiKeyProvider recognizes Bunny, Backblaze B2, and Cloudflare R2 key shapes', () => {
    expect(detectS3ApiKeyProvider('a9f41e82-7c3b-4d91-9e12-6b81d04f1122')).toBe('bunny');
    expect(
      detectS3ApiKeyProvider(
        'e8c0999f-ff9f-999f-9ff9-99fff99999f999999999-f9f9-9fff-9f9f-ff9f9fff99ff',
      ),
    ).toBe('bunny');
    expect(
      detectS3ApiKeyProvider('0a1b2c3d4e5f:0047fFake0B2KeyFake0B2KeyFake0B2KeyFake0'),
    ).toBe('b2');
    expect(
      detectS3ApiKeyProvider('0040a1b2c3d4e5f0000000001\nK004abcDEF123456789012345678901'),
    ).toBe('b2');
    expect(
      detectS3ApiKeyProvider('0040a1b2c3d4e5f0000000001 K004abcDEF123456789012345678901'),
    ).toBe('b2');
    expect(
      detectS3ApiKeyProvider('cfut_aafaafFFaaaaa9aaaFaa9Faaa9F9a9a9FaaFF9a999999f9f'),
    ).toBe('r2');
    expect(
      detectS3ApiKeyProvider('cfat_FakeTokenForTestsFakeTokenForTestsFa12345678'),
    ).toBe('r2');
    expect(detectS3ApiKeyProvider('Bearer FakeTokenForTestsFakeTokenForTestsFakeTo')).toBe('r2');
    expect(detectS3ApiKeyProvider('   ')).toBeNull();
    expect(detectS3ApiKeyProvider('not-a-valid-key')).toBeNull();
  });

  it('helper utilities parse Backblaze pairs, detect Master Key IDs, and extract B2 regions', () => {
    expect(parseBackblazePair('0a1b2c3d4e5f:0047fFake0B2KeyFake0B2KeyFake0B2KeyFake0')).toEqual([
      '0a1b2c3d4e5f',
      '0047fFake0B2KeyFake0B2KeyFake0B2KeyFake0',
    ]);
    expect(isB2MasterKeyId('0a1b2c3d4e5f')).toBe(true);
    expect(isB2MasterKeyId('0040a1b2c3d4e5f0000000099')).toBe(false);
    expect(extractB2Region('https://s3.eu-central-003.backblazeb2.com')).toBe('eu-central-003');
    expect(extractB2Region('invalid-url')).toBe('us-west-004');
  });

  it('Bunny provision reuses existing waifu-deck zone and builds regional S3 fields', async () => {
    const fetchImpl: S3FetchPort = async (url, init) => {
      expect(url).toBe('https://api.bunny.net/storagezone');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>).AccessKey).toBe(
        'a9f41e82-7c3b-4d91-9e12-6b81d04f1122',
      );
      return jsonResponse(200, [
        { Name: 'other-zone', Region: 'DE', Password: 'pw-1', Deleted: false },
        { Name: 'waifu-deck', Region: 'SG', Password: 'zone-rw-password-99', Deleted: false },
      ]);
    };

    const res = await provisionS3FromApiKey(
      'a9f41e82-7c3b-4d91-9e12-6b81d04f1122',
      null,
      { fetchImpl },
    );
    expect(res).toEqual({
      ok: true,
      provider: 'bunny',
      createdNewBucket: false,
      fields: {
        endpoint: 'https://sg-s3.storage.bunnycdn.com',
        region: 'sg',
        accessKey: 'waifu-deck',
        secret: 'zone-rw-password-99',
        bucket: 'waifu-deck',
      },
    });
  });

  it('Bunny provision creates suffixed zone when base waifu-deck name is globally taken', async () => {
    const key = 'a9f41e82-7c3b-4d91-9e12-6b81d04f1122';
    const expectedSuffix = sha256HexString(`waifu-deck-bunny-zone:${key}`).slice(0, 6);
    const calls: { method: string; body: string }[] = [];
    const fetchImpl: S3FetchPort = async (url, init) => {
      const method = init?.method ?? 'GET';
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      calls.push({ method, body: bodyStr });
      if (method === 'GET' && url === 'https://api.bunny.net/storagezone') {
        return jsonResponse(200, []);
      }
      if (method === 'POST' && bodyStr.includes('"waifu-deck"')) {
        return jsonResponse(400, { Message: 'Storage Zone name is already taken' });
      }
      if (method === 'POST' && bodyStr.includes(`"waifu-deck-${expectedSuffix}"`)) {
        expect(bodyStr).toContain('"StorageZoneType":1');
        return jsonResponse(201, {
          Name: `waifu-deck-${expectedSuffix}`,
          Region: 'SG',
          Password: 'created-zone-secret',
          StorageZoneType: 1,
        });
      }
      return jsonResponse(500, {});
    };

    const res = await provisionS3FromApiKey(key, null, { fetchImpl });
    expect(res).toEqual({
      ok: true,
      provider: 'bunny',
      createdNewBucket: true,
      fields: {
        endpoint: 'https://sg-s3.storage.bunnycdn.com',
        region: 'sg',
        accessKey: `waifu-deck-${expectedSuffix}`,
        secret: 'created-zone-secret',
        bucket: `waifu-deck-${expectedSuffix}`,
      },
    });
    expect(calls).toHaveLength(3);
  });

  it('Backblaze B2 Master Key mints S3-compatible Application Key before creating bucket', async () => {
    const callOrder: string[] = [];
    const fetchImpl: S3FetchPort = async (url, init) => {
      const method = init?.method ?? 'GET';
      const bodyStr = typeof init?.body === 'string' ? init.body : '';
      if (method === 'GET' && String(url).endsWith('b2_authorize_account')) {
        callOrder.push('authorize');
        return jsonResponse(200, {
          accountId: '0a1b2c3d4e5f',
          authorizationToken: 'b2-auth-tok',
          apiInfo: {
            storageApi: {
              apiUrl: 'https://api004.backblazeb2.com',
              s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
            },
          },
        });
      }
      if (method === 'POST' && String(url).endsWith('b2_create_key')) {
        callOrder.push('create_key');
        return jsonResponse(200, {
          applicationKeyId: '0040a1b2c3d4e5f0000000099',
          applicationKey: 'K004mintedSecretKey99999999999',
        });
      }
      if (method === 'POST' && String(url).endsWith('b2_list_buckets')) {
        callOrder.push('list_buckets');
        return jsonResponse(200, { buckets: [] });
      }
      if (method === 'POST' && String(url).endsWith('b2_create_bucket')) {
        callOrder.push('create_bucket');
        expect(bodyStr).toContain('"allPrivate"');
        return jsonResponse(200, { bucketName: 'waifu-deck-d7b75a' });
      }
      return jsonResponse(500, {});
    };

    const res = await provisionS3FromApiKey(
      '0a1b2c3d4e5f:0047fFake0B2KeyFake0B2KeyFake0B2KeyFake0',
      null,
      { fetchImpl },
    );
    expect(res).toEqual({
      ok: true,
      provider: 'b2',
      createdNewBucket: true,
      fields: {
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        accessKey: '0040a1b2c3d4e5f0000000099',
        secret: 'K004mintedSecretKey99999999999',
        bucket: 'waifu-deck-d7b75a',
      },
    });
    expect(callOrder).toEqual(['authorize', 'create_key', 'list_buckets', 'create_bucket']);
  });

  it('Backblaze B2 non-master Application Key reuses existing bucket without minting or creating', async () => {
    const calls: string[] = [];
    const fetchImpl: S3FetchPort = async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${String(url)}`);
      if (method === 'GET' && String(url).endsWith('b2_authorize_account')) {
        return jsonResponse(200, {
          accountId: '0a1b2c3d4e5f',
          authorizationToken: 'b2-auth-tok',
          apiInfo: {
            storageApi: {
              apiUrl: 'https://api004.backblazeb2.com',
              s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
            },
          },
        });
      }
      if (method === 'POST' && String(url).endsWith('b2_list_buckets')) {
        return jsonResponse(200, {
          buckets: [{ bucketName: 'waifu-deck-d7b75a' }],
        });
      }
      return jsonResponse(500, {});
    };

    const res = await provisionS3FromApiKey(
      '0040a1b2c3d4e5f0000000001:K004abcDEF123456789012345678901',
      null,
      { fetchImpl },
    );
    expect(res).toEqual({
      ok: true,
      provider: 'b2',
      createdNewBucket: false,
      fields: {
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        accessKey: '0040a1b2c3d4e5f0000000001',
        secret: 'K004abcDEF123456789012345678901',
        bucket: 'waifu-deck-d7b75a',
      },
    });
    expect(calls).toEqual([
      'GET https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
      'POST https://api004.backblazeb2.com/b2api/v3/b2_list_buckets',
    ]);
  });

  it('Backblaze B2 bucket-restricted Application Key uses allowed.bucketName directly without listing buckets', async () => {
    const calls: string[] = [];
    const fetchImpl: S3FetchPort = async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return jsonResponse(200, {
        accountId: '0a1b2c3d4e5f',
        authorizationToken: 'b2-auth-tok',
        apiInfo: {
          storageApi: {
            apiUrl: 'https://api004.backblazeb2.com',
            s3ApiUrl: 'https://s3.us-west-004.backblazeb2.com',
            allowed: {
              bucketId: 'b123',
              bucketName: 'waifu-deck-scoped',
            },
          },
        },
      });
    };

    const res = await provisionS3FromApiKey(
      '0040a1b2c3d4e5f0000000001:K004abcDEF123456789012345678901',
      null,
      { fetchImpl },
    );
    expect(res).toEqual({
      ok: true,
      provider: 'b2',
      createdNewBucket: false,
      fields: {
        endpoint: 'https://s3.us-west-004.backblazeb2.com',
        region: 'us-west-004',
        accessKey: '0040a1b2c3d4e5f0000000001',
        secret: 'K004abcDEF123456789012345678901',
        bucket: 'waifu-deck-scoped',
      },
    });
    expect(calls).toHaveLength(1);
  });

  it('Cloudflare R2 token finds existing waifu-deck and derives S3 credentials from tokenId + sha256(token)', async () => {
    const rawToken = 'cfut_aafaafFFaaaaa9aaaFaa9Faaa9F9a9a9FaaFF9a999999f9f';
    const fetchImpl: S3FetchPort = async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url === 'https://api.cloudflare.com/client/v4/accounts') {
        return jsonResponse(200, { result: [{ id: 'acc123' }] });
      }
      if (
        method === 'GET' &&
        url === 'https://api.cloudflare.com/client/v4/accounts/acc123/r2/buckets'
      ) {
        return jsonResponse(200, { result: { buckets: [{ name: 'waifu-deck' }] } });
      }
      if (
        method === 'GET' &&
        url === 'https://api.cloudflare.com/client/v4/accounts/acc123/tokens/verify'
      ) {
        return jsonResponse(200, { result: { id: 'tokid999', status: 'active' } });
      }
      return jsonResponse(500, {});
    };

    const res = await provisionS3FromApiKey(rawToken, null, { fetchImpl });
    expect(res).toEqual({
      ok: true,
      provider: 'r2',
      createdNewBucket: false,
      fields: {
        endpoint: 'https://acc123.r2.cloudflarestorage.com',
        region: 'auto',
        accessKey: 'tokid999',
        secret: sha256HexString(rawToken),
        bucket: 'waifu-deck',
      },
    });
  });

  it('Cloudflare R2 selects account with waifu-deck or creates bucket on first account and falls back to /user/tokens/verify', async () => {
    const rawToken = 'cfat_FakeTokenForTestsFakeTokenForTestsFa12345678';
    const fetchImpl: S3FetchPort = async (url, init) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url === 'https://api.cloudflare.com/client/v4/accounts') {
        return jsonResponse(200, { result: [{ id: 'acc-1' }, { id: 'acc-2' }] });
      }
      if (
        method === 'GET' &&
        url === 'https://api.cloudflare.com/client/v4/accounts/acc-1/r2/buckets'
      ) {
        return jsonResponse(200, { result: { buckets: [{ name: 'other-bucket' }] } });
      }
      if (
        method === 'GET' &&
        url === 'https://api.cloudflare.com/client/v4/accounts/acc-2/r2/buckets'
      ) {
        return jsonResponse(200, { result: { buckets: [] } });
      }
      if (
        method === 'POST' &&
        url === 'https://api.cloudflare.com/client/v4/accounts/acc-1/r2/buckets'
      ) {
        return jsonResponse(200, { result: { name: 'waifu-deck' } });
      }
      if (
        method === 'GET' &&
        url === 'https://api.cloudflare.com/client/v4/accounts/acc-1/tokens/verify'
      ) {
        return jsonResponse(404, { errors: [{ message: 'Not found' }] });
      }
      if (method === 'GET' && url === 'https://api.cloudflare.com/client/v4/user/tokens/verify') {
        return jsonResponse(200, { result: { id: 'user-tok-777', status: 'active' } });
      }
      return jsonResponse(500, {});
    };

    const res = await provisionS3FromApiKey(rawToken, null, { fetchImpl });
    expect(res).toEqual({
      ok: true,
      provider: 'r2',
      createdNewBucket: true,
      fields: {
        endpoint: 'https://acc-1.r2.cloudflarestorage.com',
        region: 'auto',
        accessKey: 'user-tok-777',
        secret: sha256HexString(rawToken),
        bucket: 'waifu-deck',
      },
    });
  });

  it('selectedProviderOverride takes precedence over shape auto-detection so a 40-char key is not sent to Cloudflare when Bunny is selected', async () => {
    const calledUrls: string[] = [];
    const fetchImpl: S3FetchPort = async (url) => {
      calledUrls.push(String(url));
      return jsonResponse(401, {});
    };
    const fortyCharKey = '1234567890123456789012345678901234567890';
    const res = await provisionS3FromApiKey(fortyCharKey, 'bunny', { fetchImpl });
    expect(res).toEqual({ ok: false, errorCode: 'invalid_bunny_key' });
    expect(calledUrls).toEqual(['https://api.bunny.net/storagezone']);
  });

  it('returns structured error codes for blank, unrecognized, or rejected keys', async () => {
    expect(await provisionS3FromApiKey('   ')).toEqual({
      ok: false,
      errorCode: 'key_required',
    });
    expect(await provisionS3FromApiKey('unknown-format')).toEqual({
      ok: false,
      errorCode: 'unrecognized_key',
    });

    const fetch401: S3FetchPort = async () => jsonResponse(401, {});
    expect(
      await provisionS3FromApiKey('a9f41e82-7c3b-4d91-9e12-6b81d04f1122', null, {
        fetchImpl: fetch401,
      }),
    ).toEqual({
      ok: false,
      errorCode: 'invalid_bunny_key',
    });

    const fetchR2Disabled: S3FetchPort = async () =>
      jsonResponse(403, { errors: [{ code: 10042, message: 'R2 is not enabled' }] });
    expect(
      await provisionS3FromApiKey(
        'cfut_aafaafFFaaaaa9aaaFaa9Faaa9F9a9a9FaaFF9a999999f9f',
        null,
        { fetchImpl: fetchR2Disabled },
      ),
    ).toEqual({
      ok: false,
      errorCode: 'r2_not_enabled',
    });
  });
});
