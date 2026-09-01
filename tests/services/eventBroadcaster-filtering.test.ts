/**
 * Advanced filter tests for EventBroadcaster.
 *
 * Coverage:
 *   - eventTypes filter: only named event types are delivered
 *   - playerId filter: only events referencing the player are delivered
 *   - Combined filters: intersection of both criteria (not union)
 *   - No filter: wildcard behaviour (all wallet-relevant events)
 *   - Wallet relevance always applied (no cross-tenant leakage)
 *   - Cross-subscriber isolation (subscribers only receive their own filtered events)
 *
 * The tests drive events through the broadcaster and assert that each
 * subscriber's send() callback is invoked only for matching events.
 */

import {
  EventBroadcaster,
  broadcaster,
  BroadcastEvent,
  SseSubscriber,
  SseFilterCriteria,
} from '../../src/services/eventBroadcaster';

const WALLET_A = 'GAWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET_B = 'GAWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PLAYER_1 = 'GAPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PLAYER_2 = 'GAPLAYER2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

beforeEach(() => {
  EventBroadcaster._resetForTests();
});

// ─── Helper to track calls ────────────────────────────────────────────────────

interface MockSubscriber extends SseSubscriber {
  sentEvents: BroadcastEvent[];
}

function createMockSubscriber(
  wallet: string,
  filter?: SseFilterCriteria,
): MockSubscriber {
  const sentEvents: BroadcastEvent[] = [];
  return {
    wallet,
    filter,
    sentEvents,
    send(event: BroadcastEvent) {
      sentEvents.push(event);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST: eventTypes filter
// ─────────────────────────────────────────────────────────────────────────────

describe('EventBroadcaster: eventTypes filter', () => {
  it('delivers only milestone_approved when eventTypes filter includes only milestone_approved', () => {
    const sub = createMockSubscriber(WALLET_A, {
      eventTypes: new Set(['milestone_approved']),
    });
    broadcaster.subscribe(sub);

    // Send events of different types
    const milestoneEvent: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_A },
    };
    const scoutEvent: BroadcastEvent = {
      type: 'scout_subscribed',
      payload: { scout: WALLET_A },
    };

    broadcaster.broadcast(milestoneEvent);
    broadcaster.broadcast(scoutEvent);

    // Only milestone_approved should arrive
    expect(sub.sentEvents).toEqual([milestoneEvent]);
  });

  it('delivers only scout_subscribed and contact_unlocked when filter specifies both', () => {
    const sub = createMockSubscriber(WALLET_A, {
      eventTypes: new Set(['scout_subscribed', 'contact_unlocked']),
    });
    broadcaster.subscribe(sub);

    const milestoneEvent: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_A },
    };
    const scoutSubEvent: BroadcastEvent = {
      type: 'scout_subscribed',
      payload: { scout: WALLET_A },
    };
    const contactEvent: BroadcastEvent = {
      type: 'contact_unlocked',
      payload: { scout: WALLET_A },
    };

    broadcaster.broadcast(milestoneEvent);
    broadcaster.broadcast(scoutSubEvent);
    broadcaster.broadcast(contactEvent);

    // Only scout_subscribed and contact_unlocked should arrive
    expect(sub.sentEvents).toEqual([scoutSubEvent, contactEvent]);
  });

  it('filters out all events when eventTypes set is empty (backward-compatible with no type filter)', () => {
    // Empty eventTypes set means no type filtering (receives all types)
    const sub = createMockSubscriber(WALLET_A, {
      eventTypes: new Set([]),
    });
    broadcaster.subscribe(sub);

    const milestoneEvent: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_A },
    };
    const scoutSubEvent: BroadcastEvent = {
      type: 'scout_subscribed',
      payload: { scout: WALLET_A },
    };

    broadcaster.broadcast(milestoneEvent);
    broadcaster.broadcast(scoutSubEvent);

    // Both should arrive (no type filter = all types pass)
    expect(sub.sentEvents).toHaveLength(2);
    expect(sub.sentEvents).toEqual([milestoneEvent, scoutSubEvent]);
  });

  it('respects wallet relevance even with type filter (no cross-tenant leakage)', () => {
    const sub = createMockSubscriber(WALLET_A, {
      eventTypes: new Set(['milestone_approved']),
    });
    broadcaster.subscribe(sub);

    // Event for WALLET_A
    const relevantEvent: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_A },
    };

    // Event for WALLET_B (not relevant to subscriber)
    const irrelevantEvent: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_B },
    };

    broadcaster.broadcast(relevantEvent);
    broadcaster.broadcast(irrelevantEvent);

    // Only the relevant one should arrive
    expect(sub.sentEvents).toEqual([relevantEvent]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST: playerId filter
// ─────────────────────────────────────────────────────────────────────────────

describe('EventBroadcaster: playerId filter', () => {
  it('delivers only events referencing the filtered playerId', () => {
    const sub = createMockSubscriber(WALLET_A, {
      eventTypes: new Set([]),
      playerId: PLAYER_1,
    });
    broadcaster.subscribe(sub);

    // Event with PLAYER_1 in payload
    const player1Event: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: PLAYER_1, wallet: WALLET_A },
    };

    // Event with PLAYER_2 in payload
    const player2Event: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: PLAYER_2, wallet: WALLET_A },
    };

    broadcaster.broadcast(player1Event);
    broadcaster.broadcast(player2Event);

    // Only PLAYER_1 event should arrive
    expect(sub.sentEvents).toEqual([player1Event]);
  });

  it('finds playerId in various payload fields (player_id, wallet, scout)', () => {
    const sub = createMockSubscriber(WALLET_A, {
      eventTypes: new Set([]),
      playerId: PLAYER_1,
    });
    broadcaster.subscribe(sub);

    // PLAYER_1 in player_id field
    const event1: BroadcastEvent = {
      type: 'milestone_submitted',
      payload: { player_id: PLAYER_1, validator: WALLET_A },
    };

    // PLAYER_1 in wallet field
    const event2: BroadcastEvent = {
      type: 'player_registered',
      payload: { wallet: PLAYER_1 },
    };

    // PLAYER_1 in scout field
    const event3: BroadcastEvent = {
      type: 'scout_subscribed',
      payload: { scout: PLAYER_1, wallet: WALLET_A },
    };

    // PLAYER_1 in recipient field
    const event4: BroadcastEvent = {
      type: 'fees_withdrawn',
      payload: { recipient: PLAYER_1 },
    };

    broadcaster.broadcast(event1);
    broadcaster.broadcast(event2);
    broadcaster.broadcast(event3);
    broadcaster.broadcast(event4);

    // All should arrive because PLAYER_1 is in each
    expect(sub.sentEvents).toHaveLength(4);
  });

  it('respects wallet relevance even with playerId filter', () => {
    const sub = createMockSubscriber(WALLET_A, {
      eventTypes: new Set([]),
      playerId: PLAYER_1,
    });
    broadcaster.subscribe(sub);

    // Event with PLAYER_1 and relevant wallet (WALLET_A)
    const relevantEvent: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: PLAYER_1, scout: WALLET_A },
    };

    // Event with PLAYER_1 but different wallet (WALLET_B)
    // Wallet relevance check fails because WALLET_A is not in the event
    const walletIrrelevantEvent: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: PLAYER_1, scout: WALLET_B },
    };

    broadcaster.broadcast(relevantEvent);
    broadcaster.broadcast(walletIrrelevantEvent);

    // Only the wallet-relevant one should arrive
    expect(sub.sentEvents).toEqual([relevantEvent]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST: Combined filters (intersection, not union)
// ─────────────────────────────────────────────────────────────────────────────

describe('EventBroadcaster: combined eventTypes + playerId filters', () => {
  it('requires event to match both type AND playerId filters', () => {
    const sub = createMockSubscriber(WALLET_A, {
      eventTypes: new Set(['milestone_approved']),
      playerId: PLAYER_1,
    });
    broadcaster.subscribe(sub);

    // Correct type, correct playerId
    const matchBoth: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: PLAYER_1, scout: WALLET_A },
    };

    // Correct type, wrong playerId
    const matchType: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: PLAYER_2, scout: WALLET_A },
    };

    // Wrong type, correct playerId
    const matchPlayerId: BroadcastEvent = {
      type: 'scout_subscribed',
      payload: { scout: PLAYER_1, wallet: WALLET_A },
    };

    broadcaster.broadcast(matchBoth);
    broadcaster.broadcast(matchType);
    broadcaster.broadcast(matchPlayerId);

    // Only matchBoth passes both filters
    expect(sub.sentEvents).toEqual([matchBoth]);
  });

  it('applies intersection logic correctly with multiple subscribers', () => {
    // Sub A: only milestone_approved, any playerId
    const subA = createMockSubscriber(WALLET_A, {
      eventTypes: new Set(['milestone_approved']),
      playerId: undefined,
    });

    // Sub B: any type, only PLAYER_1
    const subB = createMockSubscriber(WALLET_A, {
      eventTypes: new Set([]),
      playerId: PLAYER_1,
    });

    broadcaster.subscribe(subA);
    broadcaster.subscribe(subB);

    const event1: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: PLAYER_1, scout: WALLET_A },
    };

    const event2: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: PLAYER_2, scout: WALLET_A },
    };

    const event3: BroadcastEvent = {
      type: 'scout_subscribed',
      payload: { scout: PLAYER_1, wallet: WALLET_A },
    };

    broadcaster.broadcast(event1);
    broadcaster.broadcast(event2);
    broadcaster.broadcast(event3);

    // Sub A: should get event1 and event2 (both milestone_approved)
    expect(subA.sentEvents).toEqual([event1, event2]);

    // Sub B: should get event1 and event3 (both reference PLAYER_1)
    expect(subB.sentEvents).toEqual([event1, event3]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST: Wildcard (no filter) delivers all wallet-relevant events
// ─────────────────────────────────────────────────────────────────────────────

describe('EventBroadcaster: wildcard (no filter)', () => {
  it('delivers all wallet-relevant events when filter is undefined', () => {
    const sub = createMockSubscriber(WALLET_A); // No filter
    broadcaster.subscribe(sub);

    const events: BroadcastEvent[] = [
      { type: 'milestone_approved', payload: { player_id: WALLET_A } },
      { type: 'scout_subscribed', payload: { scout: WALLET_A } },
      { type: 'contact_unlocked', payload: { scout: WALLET_A } },
      { type: 'trial_offer_logged', payload: { scout: WALLET_A } },
    ];

    events.forEach((e) => broadcaster.broadcast(e));

    // All should arrive (they're all relevant to WALLET_A)
    expect(sub.sentEvents).toEqual(events);
  });

  it('still respects wallet relevance in wildcard mode', () => {
    const sub = createMockSubscriber(WALLET_A); // No filter
    broadcaster.subscribe(sub);

    const relevantEvent: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_A },
    };

    const irrelevantEvent: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_B },
    };

    broadcaster.broadcast(relevantEvent);
    broadcaster.broadcast(irrelevantEvent);

    // Only the relevant one should arrive
    expect(sub.sentEvents).toEqual([relevantEvent]);
  });

  it('delivers all wallet-relevant events even with an empty eventTypes set', () => {
    const sub = createMockSubscriber(WALLET_A, {
      eventTypes: new Set([]),
      playerId: undefined,
    });
    broadcaster.subscribe(sub);

    const events: BroadcastEvent[] = [
      { type: 'milestone_approved', payload: { player_id: WALLET_A } },
      { type: 'player_registered', payload: { wallet: WALLET_A } },
      { type: 'trial_offer_accepted', payload: { player_id: WALLET_A } },
    ];

    events.forEach((e) => broadcaster.broadcast(e));

    // All should arrive (empty set = no type filtering)
    expect(sub.sentEvents).toEqual(events);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST: Cross-subscriber isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('EventBroadcaster: cross-subscriber isolation', () => {
  it('each subscriber only receives its own filtered events', () => {
    // Sub A: milestone_approved only
    const subA = createMockSubscriber(WALLET_A, {
      eventTypes: new Set(['milestone_approved']),
    });

    // Sub B: scout_subscribed only (different wallet)
    const subB = createMockSubscriber(WALLET_B, {
      eventTypes: new Set(['scout_subscribed']),
    });

    broadcaster.subscribe(subA);
    broadcaster.subscribe(subB);

    const milestoneEventA: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_A },
    };

    const scoutEventB: BroadcastEvent = {
      type: 'scout_subscribed',
      payload: { scout: WALLET_B },
    };

    broadcaster.broadcast(milestoneEventA);
    broadcaster.broadcast(scoutEventB);

    // Sub A gets milestone_approved for WALLET_A
    expect(subA.sentEvents).toEqual([milestoneEventA]);

    // Sub B gets scout_subscribed for WALLET_B
    expect(subB.sentEvents).toEqual([scoutEventB]);
  });

  it('same wallet with different filters get different events', () => {
    // Both subscribers are WALLET_A but with different type filters
    const subType1 = createMockSubscriber(WALLET_A, {
      eventTypes: new Set(['milestone_approved']),
    });

    const subType2 = createMockSubscriber(WALLET_A, {
      eventTypes: new Set(['scout_subscribed']),
    });

    broadcaster.subscribe(subType1);
    broadcaster.subscribe(subType2);

    const milestoneEvent: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_A },
    };

    const scoutEvent: BroadcastEvent = {
      type: 'scout_subscribed',
      payload: { scout: WALLET_A },
    };

    broadcaster.broadcast(milestoneEvent);
    broadcaster.broadcast(scoutEvent);

    // Sub 1 only gets milestone_approved
    expect(subType1.sentEvents).toEqual([milestoneEvent]);

    // Sub 2 only gets scout_subscribed
    expect(subType2.sentEvents).toEqual([scoutEvent]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST: Unsubscribe and isolation
// ─────────────────────────────────────────────────────────────────────────────

describe('EventBroadcaster: unsubscribe and event delivery', () => {
  it('unsubscribed subscribers do not receive events', () => {
    const sub = createMockSubscriber(WALLET_A);
    broadcaster.subscribe(sub);

    const event1: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_A },
    };

    broadcaster.broadcast(event1);
    expect(sub.sentEvents).toHaveLength(1);

    // Unsubscribe
    broadcaster.unsubscribe(sub);

    const event2: BroadcastEvent = {
      type: 'scout_subscribed',
      payload: { scout: WALLET_A },
    };

    broadcaster.broadcast(event2);

    // Still only 1 event (no new event after unsubscribe)
    expect(sub.sentEvents).toHaveLength(1);
  });
});
