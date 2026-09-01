/**
 * Deterministic total order for indexed Soroban events (#1111).
 *
 * Sort key: (ledger ASC, tx_application_order ASC, event_index ASC, contract_id ASC)
 *
 * Co-transaction events (same ledger + tx_application_order / tx_hash) are an
 * atomic group: consumers must apply them as a unit in this order so
 * downstream tier promotion, cache invalidation, and webhooks never observe
 * a later event before an earlier sibling from the same transaction.
 */

export interface OrderedEventFields {
  ledger: number;
  txApplicationOrder: number;
  eventIndex: number;
  contractId: string;
  txHash: string;
}

/** RPC-ish event shape we normalize from getEvents responses / fixtures. */
export interface RawIndexerEvent {
  ledger: number;
  txHash: string;
  /** Opaque RPC paging / event id, often "ledger-txIndex-eventIndex". */
  id?: string;
  contractId?: string;
  topic?: unknown[];
  value?: unknown;
  ledgerClosedAt?: string;
  ledgerHash?: string;
  pagingToken?: string;
  /** Optional explicit ordinals when the RPC / fixture supplies them. */
  txIndex?: number;
  eventIndex?: number;
}

export interface NormalizedIndexerEvent extends OrderedEventFields {
  raw: RawIndexerEvent;
}

/**
 * Parse ledger / tx / event ordinals from a Soroban RPC event id / paging token.
 * Accepts common forms: "0000123456-0000000001-0000000000" or "123456-1-0".
 * Returns null when the token cannot be parsed.
 */
export function parseEventIdOrdinals(
  id: string | undefined | null,
): { ledger: number; txApplicationOrder: number; eventIndex: number } | null {
  if (!id) return null;
  const parts = id.split('-').map((p) => p.trim());
  if (parts.length < 3) return null;
  const ledger = Number(parts[0]);
  const txApplicationOrder = Number(parts[1]);
  const eventIndex = Number(parts[2]);
  if (![ledger, txApplicationOrder, eventIndex].every((n) => Number.isFinite(n))) {
    return null;
  }
  return { ledger, txApplicationOrder, eventIndex };
}

/**
 * Assign deterministic ordinals to a batch of RPC events, then sort them into
 * the canonical total order. Assignment is stable regardless of the order the
 * RPC returned the array:
 *   1. Prefer explicit txIndex / eventIndex / parseable id
 *   2. Fall back to first-seen order within each ledger for tx order, and
 *      first-seen order within each tx for event_index
 */
export function normalizeAndSortEvents(
  events: RawIndexerEvent[],
  defaultContractId = '',
): NormalizedIndexerEvent[] {
  // First pass: group by ledger then by txHash in the order we discover them
  // after a stable pre-sort by parseable id (when present).
  const preSorted = [...events].sort((a, b) => {
    if (a.ledger !== b.ledger) return a.ledger - b.ledger;
    const aId = a.id ?? '';
    const bId = b.id ?? '';
    if (aId && bId && aId !== bId) return aId < bId ? -1 : 1;
    if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : a.txHash > b.txHash ? 1 : 0;
    return 0;
  });

  const txOrderByLedger = new Map<string, number>(); // `${ledger}:${txHash}` → order
  const nextTxOrderByLedger = new Map<number, number>();
  const eventIndexByTx = new Map<string, number>(); // txHash → next index

  const normalized: NormalizedIndexerEvent[] = preSorted.map((raw) => {
    const parsed = parseEventIdOrdinals(raw.id ?? raw.pagingToken);
    const contractId = raw.contractId ?? defaultContractId;

    let txApplicationOrder: number;
    if (typeof raw.txIndex === 'number' && Number.isFinite(raw.txIndex)) {
      txApplicationOrder = raw.txIndex;
    } else if (parsed) {
      txApplicationOrder = parsed.txApplicationOrder;
    } else {
      const key = `${raw.ledger}:${raw.txHash}`;
      let order = txOrderByLedger.get(key);
      if (order === undefined) {
        order = nextTxOrderByLedger.get(raw.ledger) ?? 0;
        nextTxOrderByLedger.set(raw.ledger, order + 1);
        txOrderByLedger.set(key, order);
      }
      txApplicationOrder = order;
    }

    let eventIndex: number;
    if (typeof raw.eventIndex === 'number' && Number.isFinite(raw.eventIndex)) {
      eventIndex = raw.eventIndex;
    } else if (parsed) {
      eventIndex = parsed.eventIndex;
    } else {
      const next = eventIndexByTx.get(raw.txHash) ?? 0;
      eventIndexByTx.set(raw.txHash, next + 1);
      eventIndex = next;
    }

    return {
      ledger: raw.ledger,
      txApplicationOrder,
      eventIndex,
      contractId,
      txHash: raw.txHash,
      raw,
    };
  });

  return sortByEventOrdinal(normalized);
}

/** Compare two ordinal tuples; negative if a < b. */
export function compareEventOrdinals(a: OrderedEventFields, b: OrderedEventFields): number {
  if (a.ledger !== b.ledger) return a.ledger - b.ledger;
  if (a.txApplicationOrder !== b.txApplicationOrder) {
    return a.txApplicationOrder - b.txApplicationOrder;
  }
  if (a.eventIndex !== b.eventIndex) return a.eventIndex - b.eventIndex;
  if (a.contractId !== b.contractId) {
    return a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1 : 0;
  }
  return 0;
}

export function sortByEventOrdinal<T extends OrderedEventFields>(events: T[]): T[] {
  return [...events].sort(compareEventOrdinals);
}

/**
 * Group consecutive events that share the same (ledger, tx_application_order, tx_hash)
 * into atomic co-transaction batches. Caller must pass events already in total order.
 */
export function groupCoTransactionEvents<T extends OrderedEventFields & { txHash: string }>(
  events: T[],
): T[][] {
  const groups: T[][] = [];
  for (const event of events) {
    const last = groups[groups.length - 1];
    if (
      last &&
      last[0].ledger === event.ledger &&
      last[0].txApplicationOrder === event.txApplicationOrder &&
      last[0].txHash === event.txHash
    ) {
      last.push(event);
    } else {
      groups.push([event]);
    }
  }
  return groups;
}

/** SQL ORDER BY fragment used by every events consumer query. */
export const EVENTS_ORDER_BY_SQL =
  'ledger ASC, tx_application_order ASC, event_index ASC, contract_id ASC, id ASC';
