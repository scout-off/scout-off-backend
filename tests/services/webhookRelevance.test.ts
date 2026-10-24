import {
  isEventRelevantToScout,
  isEventTypeSubscribed,
  isSubscriptionMatchingEvent,
  PUBLIC_EVENT_TYPES,
} from '../../src/services/webhookRelevance';

describe('webhookRelevance', () => {
  const SCOUT_A = 'GAWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const SCOUT_B = 'GBWALLETBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const PLAYER_ID = 'player_cuid_123';

  describe('PUBLIC_EVENT_TYPES', () => {
    it('contains safe public events', () => {
      expect(PUBLIC_EVENT_TYPES.has('player_registered')).toBe(true);
      expect(PUBLIC_EVENT_TYPES.has('milestone_approved')).toBe(true);
      expect(PUBLIC_EVENT_TYPES.has('player_deactivated')).toBe(true);
      expect(PUBLIC_EVENT_TYPES.has('player_reactivated')).toBe(true);
      expect(PUBLIC_EVENT_TYPES.has('contact_unlocked')).toBe(false);
      expect(PUBLIC_EVENT_TYPES.has('scout_subscribed')).toBe(false);
      expect(PUBLIC_EVENT_TYPES.has('trial_offer_logged')).toBe(false);
    });
  });

  describe('isEventRelevantToScout table-driven', () => {
    type TestCase = {
      description: string;
      eventType: string;
      payload: Record<string, unknown>;
      scoutWallet: string;
      expected: boolean;
    };

    const cases: TestCase[] = [
      // Safe public events are relevant to any scout
      {
        description: 'public player_registered is relevant to any scout',
        eventType: 'player_registered',
        payload: { player_id: PLAYER_ID, wallet: 'GPUBLICWALLET' },
        scoutWallet: SCOUT_A,
        expected: true,
      },
      {
        description: 'public milestone_approved is relevant to any scout',
        eventType: 'milestone_approved',
        payload: { player_id: PLAYER_ID, milestone_id: 1 },
        scoutWallet: SCOUT_A,
        expected: true,
      },
      {
        description: 'public player_deactivated is relevant to any scout',
        eventType: 'player_deactivated',
        payload: { player_id: PLAYER_ID },
        scoutWallet: SCOUT_A,
        expected: true,
      },
      {
        description: 'public player_reactivated is relevant to any scout',
        eventType: 'player_reactivated',
        payload: { player_id: PLAYER_ID },
        scoutWallet: SCOUT_A,
        expected: true,
      },

      // contact_unlocked: only for owning scout
      {
        description: 'contact_unlocked with matching scout',
        eventType: 'contact_unlocked',
        payload: { scout: SCOUT_A, player_id: PLAYER_ID },
        scoutWallet: SCOUT_A,
        expected: true,
      },
      {
        description: 'contact_unlocked for another scout is NOT relevant',
        eventType: 'contact_unlocked',
        payload: { scout: SCOUT_B, player_id: PLAYER_ID },
        scoutWallet: SCOUT_A,
        expected: false,
      },

      // scout_subscribed: only for owning scout
      {
        description: 'scout_subscribed with matching scout',
        eventType: 'scout_subscribed',
        payload: { scout: SCOUT_A, tier: 'basic' },
        scoutWallet: SCOUT_A,
        expected: true,
      },
      {
        description: 'scout_subscribed with other scout is NOT relevant',
        eventType: 'scout_subscribed',
        payload: { scout: SCOUT_B, tier: 'basic' },
        scoutWallet: SCOUT_A,
        expected: false,
      },

      // trial_offer_logged: only for offering scout
      {
        description: 'trial_offer_logged with matching scout',
        eventType: 'trial_offer_logged',
        payload: { scout: SCOUT_A, player_id: PLAYER_ID },
        scoutWallet: SCOUT_A,
        expected: true,
      },
      {
        description: 'trial_offer_logged with matching scout_wallet field',
        eventType: 'trial_offer_logged',
        payload: { scout_wallet: SCOUT_A, player_id: PLAYER_ID },
        scoutWallet: SCOUT_A,
        expected: true,
      },
      {
        description: 'trial_offer_logged for another scout is NOT relevant',
        eventType: 'trial_offer_logged',
        payload: { scout: SCOUT_B, player_id: PLAYER_ID },
        scoutWallet: SCOUT_A,
        expected: false,
      },

      // trial_offer_accepted / rejected: only for offering scout
      {
        description: 'trial_offer_accepted with matching scout',
        eventType: 'trial_offer_accepted',
        payload: { scout: SCOUT_A, offer_id: '1' },
        scoutWallet: SCOUT_A,
        expected: true,
      },
      {
        description: 'trial_offer_accepted for another scout is NOT relevant',
        eventType: 'trial_offer_accepted',
        payload: { scout: SCOUT_B, offer_id: '1' },
        scoutWallet: SCOUT_A,
        expected: false,
      },
      {
        description: 'trial_offer_rejected with matching scout',
        eventType: 'trial_offer_rejected',
        payload: { scout: SCOUT_A, offer_id: '1' },
        scoutWallet: SCOUT_A,
        expected: true,
      },
      {
        description: 'trial_offer_rejected for another scout is NOT relevant',
        eventType: 'trial_offer_rejected',
        payload: { scout: SCOUT_B, offer_id: '1' },
        scoutWallet: SCOUT_A,
        expected: false,
      },

      // milestone_submitted: not relevant unless scout is the validator
      {
        description: 'milestone_submitted with matching validator',
        eventType: 'milestone_submitted',
        payload: { validator: SCOUT_A, player_id: PLAYER_ID },
        scoutWallet: SCOUT_A,
        expected: true,
      },
      {
        description: 'milestone_submitted with another validator is NOT relevant',
        eventType: 'milestone_submitted',
        payload: { validator: SCOUT_B, player_id: PLAYER_ID },
        scoutWallet: SCOUT_A,
        expected: false,
      },

      // fees_withdrawn: not relevant unless recipient matches
      {
        description: 'fees_withdrawn with matching recipient',
        eventType: 'fees_withdrawn',
        payload: { recipient: SCOUT_A, amount: '100' },
        scoutWallet: SCOUT_A,
        expected: true,
      },
      {
        description: 'fees_withdrawn with other recipient is NOT relevant',
        eventType: 'fees_withdrawn',
        payload: { recipient: SCOUT_B, amount: '100' },
        scoutWallet: SCOUT_A,
        expected: false,
      },

      // Empty scoutWallet behaves as global / wildcard
      {
        description: 'empty scout wallet receives any event',
        eventType: 'contact_unlocked',
        payload: { scout: SCOUT_B },
        scoutWallet: '',
        expected: true,
      },
    ];

    test.each(cases)('$description', ({ eventType, payload, scoutWallet, expected }) => {
      expect(isEventRelevantToScout(eventType, payload, scoutWallet)).toBe(expected);
    });
  });

  describe('isEventTypeSubscribed', () => {
    it('returns true when event_types is null or empty', () => {
      expect(isEventTypeSubscribed(null, 'milestone_approved')).toBe(true);
      expect(isEventTypeSubscribed(undefined, 'milestone_approved')).toBe(true);
      expect(isEventTypeSubscribed('', 'milestone_approved')).toBe(true);
      expect(isEventTypeSubscribed('[]', 'milestone_approved')).toBe(true);
      expect(isEventTypeSubscribed([], 'milestone_approved')).toBe(true);
    });

    it('returns true when eventType is in the array or json string', () => {
      expect(isEventTypeSubscribed(['milestone_approved', 'contact_unlocked'], 'milestone_approved')).toBe(true);
      expect(isEventTypeSubscribed(JSON.stringify(['milestone_approved']), 'milestone_approved')).toBe(true);
    });

    it('returns false when eventType is not in the array or json string', () => {
      expect(isEventTypeSubscribed(['milestone_approved'], 'contact_unlocked')).toBe(false);
      expect(isEventTypeSubscribed(JSON.stringify(['milestone_approved']), 'contact_unlocked')).toBe(false);
    });
  });

  describe('isSubscriptionMatchingEvent', () => {
    it('delivers all events to admin subscriptions (no scout_wallet and null event_types)', () => {
      const sub = { scout_wallet: null, event_types: null };
      expect(isSubscriptionMatchingEvent(sub, 'contact_unlocked', { scout: SCOUT_B })).toBe(true);
      expect(isSubscriptionMatchingEvent(sub, 'milestone_approved', {})).toBe(true);
    });

    it('filters admin subscription by event_types if configured', () => {
      const sub = { scout_wallet: null, event_types: JSON.stringify(['milestone_approved']) };
      expect(isSubscriptionMatchingEvent(sub, 'milestone_approved', {})).toBe(true);
      expect(isSubscriptionMatchingEvent(sub, 'contact_unlocked', { scout: SCOUT_B })).toBe(false);
    });

    it('filters scout subscription by both event_types and scout relevance', () => {
      const sub = {
        scout_wallet: SCOUT_A,
        event_types: JSON.stringify(['contact_unlocked', 'milestone_approved']),
      };

      // Matched type and matched scout
      expect(isSubscriptionMatchingEvent(sub, 'contact_unlocked', { scout: SCOUT_A })).toBe(true);

      // Matched type but other scout -> rejected (no leak!)
      expect(isSubscriptionMatchingEvent(sub, 'contact_unlocked', { scout: SCOUT_B })).toBe(false);

      // Matched type and safe public event
      expect(isSubscriptionMatchingEvent(sub, 'milestone_approved', { player_id: PLAYER_ID })).toBe(true);

      // Non-subscribed type even if public
      expect(isSubscriptionMatchingEvent(sub, 'player_registered', { player_id: PLAYER_ID })).toBe(false);
    });
  });
});
