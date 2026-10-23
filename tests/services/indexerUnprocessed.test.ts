/**
 * #1540 — Count and log contract events the indexer can't decode or recognise,
 * store them in indexer_unprocessed_events for replay, and expose admin
 * list/retry endpoints.
 */
import { indexEvents, isKnownEventType } from '../../src/services/indexer';
import { replayUnprocessedEvent } from '../../src/services/indexer';
import {
  listUnprocessedEvents,
  getUnprocessedEventById,
  fetchLastIndexedLedger,
  getEventsCount,
} from '../../src/db';
import {
  getIndexerEventMetrics,
  resetMetrics,
} from '../../src/middleware/metrics';

jest.mock('../../src/services/stellar', () => ({
  server: { getEvents: jest.fn() },
}));
jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/cache', () => ({
  getPlayerListLastModified: jest.fn(() => 0),
  __setPlayerListLastModifiedForTests: jest.fn(),
  invalidatePlayerCache: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { server } = require('../../src/services/stellar') as {
  server: { getEvents: jest.Mock };
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { nativeToScVal, Address, Keypair } = require('@stellar/stellar-sdk');

function makeEvent(
  type: string,
  payload: Record<string, unknown>,
  txHash: string,
  ledger = 100,
  eventIndex = 0,
) {
  return {
    topic: [nativeToScVal(type, { type: 'symbol' })],
    value: nativeToScVal(payload),
    ledger,
    txHash,
    eventIndex,
  };
}

/**
 * An event whose VALUE cannot be decoded: a scvVec whose child has an
 * unsupported arm, so scValToNative throws — the realistic shape of a
 * contract upgrade that reshaped an event's value.
 */
function makeUndecodableEvent(txHash: string, ledger = 300) {
  const malformedChild = {
    get type(): string {
      throw new Error('unsupported ScVal arm');
    },
  };
  return {
    topic: [nativeToScVal('player_registered', { type: 'symbol' })],
    value: { type: 'scvVec', value: [malformedChild] },
    ledger,
    txHash,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetMetrics();
});

describe('indexer unknown/undecodable events (#1540)', () => {
  it('isKnownEventType reflects the CONTRACT_EVENT_TYPES allowlist', () => {
    expect(isKnownEventType('player_registered')).toBe(true);
    expect(isKnownEventType('milestone_approved')).toBe(true);
    expect(isKnownEventType('totally_made_up_event')).toBe(false);
  });

  it('counts an unknown event type and stores it for replay', async () => {
    const tx = `tx-unknown-${Math.random().toString(36).slice(2)}`;
    server.getEvents.mockResolvedValue({
      latestLedger: 100,
      events: [makeEvent('brand_new_event', { foo: 'bar' }, tx, 100)],
    });

    await indexEvents();

    const metrics = getIndexerEventMetrics();
    expect(metrics['brand_new_event']?.unknown_type).toBe(1);
    // It was never applied.
    expect(metrics['brand_new_event']?.applied).toBe(0);

    const { data } = await listUnprocessedEvents({ reason: 'unknown_type' });
    const row = data.find((r) => r.tx_hash === tx);
    expect(row).toBeDefined();
    expect(row!.reason).toBe('unknown_type');
    expect(row!.type).toBe('brand_new_event');
    // Raw topic XDR retained for replay.
    expect(row!.topic_json).toBeTruthy();
  });

  it('counts an undecodable event as decode_error and stores it', async () => {
    const tx = `tx-decode-${Math.random().toString(36).slice(2)}`;
    server.getEvents.mockResolvedValue({
      latestLedger: 300,
      events: [makeUndecodableEvent(tx, 300)],
    });

    await indexEvents();

    const metrics = getIndexerEventMetrics();
    expect(metrics['player_registered']?.decode_error).toBe(1);

    const { data } = await listUnprocessedEvents({ reason: 'decode_error' });
    const row = data.find((r) => r.tx_hash === tx);
    expect(row).toBeDefined();
    expect(row!.reason).toBe('decode_error');
    // The topic is still readable even though the value is not.
    expect(row!.type).toBe('player_registered');
  });

  it('deduplicates unprocessed events on (tx_hash, event_index) across polls', async () => {
    const tx = `tx-dedup-${Math.random().toString(36).slice(2)}`;
    const unknown = makeEvent('mystery_event', { a: 1 }, tx, 400);
    server.getEvents.mockResolvedValue({ latestLedger: 400, events: [unknown] });

    await indexEvents();
    await indexEvents();

    const { data } = await listUnprocessedEvents({ reason: 'unknown_type' });
    const rows = data.filter((r) => r.tx_hash === tx);
    expect(rows).toHaveLength(1);
  });

  it('one bad event does not stop the rest of the batch from being applied', async () => {
    const base = 500_000 + Math.floor(Math.random() * 100_000);
    const wallet = Keypair.random().publicKey();
    server.getEvents.mockResolvedValue({
      latestLedger: base + 2,
      events: [
        makeEvent('mystery_event', { x: 1 }, `tx-bad-${base}`, base),
        makeEvent(
          'player_registered',
          { player_id: '42', wallet, metadata_uri: 'ipfs://m', position: 'p', region: 'r' },
          `tx-good-${base}`,
          base + 1,
        ),
        makeEvent('milestone_approved', { player_id: 'P-BATCH', milestone_id: 'M1' }, `tx-after-${base}`, base + 2),
      ],
    });

    await indexEvents();

    // The known events on either side of the bad one were applied.
    expect(getEventsCount('player_registered')).toBeGreaterThan(0);
    expect(getEventsCount('milestone_approved')).toBeGreaterThan(0);

    // The bad event was parked, not applied.
    const metrics = getIndexerEventMetrics();
    expect(metrics['mystery_event']?.unknown_type).toBe(1);
    const { data } = await listUnprocessedEvents({ reason: 'unknown_type' });
    expect(data.some((r) => r.tx_hash === `tx-bad-${base}`)).toBe(true);
  });

  it('advances the cursor past unknown events (they are parked, not blocking)', async () => {
    const base = 700_000 + Math.floor(Math.random() * 100_000);
    server.getEvents.mockResolvedValue({
      latestLedger: base,
      events: [makeEvent('mystery_event', { x: 1 }, `tx-cursor-unknown-${base}`, base)],
    });

    await indexEvents();

    // Cursor advanced to latest+1 despite the unknown event.
    expect(fetchLastIndexedLedger()).toBe(base + 1);
  });

  it('holds the cursor at a KNOWN event that failed to decode', async () => {
    const base = 900_000 + Math.floor(Math.random() * 100_000);
    const undecodable = makeUndecodableEvent(`tx-cursor-decode-${base}`, base);
    server.getEvents.mockResolvedValue({
      latestLedger: base + 5,
      events: [undecodable],
    });

    await indexEvents();

    // Cursor held at the failed event's ledger so the next poll retries it.
    expect(fetchLastIndexedLedger()).toBe(base);
  });
});

describe('replayUnprocessedEvent (#1540)', () => {
  it('applies a stored KNOWN event parked by a decode_error once the value round-trips', async () => {
    // Park a player_registered event that fails to decode on the live path.
    const tx = `tx-replay-${Math.random().toString(36).slice(2)}`;
    const wallet = Keypair.random().publicKey();
    const undecodable = makeUndecodableEvent(tx, 1200);
    server.getEvents.mockResolvedValue({ latestLedger: 1200, events: [undecodable] });
    await indexEvents();

    const { data } = await listUnprocessedEvents({ reason: 'decode_error' });
    const row = data.find((r) => r.tx_hash === tx);
    expect(row).toBeDefined();

    // Simulate a decoder fix by overwriting the stored XDR with a valid
    // player_registered event, then replay — it should now apply and clear.
    const valid = makeEvent(
      'player_registered',
      { player_id: '77', wallet, metadata_uri: 'ipfs://replay', position: 'p', region: 'r' },
      tx,
      1200,
    );
    const { serializeEventForReplay } = jest.requireActual('../../src/services/indexer');
    const { topicJson, valueXdr } = serializeEventForReplay(valid);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDriver } = require('../../src/db');
    await getDriver().run(
      'UPDATE indexer_unprocessed_events SET topic_json = ?, value_xdr = ? WHERE id = ?',
      [topicJson, valueXdr, row!.id],
    );

    const result = await replayUnprocessedEvent(row!.id);
    expect(result.status).toBe('applied');
    // The unprocessed row is cleared after a successful replay.
    const after = await getUnprocessedEventById(row!.id);
    expect(after).toBeNull();
  });

  it('reports still_failing when the type remains unknown', async () => {
    const tx = `tx-replay-unknown-${Math.random().toString(36).slice(2)}`;
    server.getEvents.mockResolvedValue({
      latestLedger: 1100,
      events: [makeEvent('still_unknown_event', { a: 1 }, tx, 1100)],
    });
    await indexEvents();

    const { data } = await listUnprocessedEvents({ reason: 'unknown_type' });
    const row = data.find((r) => r.tx_hash === tx);
    expect(row).toBeDefined();

    const result = await replayUnprocessedEvent(row!.id);
    expect(result.status).toBe('still_failing');
    // Row is retained for a future retry.
    expect(await getUnprocessedEventById(row!.id)).not.toBeNull();
  });

  it('returns not_found for an unknown id', async () => {
    const result = await replayUnprocessedEvent(999_999_999);
    expect(result.status).toBe('not_found');
  });
});
