/**
 * GDPR anonymization helpers for indexed event JSON payloads (#1329).
 */

const REDACTED = '[anonymized]';

const PII_FIELD_NAMES = new Set([
  'wallet',
  'metadata_uri',
  'region',
  'evidence_uri',
  'details_uri',
  'position',
  'details',
  'note',
  'note_text',
  'content',
  'message',
  'reason',
]);

function isFreeTextField(key: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (PII_FIELD_NAMES.has(key)) return true;
  if (key.endsWith('_uri')) return true;
  if (key.includes('text') || key.includes('comment')) return true;
  return value.length > 120;
}

export function payloadReferencesPlayer(payload: unknown, playerId: string): boolean {
  if (payload === null || payload === undefined) return false;
  if (typeof payload === 'string') {
    return payload.includes(playerId);
  }
  if (typeof payload !== 'object') return false;
  const obj = payload as Record<string, unknown>;
  if (obj.player_id === playerId) return true;
  try {
    return JSON.stringify(payload).includes(playerId);
  } catch {
    return false;
  }
}

/**
 * Redact PII inside an event payload while preserving structural fields
 * (type, ledger, tx_hash, player_id surrogate, milestone ids, etc.).
 */
export function redactEventPayload(
  payload: Record<string, unknown>,
  playerId: string,
): Record<string, unknown> {
  if (!payloadReferencesPlayer(payload, playerId)) {
    return payload;
  }

  const out: Record<string, unknown> = { ...payload };
  for (const [key, value] of Object.entries(out)) {
    if (key === 'player_id') continue;
    if (value === playerId) continue;

    if (typeof value === 'string' && (PII_FIELD_NAMES.has(key) || isFreeTextField(key, value))) {
      out[key] = REDACTED;
      continue;
    }

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redactEventPayload(value as Record<string, unknown>, playerId);
    }
  }
  return out;
}

export function redactJsonStringPayload(raw: string, playerId: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payloadReferencesPlayer(parsed, playerId)) {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return JSON.stringify(REDACTED);
  }
  return JSON.stringify(redactEventPayload(parsed as Record<string, unknown>, playerId));
}
