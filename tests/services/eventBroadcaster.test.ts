/**
 * Unit tests for src/services/eventBroadcaster.ts
 *
 * Coverage:
 *   - isEventRelevantToWallet: all event types, positive and negative cases
 *   - EventBroadcaster.subscribe / broadcast / unsubscribe lifecycle
 *   - No cross-subscriber leakage (each subscriber receives only its own events)
 *   - subscriberCount bookkeeping
 *   - _resetForTests isolation helper
 */

import {
  EventBroadcaster,
  isEventRelevantToWallet,
  BroadcastEvent,
  SseSubscriber,
} from '../../src/services/eventBroadcaster';

const WALLET_A = 'GAWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET_B = 'GAWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const WALLET_C = 'GAWALLETCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

beforeEach(() => {
  EventBroadcaster._resetForTests();
});

// ─── isEventRelevantToWallet ──────────────────────────────────────────────────

describe('isEventRelevantToWallet', () => {
  describe('milestone_approved', () => {
    it('returns true when player_id matches wallet', () => {
      expect(isEventRelevantToWallet(
        { type: 'milestone_approved', payload: { player_id: WALLET_A } },
        WALLET_A,
      )).toBe(true);
    });

    it('returns false when player_id is a different wallet', () => {
      expect(isEventRelevantToWallet(
        { type: 'milestone_approved', payload: { player_id: WALLET_B } },
        WALLET_A,
      )).toBe(false);
    });

    it('returns true when payload.wallet matches', () => {
      expect(isEventRelevantToWallet(
        { type: 'milestone_approved', payload: { player_id: 'p1', wallet: WALLET_A } },
        WALLET_A,
      )).toBe(true);
    });
  });

  describe('scout_subscribed', () => {
    it('returns true when scout matches wallet', () => {
      expect(isEventRelevantToWallet(
        { type: 'scout_subscribed', payload: { scout: WALLET_A, tier: 'premium' } },
        WALLET_A,
      )).toBe(true);
    });

    it('returns false when scout is a different wallet', () => {
      expect(isEventRelevantToWallet(
        { type: 'scout_subscribed', payload: { scout: WALLET_B } },
        WALLET_A,
      )).toBe(false);
    });

    it('returns true when payload.wallet matches (alternate field)', () => {
      expect(isEventRelevantToWallet(
        { type: 'scout_subscribed', payload: { wallet: WALLET_A } },
        WALLET_A,
      )).toBe(true);
    });
  });

  describe('contact_unlocked', () => {
    it('returns true when scout matches wallet', () => {
      expect(isEventRelevantToWallet(
        { type: 'contact_unlocked', payload: { scout: WALLET_A, player_id: 'p1' } },
        WALLET_A,
      )).toBe(true);
    });

    it('returns false when scout does not match', () => {
      expect(isEventRelevantToWallet(
        { type: 'contact_unlocked', payload: { scout: WALLET_B, player_id: 'p1' } },
        WALLET_A,
      )).toBe(false);
    });
  });

  describe('trial_offer_logged', () => {
    it('returns true when scout matches wallet', () => {
      expect(isEventRelevantToWallet(
        { type: 'trial_offer_logged', payload: { scout: WALLET_A, player_id: WALLET_B } },
        WALLET_A,
      )).toBe(true);
    });

    it('returns true when player_id matches wallet', () => {
      expect(isEventRelevantToWallet(
        { type: 'trial_offer_logged', payload: { scout: WALLET_A, player_id: WALLET_B } },
        WALLET_B,
      )).toBe(true);
    });

    it('returns false for an unrelated wallet', () => {
      expect(isEventRelevantToWallet(
        { type: 'trial_offer_logged', payload: { scout: WALLET_A, player_id: WALLET_B } },
        WALLET_C,
      )).toBe(false);
    });
  });

  describe('player_registered', () => {
    it('returns true when wallet matches', () => {
      expect(isEventRelevantToWallet(
        { type: 'player_registered', payload: { wallet: WALLET_A, player_id: 'p1' } },
        WALLET_A,
      )).toBe(true);
    });

    it('returns true when player_id matches', () => {
      expect(isEventRelevantToWallet(
        { type: 'player_registered', payload: { wallet: WALLET_B, player_id: WALLET_A } },
        WALLET_A,
      )).toBe(true);
    });

    it('returns false for unrelated wallet', () => {
      expect(isEventRelevantToWallet(
        { type: 'player_registered', payload: { wallet: WALLET_B, player_id: 'p1' } },
        WALLET_A,
      )).toBe(false);
    });
  });

  describe('milestone_submitted', () => {
    it('returns true when player_id matches', () => {
      expect(isEventRelevantToWallet(
        { type: 'milestone_submitted', payload: { player_id: WALLET_A, validator: WALLET_B } },
        WALLET_A,
      )).toBe(true);
    });

    it('returns true when validator matches', () => {
      expect(isEventRelevantToWallet(
        { type: 'milestone_submitted', payload: { player_id: WALLET_A, validator: WALLET_B } },
        WALLET_B,
      )).toBe(true);
    });

    it('returns false for unrelated wallet', () => {
      expect(isEventRelevantToWallet(
        { type: 'milestone_submitted', payload: { player_id: WALLET_A, validator: WALLET_B } },
        WALLET_C,
      )).toBe(false);
    });
  });

  describe('fees_withdrawn', () => {
    it('returns true when recipient matches', () => {
      expect(isEventRelevantToWallet(
        { type: 'fees_withdrawn', payload: { recipient: WALLET_A, amount: '100' } },
        WALLET_A,
      )).toBe(true);
    });

    it('returns true when wallet field matches', () => {
      expect(isEventRelevantToWallet(
        { type: 'fees_withdrawn', payload: { wallet: WALLET_A, amount: '100' } },
        WALLET_A,
      )).toBe(true);
    });

    it('returns false for unrelated wallet', () => {
      expect(isEventRelevantToWallet(
        { type: 'fees_withdrawn', payload: { recipient: WALLET_B, amount: '100' } },
        WALLET_A,
      )).toBe(false);
    });
  });
});

