import { ErrorCode } from '../../src/utils/errorCodes';

describe('ErrorCode', () => {
  it('is defined as an object', () => {
    expect(typeof ErrorCode).toBe('object');
    expect(ErrorCode).not.toBeNull();
  });

  it('contains expected generic error codes', () => {
    expect(ErrorCode.INTERNAL_SERVER_ERROR).toBe('INTERNAL_SERVER_ERROR');
    expect(ErrorCode.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCode.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ErrorCode.MALFORMED_JSON).toBe('MALFORMED_JSON');
    expect(ErrorCode.PAYLOAD_TOO_LARGE).toBe('PAYLOAD_TOO_LARGE');
  });

  it('contains expected auth error codes', () => {
    expect(ErrorCode.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCode.FORBIDDEN).toBe('FORBIDDEN');
    expect(ErrorCode.TOKEN_INVALID).toBe('TOKEN_INVALID');
    expect(ErrorCode.TOKEN_EXPIRED).toBe('TOKEN_EXPIRED');
  });

  it('contains expected payment error codes', () => {
    expect(ErrorCode.INSUFFICIENT_FUNDS).toBe('INSUFFICIENT_FUNDS');
    expect(ErrorCode.INVALID_ACCOUNT).toBe('INVALID_ACCOUNT');
    expect(ErrorCode.NETWORK_ERROR).toBe('NETWORK_ERROR');
    expect(ErrorCode.PAYMENT_UNKNOWN).toBe('UNKNOWN');
  });

  it('contains expected fee withdrawal error codes', () => {
    expect(ErrorCode.NO_FEES).toBe('NO_FEES');
    expect(ErrorCode.INVALID_RECIPIENT).toBe('INVALID_RECIPIENT');
    expect(ErrorCode.CONTRACT_PAUSED).toBe('CONTRACT_PAUSED');
  });

  it('contains expected resource error codes', () => {
    expect(ErrorCode.PLAYER_NOT_FOUND).toBe('PLAYER_NOT_FOUND');
    expect(ErrorCode.SUBSCRIPTION_REQUIRED).toBe('SUBSCRIPTION_REQUIRED');
    expect(ErrorCode.CONFLICT).toBe('CONFLICT');
    expect(ErrorCode.WALLET_MISMATCH).toBe('WALLET_MISMATCH');
  });

  it('contains expected conditional-request error codes', () => {
    expect(ErrorCode.PRECONDITION_FAILED).toBe('PRECONDITION_FAILED');
    expect(ErrorCode.PRECONDITION_REQUIRED).toBe('PRECONDITION_REQUIRED');
  });

  it('exports string values for all keys', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(typeof key).toBe('string');
      expect(typeof value).toBe('string');
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('does not contain any empty string values', () => {
    Object.values(ErrorCode).forEach((value) => {
      expect(value).not.toBe('');
    });
  });
});
