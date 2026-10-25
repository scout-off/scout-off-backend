-- Derived from canonical events so replay/reorg deletion updates membership atomically.
CREATE INDEX IF NOT EXISTS idx_events_roles ON events(type, contract_id, ledger);
CREATE VIEW contract_role_memberships AS
SELECT contract_id, role, account FROM (
  SELECT contract_id, type,
         json_extract(payload, '$.role') AS role,
         json_extract(payload, '$.account') AS account,
         ROW_NUMBER() OVER (
           PARTITION BY contract_id, json_extract(payload, '$.role'), json_extract(payload, '$.account')
           ORDER BY ledger DESC, tx_application_order DESC, event_index DESC, id DESC
         ) AS ordinal
  FROM events WHERE type IN ('role_granted', 'role_revoked')
) ranked WHERE ordinal = 1 AND type = 'role_granted';
