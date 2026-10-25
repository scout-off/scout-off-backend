/**
 * Field-encryption keyring parsing (#1513).
 *
 * Format: `<keyId>:<base64-key>,<keyId>:<base64-key>,...` where each key is
 * 32 bytes. Key ids are `[A-Za-z0-9-]{1,32}` (no `_`, which is a SQL LIKE
 * wildcard, and no `:`, which delimits the v2 ciphertext envelope).
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9-]{1,32}$/;
const KEY_BYTES = 32;

export interface Keyring {
  keys: ReadonlyMap<string, Buffer>;
  activeKeyId: string;
}

/**
 * Parses and validates a keyring. Returns null when `rawKeys` is empty (keyring
 * not configured). Throws a descriptive error — never including key material —
 * when the configuration is invalid.
 */
export function parseKeyring(
  rawKeys: string,
  activeKeyId: string,
  keysEnv: string,
  activeEnv: string,
): Keyring | null {
  const raw = rawKeys.trim();
  if (!raw) return null;

  const keys = new Map<string, Buffer>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    const sep = trimmed.indexOf(':');
    const id = sep > 0 ? trimmed.slice(0, sep) : '';
    if (!KEY_ID_PATTERN.test(id)) {
      throw new Error(
        `${keysEnv} entries must look like "<keyId>:<base64-key>" with keyId matching ${KEY_ID_PATTERN}`,
      );
    }
    if (keys.has(id)) {
      throw new Error(`${keysEnv} contains duplicate key id "${id}"`);
    }
    const key = Buffer.from(trimmed.slice(sep + 1), 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `${keysEnv} key "${id}" must be ${KEY_BYTES} bytes of base64. Generate one with: openssl rand -base64 32`,
      );
    }
    keys.set(id, key);
  }

  const active = activeKeyId.trim();
  if (!active) {
    throw new Error(`${activeEnv} is required when ${keysEnv} is set`);
  }
  if (!keys.has(active)) {
    throw new Error(
      `${activeEnv}="${active}" is not present in ${keysEnv} (known key ids: ${[...keys.keys()].join(', ')})`,
    );
  }
  return { keys, activeKeyId: active };
}
