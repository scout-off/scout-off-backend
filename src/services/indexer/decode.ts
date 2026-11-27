/**
 * indexer/decode.ts
 *
 * Event decoding for the indexer (split out of services/indexer.ts).
 *
 * Responsibilities:
 *   - Normalise contract payload keys to snake_case (`normalizePayload`).
 *   - Decode a raw Soroban event's topics/value into `{ type, payload }`
 *     (`normalizeSorobanEvent`).
 *   - Classify whether a decoded type is appliable (`isKnownEventType`) and
 *     best-effort read its topic-0 type for metrics/logging (`safeTopicType`).
 *   - Serialize/deserialize an event's raw XDR so an event the indexer could
 *     not apply can be replayed later (#1540).
 *
 * Pure: no database or network access.
 */

import { scValToNative, xdr } from '@stellar/stellar-sdk';
import { CONTRACT_EVENT_TYPES } from '../../types';

// ─── Payload normalisation ────────────────────────────────────────────────────
//
// The Soroban contract emits events with snake_case field names but some events
// arrive with camelCase keys. normalizePayload() converts every camelCase key to
// snake_case on ingest so all DB reads can use a single canonical naming style.

function camelToSnake(key: string): string {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/** Convert every camelCase key in a payload to snake_case. */
export function normalizePayload(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).map(([k, v]) => [camelToSnake(k), v]));
}

function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, jsonSafe(entry)]));
  }
  return value;
}

function nativeText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/** Normalize the register contract's compact topics and positional event data. */
export function normalizeSorobanEvent(raw: { topic?: unknown[]; value?: unknown }): {
  type: string;
  payload: Record<string, unknown>;
} {
  const topics = raw.topic ?? [];
  const rawType = topics[0] ? nativeText(scValToNative(topics[0] as never)) : '';
  const typeAliases: Record<string, string> = {
    player_rg: 'player_registered',
    tok_iss: 'token_issued',
    tok_buy: 'token_bought',
    fee_upd: 'platform_fee_updated',
  };
  let type = typeAliases[rawType] ?? rawType;
  const nativeValue = raw.value ? scValToNative(raw.value as never) : undefined;
  const tuple = Array.isArray(nativeValue) ? nativeValue : [];
  let payload: Record<string, unknown>;

  if (['role_granted', 'role_revoked'].includes(rawType)) {
    return {
      type,
      payload: {
        role: nativeText(topics[1] ? scValToNative(topics[1] as never) : undefined),
        account: nativeText(tuple[0]),
        sender: nativeText(tuple[1]),
      },
    };
  }
  if (rawType === 'role_admin_changed') {
    return {
      type,
      payload: {
        role: nativeText(topics[1] ? scValToNative(topics[1] as never) : undefined),
        previous_admin_role: nativeText(tuple[0]),
        admin_role: nativeText(tuple[1]),
        sender: nativeText(tuple[2]),
      },
    };
  }

  if (rawType === 'player_rg') {
    const onChainPlayerId = nativeText(tuple[0]);
    return {
      type: 'player_registered',
      payload: {
        player_id: onChainPlayerId,
        on_chain_player_id: onChainPlayerId,
        wallet: nativeText(topics[1] ? scValToNative(topics[1] as never) : undefined),
        metadata_uri: nativeText(tuple[1]),
        position: nativeText(tuple[2]),
        region: nativeText(tuple[3]),
      },
    };
  }

  if (nativeValue && typeof nativeValue === 'object' && !Array.isArray(nativeValue)) {
    payload = normalizePayload(jsonSafe(nativeValue) as Record<string, unknown>);
  } else if (Array.isArray(nativeValue)) {
    payload = {};
  } else {
    payload = { data: jsonSafe(nativeValue) };
  }

  if (rawType === 'contact_unlocked' && topics.length === 1 && tuple.length >= 2) {
    payload.scout = nativeText(tuple[0]);
    payload.player_id = nativeText(tuple[1]);
  } else if (rawType === 'contact_unlocked' && topics.length >= 3) {
    type = 'connection_created';
    payload.scout = nativeText(scValToNative(topics[1] as never));
    payload.player_id = nativeText(scValToNative(topics[2] as never));
    if (tuple.length >= 1) payload.connection_type = nativeText(tuple[0]);
  } else if (rawType === 'fee_upd' && tuple.length >= 1) {
    payload.new_bps = tuple[0];
  } else if (rawType === 'tok_iss' && tuple.length >= 1) {
    payload.total_supply = tuple[0];
  } else if (rawType === 'tok_buy' && tuple.length >= 2) {
    payload.buyer = nativeText(tuple[0]);
    payload.amount = tuple[1];
  } else if (type === 'milestone_submitted' && tuple.length >= 3) {
    payload.milestone_id = nativeText(tuple[0]);
    payload.milestone_type = nativeText(tuple[1]);
    payload.evidence_uri = nativeText(tuple[2]);
    if (topics[1]) payload.validator = nativeText(scValToNative(topics[1] as never));
  } else if (type === 'milestone_approved' && tuple.length >= 2) {
    payload.milestone_id = nativeText(tuple[0]);
    payload.new_level = tuple[1];
    if (topics[1]) payload.validator = nativeText(scValToNative(topics[1] as never));
  }

  const playerTopicIndex =
    rawType.startsWith('tok_') || ['token_issued', 'token_bought'].includes(type)
      ? 1
      : [
            'milestone_submitted',
            'milestone_approved',
            'milestone_rejected',
            'contact_unlocked',
            'connection_created',
            'connection_closed',
            'trial_offer_logged',
          ].includes(type)
        ? 2
        : -1;
  const topicPlayerId =
    playerTopicIndex >= 0 && topics[playerTopicIndex]
      ? nativeText(scValToNative(topics[playerTopicIndex] as never))
      : '';
  const payloadPlayerId = nativeText(payload.player_id);
  const onChainPlayerId = topicPlayerId || (/^\d+$/.test(payloadPlayerId) ? payloadPlayerId : '');

  if (onChainPlayerId) {
    payload.on_chain_player_id = onChainPlayerId;
    payload.player_id = onChainPlayerId;
  }

  return { type, payload };
}