// ─── EventBroadcaster lifecycle ───────────────────────────────────────────────

describe('EventBroadcaster', () => {
  function makeSub(wallet: string): SseSubscriber & { received: BroadcastEvent[] } {
    const received: BroadcastEvent[] = [];
    const sub: SseSubscriber & { received: BroadcastEvent[] } = {
      wallet,
      received,
      send(event: BroadcastEvent) { received.push(event); },
    };
    return sub;
  }

  it('getInstance returns the same singleton each time', () => {
    const a = EventBroadcaster.getInstance();
    const b = EventBroadcaster.getInstance();
    expect(a).toBe(b);
  });

  it('subscriberCount starts at 0', () => {
    expect(EventBroadcaster.getInstance().subscriberCount).toBe(0);
  });

  it('subscriberCount increments on subscribe', () => {
    const inst = EventBroadcaster.getInstance();
    const sub = makeSub(WALLET_A);
    inst.subscribe(sub);
    expect(inst.subscriberCount).toBe(1);
    inst.unsubscribe(sub);
  });

  it('subscriberCount decrements on unsubscribe', () => {
    const inst = EventBroadcaster.getInstance();
    const sub = makeSub(WALLET_A);
    inst.subscribe(sub);
    inst.unsubscribe(sub);
    expect(inst.subscriberCount).toBe(0);
  });

  it('delivers a relevant event to a subscriber', () => {
    const inst = EventBroadcaster.getInstance();
    const sub = makeSub(WALLET_A);
    inst.subscribe(sub);

    const event: BroadcastEvent = {
      type: 'milestone_approved',
      payload: { player_id: WALLET_A },
    };
    inst.broadcast(event);

    expect(sub.received).toHaveLength(1);
    expect(sub.received[0]).toEqual(event);
    inst.unsubscribe(sub);
  });

  it('does NOT deliver an irrelevant event to a subscriber', () => {
    const inst = EventBroadcaster.getInstance();
    const sub = makeSub(WALLET_A);
    inst.subscribe(sub);

    inst.broadcast({
      type: 'milestone_approved',
      payload: { player_id: WALLET_B }, // different wallet
    });

    expect(sub.received).toHaveLength(0);
    inst.unsubscribe(sub);
  });

  it('delivers to WALLET_A and not WALLET_B when both are subscribed', () => {
    const inst = EventBroadcaster.getInstance();
    const subA = makeSub(WALLET_A);
    const subB = makeSub(WALLET_B);
    inst.subscribe(subA);
    inst.subscribe(subB);

    inst.broadcast({
      type: 'scout_subscribed',
      payload: { scout: WALLET_A },
    });

    expect(subA.received).toHaveLength(1);
    expect(subB.received).toHaveLength(0);

    inst.unsubscribe(subA);
    inst.unsubscribe(subB);
  });

  it('delivers to both subscribers when both are relevant', () => {
    const inst = EventBroadcaster.getInstance();
    const subA = makeSub(WALLET_A);
    const subB = makeSub(WALLET_B);
    inst.subscribe(subA);
    inst.subscribe(subB);

    inst.broadcast({
      type: 'trial_offer_logged',
      payload: { scout: WALLET_A, player_id: WALLET_B },
    });

    expect(subA.received).toHaveLength(1);
    expect(subB.received).toHaveLength(1);

    inst.unsubscribe(subA);
    inst.unsubscribe(subB);
  });

  it('does not deliver events to a subscriber after unsubscribe', () => {
    const inst = EventBroadcaster.getInstance();
    const sub = makeSub(WALLET_A);
    inst.subscribe(sub);
    inst.unsubscribe(sub);

    inst.broadcast({
      type: 'milestone_approved',
      payload: { player_id: WALLET_A },
    });

    expect(sub.received).toHaveLength(0);
  });

  it('handles multiple broadcasts correctly', () => {
    const inst = EventBroadcaster.getInstance();
    const sub = makeSub(WALLET_A);
    inst.subscribe(sub);

    inst.broadcast({ type: 'milestone_approved', payload: { player_id: WALLET_A } });
    inst.broadcast({ type: 'scout_subscribed', payload: { scout: WALLET_A } });
    inst.broadcast({ type: 'contact_unlocked', payload: { scout: WALLET_A, player_id: 'p1' } });
    inst.broadcast({ type: 'player_registered', payload: { wallet: WALLET_B } }); // irrelevant

    expect(sub.received).toHaveLength(3);
    inst.unsubscribe(sub);
  });

  it('handles a subscriber whose send() throws without crashing', () => {
    const inst = EventBroadcaster.getInstance();
    const throwingSub: SseSubscriber = {
      wallet: WALLET_A,
      send() { throw new Error('stream closed'); },
    };
    inst.subscribe(throwingSub);

    expect(() => {
      inst.broadcast({ type: 'milestone_approved', payload: { player_id: WALLET_A } });
    }).not.toThrow();

    inst.unsubscribe(throwingSub);
  });

  it('_resetForTests gives a fresh instance', () => {
    const inst1 = EventBroadcaster.getInstance();
    const sub = makeSub(WALLET_A);
    inst1.subscribe(sub);
    expect(inst1.subscriberCount).toBe(1);

    EventBroadcaster._resetForTests();
    const inst2 = EventBroadcaster.getInstance();
    expect(inst2.subscriberCount).toBe(0);
    expect(inst2).not.toBe(inst1);
  });
});
