/**
 * API-key resolution must not scale with the number of issued keys (#1033).
 *
 * Unlike tests/routes/apiKeys.test.ts, this suite deliberately does NOT mock
 * src/db — it runs against the real migrated in-memory SQLite database created
 * by tests/setup.ts, so it exercises the actual SQL, the actual index, and the
 * actual lazy-backfill path.
 *
 * The property under test is not "resolution is fast" (which would be a flaky
 * wall-clock assertion) but the structural cause of the old bottleneck:
 *
 *   - exactly ONE targeted, indexed query is issued per resolution;
 *   - the number of stored keys does not change that;
 *   - no code path fetches or re-hashes every active key.
 */
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/db/migrate';
import { SqliteDriver } from '../../src/db/sqlite-driver';
import * as db from '../../src/db';
import {
  generateApiKey,
  resolveApiKey,
  verifyApiKey,
} from '../../src/controllers/apiKeyController';
import { deriveApiKeyLookupHash } from '../../src/utils/apiKeyLookup';

const SCOUT = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';

/** Issue a key straight into the real database, exactly as the controller does. */
async function issueKey(opts: { scopes?: string[]; wallet?: string } = {}): Promise<{
  id: number;
  key: string;
  lookupHash: string;
}> {
  const { key, keyHash, lookupHash } = generateApiKey();
  const id = await db.insertApiKey({
    key_hash: keyHash,
    scout_wallet: opts.wallet ?? SCOUT,
    label: 'scale-fixture',
    created_at: Math.floor(Date.now() / 1000),
    scopes: opts.scopes,
    lookup_hash: lookupHash,
  });
  return { id, key, lookupHash };
}

/** Read one row's stored lookup_hash directly, without listing the whole table. */
function storedLookupHash(id: number): string | null {
  const row = db
    .getDb()
    .prepare('SELECT lookup_hash FROM api_keys WHERE id = ?')
    .get(id) as { lookup_hash: string | null } | undefined;
  return row?.lookup_hash ?? null;
}

/** Count rows in api_keys without materialising them. */
function apiKeyCount(): number {
  return (db.getDb().prepare('SELECT COUNT(*) AS n FROM api_keys').get() as { n: number }).n;
}

