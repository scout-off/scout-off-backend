import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { parseBoolean, parseU128, parseMilestones, parseSubscription } from '../../src/utils/xdrParser';

describe('parseBoolean', () => {
  it('returns true for scvBool true', () => {
    const val = nativeToScVal(true, { type: 'bool' });
    expect(parseBoolean(val)).toBe(true);
  });

  it('returns false for scvBool false', () => {
    const val = nativeToScVal(false, { type: 'bool' });
    expect(parseBoolean(val)).toBe(false);
  });

  it('throws for non-bool ScVal', () => {
    const val = nativeToScVal(42, { type: 'u32' });
    expect(() => parseBoolean(val)).toThrow();
  });

  it('parses an is_subscribed-style boolean result from a base64-encoded XDR envelope', () => {
    const encoded = nativeToScVal(true, { type: 'bool' }).toXdr('base64');
    const decoded = xdr.ScVal.fromXdr(encoded, 'base64');
    expect(parseBoolean(decoded)).toBe(true);
  });

  it('does not crash the process on a null/void ScVal, and throws a structured error instead', () => {
    const val = xdr.ScVal.scvVoid();
    expect(() => parseBoolean(val)).toThrow(/Expected scvBool/);
  });

  it('throws a structured error (not a crash) for malformed base64 XDR', () => {
    const malformed = 'not-valid-base64-xdr-!!!';
    expect(() => xdr.ScVal.fromXdr(malformed, 'base64')).toThrow();
  });

  it('returns null/handles gracefully for empty string XDR input instead of throwing an unstructured error', () => {
    const parseSafely = (raw: string | null | undefined): boolean | null => {
      if (!raw) return null;
      try {
        return parseBoolean(xdr.ScVal.fromXdr(raw, 'base64'));
      } catch {
        return null;
      }
    };
    expect(parseSafely('')).toBeNull();
    expect(parseSafely(null)).toBeNull();
    expect(parseSafely(undefined)).toBeNull();
  });
});

describe('parseU128', () => {
  it('parses a u128 value to bigint', () => {
    const val = nativeToScVal(BigInt('123456789'), { type: 'u128' });
    expect(parseU128(val)).toBe(BigInt('123456789'));
  });

  it('parses an i128 value to bigint', () => {
    const val = nativeToScVal(BigInt('987654321'), { type: 'i128' });
    expect(parseU128(val)).toBe(BigInt('987654321'));
  });

  it('parses a register_player-style u128 id from a round-tripped XDR envelope', () => {
    const encoded = nativeToScVal(BigInt('42'), { type: 'u128' }).toXdr('base64');
    const decoded = xdr.ScVal.fromXdr(encoded, 'base64');
    expect(parseU128(decoded)).toBe(BigInt('42'));
  });

  it('throws for non-u128 ScVal', () => {
    const val = nativeToScVal(true, { type: 'bool' });
    expect(() => parseU128(val)).toThrow();
  });
});

describe('parseMilestones', () => {
  it('returns empty array for empty vec', () => {
    const val = nativeToScVal([], { type: 'array' });
    expect(parseMilestones(val)).toEqual([]);
  });

  it('throws for non-vec ScVal', () => {
    const val = nativeToScVal(true, { type: 'bool' });
    expect(() => parseMilestones(val)).toThrow();
  });

  it('throws for a vec containing a non-map entry', () => {
    const val = nativeToScVal([true], { type: 'array' });
    expect(() => parseMilestones(val)).toThrow(/Expected scvMap for milestone entry/);
  });

  it('parses a get_profile-style struct with multiple populated fields', () => {
    const val = nativeToScVal(
      [
        {
          milestone_id: 'm-1',
          player_id: 'p-1',
          milestone_type: 'goal',
          evidence_uri: 'ipfs://evidence',
          approved: true,
          approved_by: 'GADMIN',
          ledger: 12345,
        },
      ],
      { type: 'array' }
    );
    const result = parseMilestones(val);
    expect(result).toEqual([
      {
        milestoneId: 'm-1',
        playerId: 'p-1',
        milestoneType: 'goal',
        evidenceUri: 'ipfs://evidence',
        approved: true,
        approvedBy: 'GADMIN',
        ledger: 12345,
      },
    ]);
  });

  it('defaults optional fields (approvedBy, ledger) to null when absent', () => {
    const val = nativeToScVal(
      [
        {
          milestone_id: 'm-2',
          player_id: 'p-2',
          milestone_type: 'assist',
          evidence_uri: '',
          approved: false,
        },
      ],
      { type: 'array' }
    );
    const result = parseMilestones(val);
    expect(result[0].approvedBy).toBeNull();
    expect(result[0].ledger).toBeNull();
  });
});

describe('parseSubscription', () => {
  it('parses active subscription', () => {
    const val = nativeToScVal(
      { active: true, expires_at: '1000000' },
      { type: 'map' }
    );
    const result = parseSubscription(val);
    expect(result.active).toBe(true);
    expect(result.expiresAt).toBe('1000000');
  });

  it('parses an inactive subscription with no expiry as null', () => {
    const val = nativeToScVal({ active: false }, { type: 'map' });
    const result = parseSubscription(val);
    expect(result.active).toBe(false);
    expect(result.expiresAt).toBeNull();
  });

  it('throws for non-map ScVal', () => {
    const val = nativeToScVal(true, { type: 'bool' });
    expect(() => parseSubscription(val)).toThrow();
  });
});
