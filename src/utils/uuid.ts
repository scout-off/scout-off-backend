import crypto from 'crypto';

/**
 * UUID v7: 48-bit unix timestamp (ms) + monotonic counter + random bits.
 *
 * Time-ordered: UUIDs generated later sort lexicographically after earlier ones.
 * Within the same millisecond, a monotonic counter ensures ordering.
 * Used as globally unique messageId for exactly-once delivery tracking.
 *
 * Format per RFC 9562:
 *   Bytes 0-5:  48-bit unix timestamp (ms)
 *   Byte 6:     version(4 bits=7) + rand_a_high(4 bits)
 *   Byte 7:     rand_a_low(8 bits)
 *   Byte 8:     variant(2 bits=10) + rand_b_high(6 bits)
 *   Bytes 9-15: rand_b(56 bits)
 */

// Monotonic state for same-millisecond ordering
let lastMs = 0;
let monotonicCounter = 0;

export function uuidv7(): string {
  const now = Date.now();

  // Advance counter if same millisecond, reset if new millisecond
  if (now === lastMs) {
    monotonicCounter++;
    // If counter overflows 10 bits (1023), bump the timestamp by 1ms
    if (monotonicCounter > 0x3FF) {
      lastMs = now + 1;
      monotonicCounter = 0;
    }
  } else {
    lastMs = now;
    monotonicCounter = 0;
  }

  const ts = lastMs;

  // Write 48-bit timestamp as 6 bytes, big-endian
  const tsBytes = Buffer.alloc(6);
  tsBytes[0] = (ts / 0x10000000000) & 0xFF;
  tsBytes[1] = (ts / 0x100000000) & 0xFF;
  tsBytes[2] = (ts / 0x1000000) & 0xFF;
  tsBytes[3] = (ts / 0x10000) & 0xFF;
  tsBytes[4] = (ts / 0x100) & 0xFF;
  tsBytes[5] = ts & 0xFF;

  // 10 random bytes
  const rand = crypto.randomBytes(10);

  // Byte 6 (rand[0]): version(4 bits=7) + rand_a high 4 bits
  rand[0] = 0x70 | ((monotonicCounter >> 6) & 0x0F);

  // Byte 7 (rand[1]): rand_a low 8 bits
  rand[1] = (monotonicCounter & 0xFF);

  // Byte 8 (rand[2]): variant(2 bits=10) + rand_b high 6 bits
  rand[2] = 0x80 | (rand[2] & 0x3F);

  // Combine: 6 timestamp bytes + 10 random bytes = 16 bytes
  const bytes = Buffer.concat([tsBytes, rand]);

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Extract the millisecond timestamp from a UUID v7 string.
 * Returns null if the input is not a valid UUID or the version nibble is not 7.
 */
export function extractTimestampFromV7(uuid: string): number | null {
  const match = uuid.match(
    /^[0-9a-f]{8}-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  if (!match) return null;

  const hex = uuid.replace(/-/g, '');

  // Bytes 0-5 are the timestamp
  const b0 = parseInt(hex.slice(0, 2), 16);
  const b1 = parseInt(hex.slice(2, 4), 16);
  const b2 = parseInt(hex.slice(4, 6), 16);
  const b3 = parseInt(hex.slice(6, 8), 16);
  const b4 = parseInt(hex.slice(8, 10), 16);
  const b5 = parseInt(hex.slice(10, 12), 16);

  const timestamp =
    b0 * 0x10000000000 +
    b1 * 0x100000000 +
    b2 * 0x1000000 +
    b3 * 0x10000 +
    b4 * 0x100 +
    b5;

  return timestamp;
}

/** Reset internal monotonic counter (for tests). */
export function resetUuidCounter(): void {
  lastMs = 0;
  monotonicCounter = 0;
}
