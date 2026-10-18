import {
  AssetStateCorruptionError,
  decodeAssetState,
  encodeAssetState,
  REQUIRED_FIELDS,
  type LibraryAssetStateRecord,
} from './library-asset-state-codec';

const enc = new TextEncoder();

function narrowState() {
  return {
    assetId: 'a1',
    revision: 3,
    generation: 1,
    lifecycle: 'active' as const,
    protection: 'unprotected' as const,
  };
}

function fullRecord(): LibraryAssetStateRecord {
  return {
    ...narrowState(),
    lastMutationId: 'm-ulid-1',
    trashedAt: null,
    generations: {
      thumbnail: 'gen-thumb',
      preview: 'gen-preview',
      original: 'gen-orig',
    },
  };
}

function defaultedRecord(): LibraryAssetStateRecord {
  return {
    ...narrowState(),
    lastMutationId: null,
    trashedAt: null,
    generations: {},
  };
}

const SEALED_META = 'V0RMSUIwMDE.dGVzdC1zZWFsZWQtbWV0YWRhdGEtZW52ZWxvcGU';

describe('library-asset-state-codec', () => {
  it('round-trips a full record (generations/lastMutationId/trashedAt) losslessly', () => {
    const record = fullRecord();
    expect(decodeAssetState(encodeAssetState(record))).toEqual(record);
  });

  it('round-trips a record with meta (opaque base64url sealed envelope string)', () => {
    const record = { ...fullRecord(), meta: SEALED_META };
    const decoded = decodeAssetState(encodeAssetState(record));
    expect(decoded).toEqual(record);
    expect(decoded.meta).toBe(SEALED_META);
  });

  it('tolerates the absence of meta (round-trips to undefined, not an error)', () => {
    const record = fullRecord();
    expect(record.meta).toBeUndefined();
    const decoded = decodeAssetState(encodeAssetState(record));
    expect(decoded.meta).toBeUndefined();
    expect(decoded).toEqual(record);
  });

  it('decodes a legacy body with no meta key at all (pre-Task-1 writer)', () => {
    const body = enc.encode(JSON.stringify(fullRecord()));
    const decoded = decodeAssetState(body);
    expect(decoded.meta).toBeUndefined();
  });

  it('rejects a wrong-typed meta field (not a string)', () => {
    const state = { ...fullRecord(), meta: 42 };
    expect(() => decodeAssetState(enc.encode(JSON.stringify(state)))).toThrow(
      AssetStateCorruptionError,
    );
  });

  it('accepts an explicit meta present alongside all other carried fields', () => {
    const state = { ...fullRecord(), meta: SEALED_META };
    const decoded = decodeAssetState(enc.encode(JSON.stringify(state)));
    expect(decoded).toEqual(state);
  });

  it('round-trips a non-null trashedAt', () => {
    const record = { ...fullRecord(), trashedAt: '2026-08-01T00:00:00.000Z' };
    expect(decodeAssetState(encodeAssetState(record))).toEqual(record);
  });

  it('decodes a legacy 5-field body with defaults for the carried fields', () => {
    const legacyBody = enc.encode(JSON.stringify(narrowState()));
    expect(decodeAssetState(legacyBody)).toEqual(defaultedRecord());
  });

  it('accepts explicit null for lastMutationId and trashedAt', () => {
    const body = {
      ...narrowState(),
      lastMutationId: null,
      trashedAt: null,
    };
    expect(decodeAssetState(enc.encode(JSON.stringify(body)))).toEqual(
      defaultedRecord(),
    );
  });

  it('rejects a body that is not valid JSON', () => {
    expect(() => decodeAssetState(enc.encode('not json{'))).toThrow(
      AssetStateCorruptionError,
    );
  });

  it('rejects a body that parses to a non-object (array)', () => {
    expect(() => decodeAssetState(enc.encode('[1,2,3]'))).toThrow(
      AssetStateCorruptionError,
    );
  });

  it('rejects a body that parses to a non-object (primitive)', () => {
    expect(() => decodeAssetState(enc.encode('"just a string"'))).toThrow(
      AssetStateCorruptionError,
    );
  });

  it.each(REQUIRED_FIELDS)('rejects a body missing required field "%s"', (field) => {
    const state = narrowState() as Record<string, unknown>;
    delete state[field];
    expect(() => decodeAssetState(enc.encode(JSON.stringify(state)))).toThrow(
      AssetStateCorruptionError,
    );
  });

  it('rejects a body with a wrong-typed required field', () => {
    const state = { ...narrowState(), revision: 'not-a-number' };
    expect(() => decodeAssetState(enc.encode(JSON.stringify(state)))).toThrow(
      AssetStateCorruptionError,
    );
  });

  it.each(['lastMutationId', 'trashedAt'] as const)(
    'rejects a wrong-typed carried field "%s" (not string or null)',
    (field) => {
      const state = { ...narrowState(), [field]: 42 };
      expect(() => decodeAssetState(enc.encode(JSON.stringify(state)))).toThrow(
        AssetStateCorruptionError,
      );
    },
  );

  it('rejects a non-object "generations" field', () => {
    const state = { ...narrowState(), generations: 'nope' };
    expect(() => decodeAssetState(enc.encode(JSON.stringify(state)))).toThrow(
      AssetStateCorruptionError,
    );
  });

  it('rejects an array "generations" field', () => {
    const state = { ...narrowState(), generations: [] };
    expect(() => decodeAssetState(enc.encode(JSON.stringify(state)))).toThrow(
      AssetStateCorruptionError,
    );
  });

  it('rejects a "generations" field with a wrong-typed role value', () => {
    const state = { ...narrowState(), generations: { thumbnail: 42 } };
    expect(() => decodeAssetState(enc.encode(JSON.stringify(state)))).toThrow(
      AssetStateCorruptionError,
    );
  });

  it('ignores unknown roles inside "generations"', () => {
    const state = {
      ...narrowState(),
      generations: { thumbnail: 'gen-thumb', mystery: 'gen-mystery' },
    };
    const decoded = decodeAssetState(enc.encode(JSON.stringify(state)));
    expect(decoded.generations).toEqual({ thumbnail: 'gen-thumb' });
  });

  it('ignores extra top-level fields beyond the persisted record shape', () => {
    const state = {
      ...fullRecord(),
      protocolVersion: 1,
      extraJunk: 'x',
    };
    expect(decodeAssetState(enc.encode(JSON.stringify(state)))).toEqual(
      fullRecord(),
    );
  });

  it('carries the original error as cause on invalid JSON', () => {
    try {
      decodeAssetState(enc.encode('{bad'));
      throw new Error('expected decodeAssetState to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AssetStateCorruptionError);
      expect((error as AssetStateCorruptionError).cause).toBeInstanceOf(Error);
    }
  });
});
