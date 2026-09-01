/**
 * useRequireSubscription
 *
 * Access-guard hook that redirects to the subscription page when a scout does
 * not hold an active, non-expired subscription.  Guards subscriber-only pages
 * (e.g. advanced player search, contact unlock).
 *
 * Implemented as a plain TypeScript function (no React dependency) so it can
 * be exercised in the backend Jest environment without a DOM.
 *
 * Relationship to useRequireWallet:
 *   This hook delegates the "no wallet" case to useRequireWallet — if
 *   `publicKey` is falsy, this hook is a no-op and the caller is expected to
 *   have useRequireWallet running separately.  This prevents double-redirects
 *   on pages that compose both guards.
 */

export interface SubscriptionState {
  /** Whether the subscription is currently active. */
  active: boolean;
  /** Whether the subscription has expired (active may still be true in grace period). */
  isExpired: boolean;
}

export interface RequireSubscriptionDeps {
  /**
   * Current subscription state, or null when the scout has no subscription.
   * When null, the hook treats it as "missing" and redirects.
   */
  subscription: SubscriptionState | null;
  /** True while subscription data is being fetched. */
  loading: boolean;
  /**
   * Currently connected wallet public key.
   * When falsy, this hook is a no-op — the wallet guard handles that case.
   */
  publicKey: string | null;
  /** Called when a redirect should happen (e.g. router.push). */
  redirect: (path: string) => void;
  /** Called to surface a warning toast to the user. */
  toast: (message: string) => void;
}

/** Path scouts are sent to when they need a subscription. */
export const SUBSCRIBE_PATH = '/subscribe';
export const SUBSCRIBE_TOAST_MESSAGE = 'An active subscription is required to access this page.';

/**
 * Enforces that the authenticated scout holds an active, non-expired
 * subscription before the caller proceeds.
 *
 * Behaviour matrix:
 * | loading | publicKey | subscription           | Result          |
 * |---------|-----------|------------------------|-----------------|
 * | true    | any       | any                    | no-op (wait)    |
 * | false   | falsy     | any                    | no-op (delegate)|
 * | false   | truthy    | null                   | redirect + toast|
 * | false   | truthy    | { active:F, expired:T }| redirect + toast|
 * | false   | truthy    | { active:T, expired:F }| no-op (allowed) |
 */
export function useRequireSubscription(deps: RequireSubscriptionDeps): void {
  const { subscription, loading, publicKey, redirect, toast } = deps;

  // 1. Still loading — do nothing until we have a definitive answer.
  if (loading) return;

  // 2. No wallet — delegate to useRequireWallet; don't redirect here.
  if (!publicKey) return;

  // 3. Missing subscription or expired — block access.
  if (!subscription || subscription.isExpired || !subscription.active) {
    toast(SUBSCRIBE_TOAST_MESSAGE);
    redirect(SUBSCRIBE_PATH);
  }
}