afterEach(() => {
  jest.restoreAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────────
// 1. Schema: the column and its indexes actually exist after migration
// ───────────────────────────────────────────────────────────────────────────────

describe('db/024_api_key_lookup_hash.sql', () => {
  let migrated: Database.Database;

  beforeAll(async () => {
    migrated = new Database(':memory:');
    await runMigrations(new SqliteDriver(migrated));
  });

  afterAll(() => migrated.close());

  it('adds a lookup_hash column to api_keys', () => {
    const cols = (migrated.pragma('table_info(api_keys)') as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('lookup_hash');
    // The salted verification hash must survive untouched.
    expect(cols).toContain('key_hash');
  });

  it('creates the unique lookup index and the partial pending index', () => {
    const indexes = (
      migrated
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'api_keys'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).toContain('idx_api_keys_lookup_hash');
    expect(indexes).toContain('idx_api_keys_lookup_pending');
  });

  it('the lookup index is UNIQUE — one row per raw key', () => {
    const unique = (migrated.pragma('index_list(api_keys)') as { name: string; unique: number }[])
      .find((i) => i.name === 'idx_api_keys_lookup_hash');
    expect(unique?.unique).toBe(1);
  });

  it('permits multiple NULL lookup_hash rows (pre-migration keys do not collide)', () => {
    expect(() => {
      migrated
        .prepare(`INSERT INTO api_keys (key_hash, scout_wallet, label, created_at) VALUES (?, ?, '', 0)`)
        .run('salt-a:hash-a', SCOUT);
      migrated
        .prepare(`INSERT INTO api_keys (key_hash, scout_wallet, label, created_at) VALUES (?, ?, '', 0)`)
        .run('salt-b:hash-b', SCOUT);
    }).not.toThrow();
  });

  it('the resolver query uses the lookup index rather than scanning api_keys', () => {
    // Phase 12: confirm the planner can actually use the new index. Asserting
    // on "an index named idx_api_keys_lookup_hash is used" rather than on exact
    // EXPLAIN text keeps this robust across SQLite versions.
    const plan = migrated
      .prepare(
        'EXPLAIN QUERY PLAN SELECT * FROM api_keys WHERE lookup_hash = ? AND revoked_at IS NULL LIMIT 1',
      )
      .all('v1:whatever') as { detail: string }[];
    const detail = plan.map((p) => p.detail).join(' ');
    expect(detail).toContain('idx_api_keys_lookup_hash');
    expect(detail).not.toMatch(/SCAN api_keys(?! USING)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 2. Lookup behaviour — one indexed query, no scan
// ───────────────────────────────────────────────────────────────────────────────

describe('resolveApiKey uses an indexed lookup (#1033)', () => {
  it('issues exactly one targeted lookup and never fetches the active key set', async () => {
    const { id, key, lookupHash } = await issueKey();

    const byLookup = jest.spyOn(db, 'getActiveApiKeyByLookupHash');
    const scan = jest.spyOn(db, 'getActiveApiKeysAwaitingLookupHash');

    expect(await resolveApiKey(key)).toEqual({ scout_wallet: SCOUT, id, scopes: null });

    expect(byLookup).toHaveBeenCalledTimes(1);
    expect(byLookup).toHaveBeenCalledWith(lookupHash);
    expect(scan).not.toHaveBeenCalled();
  });

  it('an unknown key costs one indexed lookup plus one (empty) pending probe — not a table scan', async () => {
    await issueKey();

    const byLookup = jest.spyOn(db, 'getActiveApiKeyByLookupHash');
    const scan = jest.spyOn(db, 'getActiveApiKeysAwaitingLookupHash');

    expect(await resolveApiKey('a'.repeat(64))).toBeNull();

    expect(byLookup).toHaveBeenCalledTimes(1);
    // The pending probe is index-backed and, with every key migrated, empty.
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await scan.mock.results[0].value).toEqual([]);
  });

  it('rejects a revoked key without falling back to a scan', async () => {
    const { id, key } = await issueKey();
    expect(await db.revokeApiKeyById(id, SCOUT)).toBe(true);

    const scan = jest.spyOn(db, 'getActiveApiKeysAwaitingLookupHash');

    expect(await resolveApiKey(key)).toBeNull();
    // A revoked row still holds its lookup_hash, so it is excluded by the
    // query's `revoked_at IS NULL`, not by anything application-side.
    for (const r of scan.mock.results) {
      expect(await r.value).toEqual([]);
    }
  });

  it('preserves scope resolution for a restricted key', async () => {
    const scopes = ['read:milestones', 'write:contacts'];
    const { id, key } = await issueKey({ scopes });
    expect(await resolveApiKey(key)).toEqual({ scout_wallet: SCOUT, id, scopes });
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 3. Scale — the whole point of the issue
// ───────────────────────────────────────────────────────────────────────────────

describe('resolution cost does not grow with the number of stored keys (#1033)', () => {
  const KEY_COUNT = 2_000;

  it(`resolves one key out of ${KEY_COUNT} with a single candidate lookup`, async () => {
    // Seed a large active key set — the exact condition that made the old
    // implementation pay for a full table read plus n SHA-256 computations.
    let target: { id: number; key: string; lookupHash: string } | null = null;
    for (let i = 0; i < KEY_COUNT; i++) {
      const issued = await issueKey();
      // Pick a key from the middle so neither insertion order nor row id
      // could make this accidentally cheap.
      if (i === Math.floor(KEY_COUNT / 2)) target = issued;
    }
    expect(target).not.toBeNull();

    expect(apiKeyCount()).toBeGreaterThanOrEqual(KEY_COUNT);

    const byLookup = jest.spyOn(db, 'getActiveApiKeyByLookupHash');
    const scan = jest.spyOn(db, 'getActiveApiKeysAwaitingLookupHash');

    const resolved = await resolveApiKey(target!.key);

    expect(resolved).toEqual({ scout_wallet: SCOUT, id: target!.id, scopes: null });
    // ONE candidate row considered, regardless of KEY_COUNT.
    expect(byLookup).toHaveBeenCalledTimes(1);
    expect(scan).not.toHaveBeenCalled();
  });

  it('derives the same lookup value every time — so it can be indexed at all', () => {
    const { key } = generateApiKey();
    expect(deriveApiKeyLookupHash(key)).toBe(deriveApiKeyLookupHash(key));
    expect(deriveApiKeyLookupHash(key)).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it('derives different lookup values for different keys', () => {
    expect(deriveApiKeyLookupHash(generateApiKey().key)).not.toBe(
      deriveApiKeyLookupHash(generateApiKey().key),
    );
  });

  it('the lookup value is not the raw key and cannot verify against key_hash', () => {
    const { key, keyHash, lookupHash } = generateApiKey();
    expect(lookupHash).not.toContain(key);
    // The locator must be useless as a credential.
    expect(verifyApiKey(lookupHash, keyHash)).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// 4. Pre-migration keys: still usable, and healed on first use
// ───────────────────────────────────────────────────────────────────────────────

describe('keys issued before db/024 (lookup_hash IS NULL)', () => {
  /** Insert a key the way rows looked before migration 024: no lookup_hash. */
  async function issueLegacyKey(): Promise<{ id: number; key: string; lookupHash: string }> {
    const { key, keyHash, lookupHash } = generateApiKey();
    const id = await db.insertApiKey({
      key_hash: keyHash,
      scout_wallet: SCOUT,
      label: 'pre-024',
      created_at: Math.floor(Date.now() / 1000),
    });
    return { id, key, lookupHash };
  }

  it('still authenticates, and is backfilled onto the indexed path on first use', async () => {
    const { id, key, lookupHash } = await issueLegacyKey();

    expect(storedLookupHash(id)).toBeNull();

    // First use: indexed lookup misses, transitional path verifies and heals.
    expect(await resolveApiKey(key)).toEqual({ scout_wallet: SCOUT, id, scopes: null });

    expect(storedLookupHash(id)).toBe(lookupHash);
  });

  it('second use takes the indexed path only — the fallback is not the hot path', async () => {
    const { id, key } = await issueLegacyKey();

    await resolveApiKey(key); // heals

    const byLookup = jest.spyOn(db, 'getActiveApiKeyByLookupHash');
    const scan = jest.spyOn(db, 'getActiveApiKeysAwaitingLookupHash');

    expect(await resolveApiKey(key)).toEqual({ scout_wallet: SCOUT, id, scopes: null });
    expect(byLookup).toHaveBeenCalledTimes(1);
    expect(scan).not.toHaveBeenCalled();
  });

  it('a revoked pre-migration key is never resolved or backfilled', async () => {
    const { id, key } = await issueLegacyKey();
    expect(await db.revokeApiKeyById(id, SCOUT)).toBe(true);

    expect(await resolveApiKey(key)).toBeNull();

    expect(storedLookupHash(id)).toBeNull();
  });
});
