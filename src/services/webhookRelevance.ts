import { ContractEventType } from '../types';

/**
 * Public events that carry only public data and are safe to broadcast
 * to any scout subscription regardless of wallet identity.
 */
export const PUBLIC_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'player_registered',
  'milestone_approved',
  'player_deactivated',
  'player_reactivated',
]);

/**
 * Determines whether a contract event is relevant to a given wallet and/or player ID.
 *
 * Rules:
 *  milestone_approved  → relevant when payload.player_id matches the player ID,
 *                        or payload.wallet matches the wallet, or payload.scout matches.
 *  scout_subscribed    → relevant when payload.scout or payload.wallet matches.
 *  contact_unlocked    → relevant when payload.scout or payload.wallet matches.
 *  trial_offer_logged  → relevant when payload.scout (or scout_wallet) matches, or payload.player_id matches.
 *  trial_offer_accepted / rejected → relevant when payload.scout (or scout_wallet) matches, or payload.player_id matches.
 *  player_registered   → relevant when payload.wallet matches, or payload.player_id matches.
 *  milestone_submitted → relevant when payload.player_id matches, or payload.validator matches.
 *  fees_withdrawn      → relevant when payload.recipient matches, or payload.wallet matches.
 *  player_deactivated  → relevant when payload.player_id matches, or payload.wallet matches, or payload.scout_wallet matches.
 *  player_reactivated  → relevant when payload.player_id matches, or payload.wallet matches.
 */
export function isEventRelevantToWallet(
  event: { type: ContractEventType | string; payload: Record<string, unknown> },
  wallet: string,
  playerId?: string,
): boolean {
  const p = event.payload;

  switch (event.type) {
    case 'milestone_approved':
      return (
        (playerId !== undefined && p.player_id === playerId) ||
        p.wallet === wallet ||
        p.scout === wallet
      );

    case 'scout_subscribed':
      return p.scout === wallet || p.wallet === wallet;

    case 'contact_unlocked':
      return p.scout === wallet || p.wallet === wallet;

    case 'trial_offer_logged':
      return (
        p.scout === wallet ||
        p.scout_wallet === wallet ||
        (playerId !== undefined && p.player_id === playerId)
      );

    case 'trial_offer_accepted':
    case 'trial_offer_rejected':
      return (
        p.scout === wallet ||
        p.scout_wallet === wallet ||
        (playerId !== undefined && p.player_id === playerId)
      );

    case 'player_registered':
      return p.wallet === wallet || (playerId !== undefined && p.player_id === playerId);

    case 'milestone_submitted':
      return (playerId !== undefined && p.player_id === playerId) || p.validator === wallet;

    case 'fees_withdrawn':
      return p.recipient === wallet || p.wallet === wallet;

    case 'player_deactivated':
      return (
        (playerId !== undefined && p.player_id === playerId) ||
        p.wallet === wallet ||
        p.scout_wallet === wallet
      );

    case 'player_reactivated':
      return (playerId !== undefined && p.player_id === playerId) || p.wallet === wallet;

    default:
      return false;
  }
}

/**
 * Checks whether an event is relevant to a specific scout webhook subscriber.
 *
 * Requirements (#1309):
 *  1. Public events deemed safe ('player_registered', 'milestone_approved',
 *     'player_deactivated', 'player_reactivated') are delivered to all scouts.
 *  2. Scout-specific events ('contact_unlocked', 'scout_subscribed', 'trial_offer_logged',
 *     'trial_offer_accepted', 'trial_offer_rejected') are ONLY delivered if they belong
 *     to that scout (payload.scout === scoutWallet || payload.scout_wallet === scoutWallet).
 *  3. Admin / validator events ('fees_withdrawn', 'milestone_submitted') are delivered
 *     only if explicitly associated with that scout.
 *
 * @param eventType - Contract event type name
 * @param payload - Event payload
 * @param scoutWallet - The subscribing scout's Stellar address
 */
export function isEventRelevantToScout(
  eventType: string,
  payload: unknown,
  scoutWallet: string,
): boolean {
  if (!scoutWallet) return true;

  if (PUBLIC_EVENT_TYPES.has(eventType)) {
    return true;
  }

  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

  return isEventRelevantToWallet({ type: eventType, payload: p }, scoutWallet);
}

/**
 * Checks whether a subscription's event_types filter allows a given event type.
 * A null or empty array / empty string allows all event types.
 */
export function isEventTypeSubscribed(
  eventTypesJsonOrArray: string | string[] | null | undefined,
  eventType: string,
): boolean {
  if (!eventTypesJsonOrArray) return true;

  let types: string[];
  if (Array.isArray(eventTypesJsonOrArray)) {
    types = eventTypesJsonOrArray;
  } else if (typeof eventTypesJsonOrArray === 'string') {
    try {
      const parsed = JSON.parse(eventTypesJsonOrArray);
      if (!Array.isArray(parsed) || parsed.length === 0) return true;
      types = parsed;
    } catch {
      return true;
    }
  } else {
    return true;
  }

  if (types.length === 0) return true;
  return types.includes(eventType);
}

/**
 * Checks whether a webhook subscription matches an event by both event type and scout relevance.
 * Admin-created subscriptions (where scout_wallet is null/empty) have global delivery
 * (subject only to event_types filtering).
 */
export function isSubscriptionMatchingEvent(
  subscription: {
    event_types?: string | string[] | null;
    scout_wallet?: string | null;
  },
  eventType: string,
  payload: unknown,
): boolean {
  if (!isEventTypeSubscribed(subscription.event_types, eventType)) {
    return false;
  }

  if (subscription.scout_wallet) {
    return isEventRelevantToScout(eventType, payload, subscription.scout_wallet);
  }

  return true;
}

