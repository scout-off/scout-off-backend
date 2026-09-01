jest.mock('../../src/services/ipfs', () => ({
  gatewayUrl: (cid: string) => `https://gateway.pinata.cloud/ipfs/${cid}`,
  gatewayUrls: (cid: string) => [`https://gateway.pinata.cloud/ipfs/${cid}`],
}));

import { serializeIpfsResult, IpfsSerializedResult } from '../../src/utils/ipfsSerializer';

const TEST_CID = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

describe('serializeIpfsResult', () => {
  it('returns stable shape with cid, uri, metadata, and storageProvider', () => {
    const result = serializeIpfsResult(TEST_CID);
    expect(result).toMatchObject<IpfsSerializedResult>({
      cid: TEST_CID,
      uri: `https://gateway.pinata.cloud/ipfs/${TEST_CID}`,
      metadata: {},
      storageProvider: 'pinata',
    });
  });

  it('includes custom metadata when provided', () => {
    const meta = { wallet: 'GSCOUT1', position: 'forward' };
    const result = serializeIpfsResult(TEST_CID, meta);
    expect(result.metadata).toEqual(meta);
  });

  it('uses a custom storageProvider when specified', () => {
    const result = serializeIpfsResult(TEST_CID, {}, 'arweave');
    expect(result.storageProvider).toBe('arweave');
  });

  it('uri is built from the provided cid', () => {
    const result = serializeIpfsResult(TEST_CID);
    expect(result.uri).toContain(TEST_CID);
  });

  // ── New cases for nested object, array, null, undefined, and empty object ──

  it('flat object: serialises a simple key/value metadata object correctly', () => {
    const meta = { name: 'Carlos', age: 21 };
    const result = serializeIpfsResult(TEST_CID, meta);
    expect(result.metadata).toEqual({ name: 'Carlos', age: 21 });
    expect(result.cid).toBe(TEST_CID);
    expect(result.storageProvider).toBe('pinata');
  });

  it('nested object: preserves deeply nested metadata fields without flattening', () => {
    const meta = { name: 'Carlos', stats: { goals: 5, assists: 3 } };
    const result = serializeIpfsResult(TEST_CID, meta);
    expect(result.metadata).toEqual({ name: 'Carlos', stats: { goals: 5, assists: 3 } });
    expect((result.metadata.stats as Record<string, number>).goals).toBe(5);
    expect((result.metadata.stats as Record<string, number>).assists).toBe(3);
  });

  it('array value: preserves array fields in metadata without modification', () => {
    const meta = { highlights: ['cid1', 'cid2'] };
    const result = serializeIpfsResult(TEST_CID, meta);
    expect(result.metadata).toEqual({ highlights: ['cid1', 'cid2'] });
    expect(Array.isArray(result.metadata.highlights)).toBe(true);
    expect(result.metadata.highlights).toHaveLength(2);
  });

  it('null field: includes null values as-is in the serialised output', () => {
    const meta: Record<string, unknown> = { nickname: null };
    const result = serializeIpfsResult(TEST_CID, meta);
    expect(result.metadata).toHaveProperty('nickname');
    expect(result.metadata.nickname).toBeNull();
  });

  it('undefined field: omits undefined values from the serialised metadata (JS object semantics)', () => {
    // In JavaScript, properties set to `undefined` are present on the object
    // but are omitted when serialised via JSON.stringify. The serialiser passes
    // the metadata object through as-is; callers should not rely on undefined
    // fields surviving a round-trip through JSON serialisation.
    const meta: Record<string, unknown> = { nickname: undefined };
    const result = serializeIpfsResult(TEST_CID, meta);
    // The key exists in the raw JS object but its value is undefined.
    expect(result.metadata).toHaveProperty('nickname');
    expect(result.metadata.nickname).toBeUndefined();
    // Verify JSON round-trip omits the undefined key (documented behaviour).
    const roundTripped = JSON.parse(JSON.stringify(result.metadata)) as Record<string, unknown>;
    expect(roundTripped).not.toHaveProperty('nickname');
  });

  it('empty object: serialises an empty metadata object to an empty object', () => {
    const result = serializeIpfsResult(TEST_CID, {});
    expect(result.metadata).toEqual({});
    expect(Object.keys(result.metadata)).toHaveLength(0);
  });
});