// ─── Outcome classification (#1540) ───────────────────────────────────────────
//
// Every RPC event is funnelled through the apply path, which classifies the
// outcome as one of `applied`, `unknown_type` or `decode_error`. Unknown and
// undecodable events are counted (scout_off_indexer_events_total{type,outcome}),
// logged with ledger/tx/contract/topic context, and persisted to
// indexer_unprocessed_events so they can be replayed once the decoder is fixed —
// instead of being dropped silently. See docs/indexer.md.

/** Set of event types the indexer knows how to apply. Derived from CONTRACT_EVENT_TYPES so the two cannot drift. */
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<string>(CONTRACT_EVENT_TYPES);

/** Returns true when `type` is a recognised, appliable contract event type. */
export function isKnownEventType(type: string): boolean {
  return KNOWN_EVENT_TYPES.has(type);
}

/**
 * Best-effort extraction of the topic-0 type string without throwing.
 * Used to label decode_error events (whose value may be un-decodable but whose
 * topic may still be readable) in metrics and logs.
 */
export function safeTopicType(raw: { topic?: unknown[] }): string {
  try {
    const topics = raw.topic ?? [];
    return topics[0] ? nativeText(scValToNative(topics[0] as never)) : '';
  } catch {
    return '';
  }
}

/**
 * Serialize an event's raw topic/value to XDR (base64) so it can be replayed
 * later. Returns nulls when XDR encoding is not possible for a field.
 */
export function serializeEventForReplay(raw: { topic?: unknown[]; value?: unknown }): {
  topicJson: string | null;
  valueXdr: string | null;
} {
  const toXdr = (sv: unknown): string | null => {
    try {
      if (sv && typeof (sv as { toXdr?: unknown }).toXdr === 'function') {
        return (sv as { toXdr(fmt?: string): string }).toXdr('base64');
      }
      return null;
    } catch {
      return null;
    }
  };

  const topicArr = raw.topic ?? [];
  const topicXdrs = topicArr.map(toXdr);
  const topicJson = topicArr.length > 0 ? JSON.stringify(topicXdrs) : null;
  const valueXdr = toXdr(raw.value);
  return { topicJson, valueXdr };
}

/**
 * Rebuild a raw event ({ topic, value }) from the XDR persisted in
 * indexer_unprocessed_events, so a stored event can be replayed through
 * normalizeSorobanEvent after a decoder fix.
 */
export function deserializeEventFromReplay(
  topicJson: string | null,
  valueXdr: string | null,
): {
  topic?: xdr.ScVal[];
  value?: xdr.ScVal;
} {
  const out: { topic?: xdr.ScVal[]; value?: xdr.ScVal } = {};
  if (topicJson) {
    try {
      const arr = JSON.parse(topicJson) as (string | null)[];
      out.topic = arr
        .filter((x): x is string => typeof x === 'string')
        .map((x) => xdr.ScVal.fromXdr(x, 'base64'));
    } catch {
      /* leave topic undefined */
    }
  }
  if (valueXdr) {
    try {
      out.value = xdr.ScVal.fromXdr(valueXdr, 'base64');
    } catch {
      /* leave value undefined */
    }
  }
  return out;
}
