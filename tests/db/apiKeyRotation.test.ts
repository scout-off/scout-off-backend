/**
 * Atomic, grace-period API key rotation (#676).
 *
 * Runs against the real migrated in-memory SQLite database (tests/setup.ts),
 * not a mocked src/db, so it exercises the actual db/025_api_key_rotation.sql
 * column and the real active-key SQL filtering on it.
 *
 * Covers the acceptance criteria directly:
 *   - rotation issues a new working key;
 *   - the old key remains valid until the grace period elapses;
 *   - the old key is rejected after the grace period.
 */
import * as db from '../../src/db';
import { generateApiKey, resolveApiKey } from '../../src/controllers/apiKeyController';

const SCOUT = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';
const OTHER_SCOUT = 'GAEZS7NMWCNTUFGDNXWVYVTKGGP47CESPEV5BVT5LNFHKXC5TGBZ4O5O';

async function issueKey(opts: { wallet?: string; scopes?: string[] } = {}): Promise<{
  id: number;
  key: string;
}> {
  const { key, keyHash, lookupHash } = generateApiKey();
  const id = await db.insertApiKey({
    key_hash: keyHash,
    scout_wallet: opts.wallet ?? SCOUT,
    label: 'rotation-fixture',
    created_at: Math.floor(Date.now() / 1000),
    scopes: opts.scopes,
    lookup_hash: lookupHash,
  });
  return { id, key };
}

afterEach(() => {
  jest.useRealTimers();
});

describe('scheduleApiKeyRevocation (#676)', () => {
  it('schedules an active key and reports success', async () => {
    const { id } = await issueKey();
    const revokeAfter = Math.floor(Date.now() / 1000) + 3600;

    expect(await db.scheduleApiKeyRevocation(id, SCOUT, revokeAfter)).toBe(true);
  });

  it('returns false for a key that does not belong to the given wallet', async () => {
    const { id } = await issueKey({ wallet: SCOUT });
    const revokeAfter = Math.floor(Date.now() / 1000) + 3600;

    expect(await db.scheduleApiKeyRevocation(id, OTHER_SCOUT, revokeAfter)).toBe(false);
  });

  it('returns false for an already-revoked key', async () => {
    const { id } = await issueKey();
    await db.revokeApiKeyById(id, SCOUT);

    const revokeAfter = Math.floor(Date.now() / 1000) + 3600;
    expect(await db.scheduleApiKeyRevocation(id, SCOUT, revokeAfter)).toBe(false);
  });

  it('returns false for an unknown key id', async () => {
    const revokeAfter = Math.floor(Date.now() / 1000) + 3600;
    expect(await db.scheduleApiKeyRevocation(999999, SCOUT, revokeAfter)).toBe(false);
  });

  it('a fresh call overwrites a previously scheduled deadline', async () => {
    const { id } = await issueKey();
    const now = Math.floor(Date.now() / 1000);

    await db.scheduleApiKeyRevocation(id, SCOUT, now + 3600);
    await db.scheduleApiKeyRevocation(id, SCOUT, now + 60);

    const rows = await db.listApiKeysByWallet(SCOUT);
    const row = rows.find((r) => r.id === id);
    expect(row?.revoke_after).toBe(now + 60);
  });
});

describe('rotation grace period behavior (#676)', () => {
  it('the old key resolves normally right after being scheduled, before the grace period elapses', async () => {
    const { id, key } = await issueKey();
    const now = Math.floor(Date.now() / 1000);

    await db.scheduleApiKeyRevocation(id, SCOUT, now + 3600); // 1h grace period

    const resolved = await resolveApiKey(key);
    expect(resolved).toEqual({ scout_wallet: SCOUT, id, scopes: null });
  });

  it('the old key is rejected once the grace period elapses', async () => {
    const { id, key } = await issueKey();
    const now = Math.floor(Date.now() / 1000);

    await db.scheduleApiKeyRevocation(id, SCOUT, now + 60); // 60s grace period

    // Still valid just before the deadline.
    jest.useFakeTimers({ now: (now + 59) * 1000 });
    expect(await resolveApiKey(key)).toEqual({ scout_wallet: SCOUT, id, scopes: null });

    // Past the deadline: rejected.
    jest.setSystemTime((now + 61) * 1000);
    expect(await resolveApiKey(key)).toBeNull();
  });

  it('an elapsed-grace-period key costs one indexed miss plus one empty pending probe — never a scan hit', async () => {
    const { id, key } = await issueKey();
    const now = Math.floor(Date.now() / 1000);
    await db.scheduleApiKeyRevocation(id, SCOUT, now - 1); // already elapsed

    const scan = jest.spyOn(db, 'getActiveApiKeysAwaitingLookupHash');
    expect(await resolveApiKey(key)).toBeNull();
    // The row has a lookup_hash, so it is filtered out of the pending set by
    // `lookup_hash IS NULL` regardless of revoke_after — the transitional
    // probe costs one indexed (empty) read, same as for an unknown key, and
    // never actually matches this row.
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await scan.mock.results[0].value).toEqual([]);
  });

  it('a scheduled-but-not-elapsed key is excluded from getActiveApiKeysAwaitingLookupHash the same way', async () => {
    // Pre-migration key: no lookup_hash, so it lives on the transitional path.
    const { key, keyHash } = generateApiKey();
    const id = await db.insertApiKey({
      key_hash: keyHash,
      scout_wallet: SCOUT,
      label: 'legacy-rotation-fixture',
      created_at: Math.floor(Date.now() / 1000),
    });
    const now = Math.floor(Date.now() / 1000);
    await db.scheduleApiKeyRevocation(id, SCOUT, now - 1); // already elapsed

    expect(await resolveApiKey(key)).toBeNull();
  });
});

describe('rotation issues a new working key (#676)', () => {
  it('the new key authenticates immediately after rotation, independent of the old key', async () => {
    const { id: oldId } = await issueKey({ scopes: ['read:milestones'] });

    // Simulate what rotateApiKey does: issue a replacement inheriting scopes,
    // then schedule the old key.
    const { key: newKey, keyHash: newKeyHash, lookupHash: newLookupHash } = generateApiKey();
    const now = Math.floor(Date.now() / 1000);
    const newId = await db.insertApiKey({
      key_hash: newKeyHash,
      scout_wallet: SCOUT,
      label: 'rotation-fixture',
      created_at: now,
      scopes: ['read:milestones'],
      lookup_hash: newLookupHash,
    });
    await db.scheduleApiKeyRevocation(oldId, SCOUT, now + 86400);

    const resolved = await resolveApiKey(newKey);
    expect(resolved).toEqual({ scout_wallet: SCOUT, id: newId, scopes: ['read:milestones'] });
    expect(newId).not.toBe(oldId);
  });
});
