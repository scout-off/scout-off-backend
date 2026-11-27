import config from '../../config';
import { PaymentError } from '../../services/stellar';

/**
 * HTTP status for each PaymentError code (Issue #761).
 *
 * | PaymentError code   | HTTP | Meaning                                  |
 * |---------------------|------|------------------------------------------|
 * | INSUFFICIENT_FUNDS  | 402  | Contract error #7 — micro-fee not paid   |
 * | EXPIRED_TRUSTLINE   | 402  | Payment-token trustline missing/expired  |
 * | CONTRACT_PAUSED     | 503  | Contract error #10 — platform paused     |
 * | MISSING_PLAYER      | 404  | Contract error #3 — player not on-chain  |
 * | PENDING_REGISTRATION| 409  | Wallet registration is not confirmed    |
 * | INVALID_ACCOUNT     | 400  | Missing/malformed wallet or playerId     |
 * | CONTRACT_ERROR      | 502  | Contract rejected the transaction        |
 * | NETWORK_ERROR       | 502  | RPC failure / confirmation timeout       |
 * | UNKNOWN             | 500  | Unclassified failure                     |
 */
export function paymentErrorStatus(code: PaymentError['code']): number {
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
    case 'EXPIRED_TRUSTLINE':
      return 402;
    case 'CONTRACT_PAUSED':
      return 503;
    case 'MISSING_PLAYER':
      return 404;
    case 'PENDING_REGISTRATION':
      return 409;
    case 'INVALID_ACCOUNT':
      return 400;
    case 'CONTRACT_ERROR':
    case 'NETWORK_ERROR':
      return 502;
    case 'UNKNOWN':
      return 500;
  }
}

/**
 * Returns the grace-period-aware expiry threshold.
 * A subscription is considered "live" until expiresAt + gracePeriodSeconds.
 */
export function gracePeriodSeconds(): number {
  return config.subscriptionGracePeriodHours * 3600;
}
