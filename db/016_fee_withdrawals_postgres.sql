-- Migration 016: fee_withdrawals table (PostgreSQL)
--
-- Records every successful on-chain fee withdrawal so the platform has an
-- auditable, queryable history of all disbursements. A unique constraint on
-- idempotency_key prevents double-submission when the same Idempotency-Key
-- header is sent more than once (the controller's idempotency middleware
-- serves the cached HTTP response; this DB constraint is a second line of
-- defence at the storage layer).

CREATE TABLE IF NOT EXISTS fee_withdrawals (
  id               SERIAL  PRIMARY KEY,
  idempotency_key  TEXT    UNIQUE,            -- opaque client-supplied key (nullable for legacy rows)
  treasury_address TEXT    NOT NULL,           -- Stellar public key that received the funds
  amount_stroops   TEXT    NOT NULL,           -- u128 serialised as text to avoid integer overflow
  tx_hash          TEXT    NOT NULL UNIQUE,    -- confirmed Soroban transaction hash
  admin_wallet     TEXT    NOT NULL,           -- platform admin wallet that initiated the withdrawal
  created_at       TEXT    NOT NULL            -- ISO 8601 timestamp
);

CREATE INDEX IF NOT EXISTS idx_fee_withdrawals_treasury
  ON fee_withdrawals (treasury_address);

CREATE INDEX IF NOT EXISTS idx_fee_withdrawals_admin
  ON fee_withdrawals (admin_wallet);
