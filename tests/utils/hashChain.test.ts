import { canonicalJSON, computeChainHash, auditChainContent, GENESIS_HASH } from '../../src/utils/hashChain';

describe('canonicalJSON', () => {
  it('produces the same string regardless of key insertion order', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });

  it('sorts keys recursively inside arrays too', () => {
    const a = { list: [{ b: 1, a: 2 }, { d: 1, c: 2 }] };
    const b = { list: [{ a: 2, b: 1 }, { c: 2, d: 1 }] };
    expect(canonicalJSON(a)).toBe(canonicalJSON(b));
  });

  it('differs when content actually differs', () => {
    expect(canonicalJSON({ a: 1 })).not.toBe(canonicalJSON({ a: 2 }));
  });
});

describe('computeChainHash', () => {
  it('is deterministic for the same content and prevHash', () => {
    const content = { action: 'x', admin_wallet: 'G1' };
    expect(computeChainHash(content, GENESIS_HASH)).toBe(computeChainHash(content, GENESIS_HASH));
  });

  it('changes when prevHash changes (chaining)', () => {
    const content = { action: 'x', admin_wallet: 'G1' };
    const h1 = computeChainHash(content, GENESIS_HASH);
    const h2 = computeChainHash(content, 'a'.repeat(64));
    expect(h1).not.toBe(h2);
  });

  it('changes when content changes', () => {
    const h1 = computeChainHash({ action: 'x' }, GENESIS_HASH);
    const h2 = computeChainHash({ action: 'y' }, GENESIS_HASH);
    expect(h1).not.toBe(h2);
  });

  it('produces a 64-character hex digest', () => {
    const hash = computeChainHash({ action: 'x' }, GENESIS_HASH);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('auditChainContent', () => {
  it('maps camelCase fields onto the audit_log column names', () => {
    const content = auditChainContent({
      action: 'contract_state_change',
      adminWallet: 'GADMIN',
      queryParams: '{}',
      createdAt: '2025-01-01T00:00:00.000Z',
      eventSource: 'admin_action',
    });
    expect(content).toEqual({
      action: 'contract_state_change',
      admin_wallet: 'GADMIN',
      query_params: '{}',
      created_at: '2025-01-01T00:00:00.000Z',
      event_source: 'admin_action',
    });
  });
});

describe('computeChainHash edge cases', () => {
  it('hashes an empty content string without throwing', () => {
    const hash = computeChainHash('', GENESIS_HASH);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes an empty object without throwing', () => {
    const hash = computeChainHash({}, GENESIS_HASH);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a valid, distinct hash for Unicode content (emoji, non-ASCII)', () => {
    const content = { note: '⚽️ Jogador aprovado — 速報 — café 🇳🇬', action: 'milestone_approved' };
    const hash = computeChainHash(content, GENESIS_HASH);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(computeChainHash({ ...content, note: 'plain ascii' }, GENESIS_HASH));
  });

  it('is deterministic for Unicode content across repeated calls', () => {
    const content = { note: '⚽️ 速報 café' };
    expect(computeChainHash(content, GENESIS_HASH)).toBe(computeChainHash(content, GENESIS_HASH));
  });

  it('hashes very long content (>10,000 chars) without throwing', () => {
    const longString = 'a'.repeat(10_001);
    const content = { payload: longString };
    const hash = computeChainHash(content, GENESIS_HASH);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a different hash when long content differs by a single character', () => {
    const base = 'a'.repeat(10_000);
    const h1 = computeChainHash({ payload: base + 'a' }, GENESIS_HASH);
    const h2 = computeChainHash({ payload: base + 'b' }, GENESIS_HASH);
    expect(h1).not.toBe(h2);
  });

  it('uses GENESIS_HASH as the prevHash for the first entry in a chain', () => {
    const first = computeChainHash({ action: 'genesis-entry' }, GENESIS_HASH);
    // Sanity: GENESIS_HASH is a fixed 64-char sentinel distinct from any real digest input
    expect(GENESIS_HASH).toBe('0'.repeat(64));
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it('chains hashes: each entry\'s output becomes the next entry\'s prevHash input', () => {
    const entry1Content = { action: 'entry-1' };
    const entry2Content = { action: 'entry-2' };
    const entry3Content = { action: 'entry-3' };

    const hash1 = computeChainHash(entry1Content, GENESIS_HASH);
    const hash2 = computeChainHash(entry2Content, hash1);
    const hash3 = computeChainHash(entry3Content, hash2);

    // Every hash in the chain is well-formed and unique.
    const chain = [hash1, hash2, hash3];
    expect(new Set(chain).size).toBe(3);
    chain.forEach((h) => expect(h).toMatch(/^[0-9a-f]{64}$/));

    // Re-deriving hash2 requires exactly hash1 as prevHash — any other prevHash breaks the chain.
    expect(computeChainHash(entry2Content, hash1)).toBe(hash2);
    expect(computeChainHash(entry2Content, GENESIS_HASH)).not.toBe(hash2);
  });

  it('is fully deterministic: identical (content, prevHash) pairs always produce the same output', () => {
    const content = { action: 'contract_state_change', admin_wallet: 'GADMIN', nested: { a: 1, b: [1, 2, 3] } };
    const prevHash = 'f'.repeat(64);
    const results = Array.from({ length: 5 }, () => computeChainHash(content, prevHash));
    expect(new Set(results).size).toBe(1);
  });
});
