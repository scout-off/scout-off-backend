-- Migration 011: pending admin multi-signature actions
-- High-value operations (pause/unpause contract, withdraw fees, etc.)
-- require M-of-N admin signatures tracked via this table.

CREATE TABLE IF NOT EXISTS pending_admin_actions (
  id                  TEXT    PRIMARY KEY,
  action_type         TEXT    NOT NULL,
  proposer            TEXT    NOT NULL,
  payload             TEXT    NOT NULL,       -- JSON: action-specific parameters
  required_signatures INTEGER NOT NULL,
  collected_signatures INTEGER DEFAULT 0,
  status              TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'expired')),
  expires_at          INTEGER NOT NULL,       -- unix ms
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_paa_status     ON pending_admin_actions (status);
CREATE INDEX IF NOT EXISTS idx_paa_expires    ON pending_admin_actions (expires_at);
CREATE INDEX IF NOT EXISTS idx_paa_action_type ON pending_admin_actions (action_type);

-- each signatory can sign once per action
CREATE TABLE IF NOT EXISTS admin_action_signatures (
  action_id  TEXT    NOT NULL,
  signer     TEXT    NOT NULL,
  signed_at  INTEGER NOT NULL,
  PRIMARY KEY (action_id, signer),
  FOREIGN KEY (action_id) REFERENCES pending_admin_actions(id) ON DELETE CASCADE
);
