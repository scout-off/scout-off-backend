import * as fs from 'fs';
import * as path from 'path';
import { ErrorCode } from '../../src/utils/errorCodes';
import {
  CONTRACT_ERRORS,
  ContractExecutionError,
  SOROBAN_ERROR_CODE_MAP,
  extractContractErrorCode,
  mapContractError,
} from '../../src/utils/contractErrors';

/** Parses `Variant = N,` entries from the Rust error enum. */
function rustErrorVariants(): Map<string, number> {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../contracts/shared/src/errors.rs'),
    'utf8',
  );
  const body = source.slice(source.indexOf('pub enum Error {'));
  const variants = new Map<string, number>();
  for (const match of body.matchAll(/^\s*([A-Z][A-Za-z0-9]*)\s*=\s*(\d+)\s*,/gm)) {
    variants.set(match[1], Number.parseInt(match[2], 10));
  }
  return variants;
}

describe('contract error mapping (#1530)', () => {
  const variants = rustErrorVariants();

  it('keeps the pre-existing discriminants stable (on-chain ABI contract)', () => {
    const expected: Record<string, number> = {
      AlreadyInitialized: 1,
      NotInitialized: 2,
      PlayerNotFound: 3,
      NotFound: 4,
      InvalidInput: 5,
      AlreadyVerified: 6,
      InsufficientFee: 7,
      NotSubscribed: 8,
      Unauthorized: 9,
      ContractPaused: 10,
      Overflow: 11,
      InsufficientSupply: 12,
    };
    for (const [name, code] of Object.entries(expected)) {
      expect(variants.get(name)).toBe(code);
    }
  });

  it('maps every variant defined in contracts/shared/src/errors.rs', () => {
    expect(variants.size).toBeGreaterThanOrEqual(22);
    for (const [name, code] of variants) {
      expect(CONTRACT_ERRORS[code]).toBeDefined();
      expect(SOROBAN_ERROR_CODE_MAP[code]).toBeDefined();
      // Guard against an enum variant silently reusing a backend mapping.
      expect(typeof CONTRACT_ERRORS[code].errorCode).toBe('string');
      expect(CONTRACT_ERRORS[code].message.length).toBeGreaterThan(0);
      expect(CONTRACT_ERRORS[code].status).toBeGreaterThanOrEqual(400);
      expect(CONTRACT_ERRORS[code].status).toBeLessThanOrEqual(599);
      expect(name.length).toBeGreaterThan(0);
    }
    // No extra backend-only codes either.
    expect(Object.keys(CONTRACT_ERRORS)).toHaveLength(variants.size);
  });

  it('maps the new granular variants to specific backend codes', () => {
    expect(mapContractError(13)).toMatchObject({
      errorCode: ErrorCode.VALIDATOR_NOT_REGISTERED,
      status: 403,
    });
    expect(mapContractError(15).errorCode).toBe(ErrorCode.MILESTONE_NOT_FOUND);
    expect(mapContractError(16)).toMatchObject({
      errorCode: ErrorCode.MILESTONE_ALREADY_APPROVED,
      status: 409,
    });
    expect(mapContractError(18).errorCode).toBe(ErrorCode.SUBSCRIPTION_EXPIRED);
    expect(mapContractError(20).errorCode).toBe(ErrorCode.FEE_BPS_OUT_OF_RANGE);
    expect(mapContractError(21).errorCode).toBe(ErrorCode.CONNECTION_NOT_FOUND);
    expect(mapContractError(22).errorCode).toBe(ErrorCode.CONNECTION_ALREADY_CLOSED);
  });

  it('falls back to a generic 500 for unknown codes', () => {
    expect(mapContractError(999)).toMatchObject({
      errorCode: ErrorCode.INTERNAL_SERVER_ERROR,
      status: 500,
    });
  });

  it('extracts codes from the formats Soroban emits', () => {
    expect(extractContractErrorCode('HostError: Error(Contract, #15)')).toBe(15);
    expect(extractContractErrorCode('Simulation failed: Error(Contract, 18)')).toBe(18);
    expect(extractContractErrorCode('contract error 21')).toBe(21);
    expect(extractContractErrorCode('nothing useful here')).toBeNull();
    expect(extractContractErrorCode('')).toBeNull();
  });

  it('attaches the extracted code to ContractExecutionError', () => {
    const err = new ContractExecutionError('HostError: Error(Contract, #22)');
    expect(err.contractErrorCode).toBe(22);
    expect(new ContractExecutionError('boom').contractErrorCode).toBeNull();
  });
});
