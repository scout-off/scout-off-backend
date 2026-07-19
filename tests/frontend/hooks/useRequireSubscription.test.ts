/**
 * Tests for useRequireSubscription hook (#685)
 *
 * Modelled on the structure used for useRequireWallet tests.
 *
 * Covers:
 *  - No redirect while loading is true
 *  - Redirect + toast when subscription is null (missing)
 *  - Redirect + toast when isExpired is true
 *  - Redirect + toast when active is false
 *  - No redirect when publicKey is falsy (delegated to useRequireWallet)
 *  - No redirect when subscription is active and not expired
 *  - Warning toast is shown alongside every redirect
 */
import {
  useRequireSubscription,
  SUBSCRIBE_PATH,
  SUBSCRIBE_TOAST_MESSAGE,
  type RequireSubscriptionDeps,
  type SubscriptionState,
} from '../../../src/frontend/hooks/useRequireSubscription';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<RequireSubscriptionDeps> = {}): RequireSubscriptionDeps & {
  redirect: jest.Mock;
  toast: jest.Mock;
} {
  const redirect = jest.fn();
  const toast    = jest.fn();
  return {
    subscription: null,
    loading: false,
    publicKey: 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3',
    redirect,
    toast,
    ...overrides,
  };
}

const ACTIVE_SUB: SubscriptionState = { active: true, isExpired: false };
const EXPIRED_SUB: SubscriptionState = { active: false, isExpired: true };
const INACTIVE_SUB: SubscriptionState = { active: false, isExpired: false };
const _PUBLIC_KEY = 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3';

// ─── Loading state ────────────────────────────────────────────────────────────

describe('loading state', () => {
  it('does NOT redirect while loading is true, even with no subscription', () => {
    const deps = makeDeps({ loading: true, subscription: null });
    useRequireSubscription(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
  });

  it('does NOT show a toast while loading is true', () => {
    const deps = makeDeps({ loading: true, subscription: null });
    useRequireSubscription(deps);
    expect(deps.toast).not.toHaveBeenCalled();
  });

  it('does NOT redirect while loading even when subscription is expired', () => {
    const deps = makeDeps({ loading: true, subscription: EXPIRED_SUB });
    useRequireSubscription(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
  });
});

// ─── No wallet — delegate to useRequireWallet ─────────────────────────────────

describe('no wallet (publicKey is falsy)', () => {
  it('does NOT redirect when publicKey is null', () => {
    const deps = makeDeps({ publicKey: null, subscription: null });
    useRequireSubscription(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
  });

  it('does NOT redirect when publicKey is empty string', () => {
    const deps = makeDeps({ publicKey: '', subscription: null });
    useRequireSubscription(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
  });

  it('does NOT show a toast when there is no wallet', () => {
    const deps = makeDeps({ publicKey: null, subscription: null });
    useRequireSubscription(deps);
    expect(deps.toast).not.toHaveBeenCalled();
  });

  it('does NOT redirect even when subscription is expired and there is no wallet', () => {
    const deps = makeDeps({ publicKey: null, subscription: EXPIRED_SUB });
    useRequireSubscription(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
  });
});

// ─── Missing subscription ─────────────────────────────────────────────────────

describe('missing subscription (null)', () => {
  it('redirects to the subscribe page when subscription is null', () => {
    const deps = makeDeps({ subscription: null });
    useRequireSubscription(deps);
    expect(deps.redirect).toHaveBeenCalledTimes(1);
    expect(deps.redirect).toHaveBeenCalledWith(SUBSCRIBE_PATH);
  });

  it('shows the warning toast when subscription is null', () => {
    const deps = makeDeps({ subscription: null });
    useRequireSubscription(deps);
    expect(deps.toast).toHaveBeenCalledTimes(1);
    expect(deps.toast).toHaveBeenCalledWith(SUBSCRIBE_TOAST_MESSAGE);
  });

  it('shows toast before (or together with) redirect — both called in same invocation', () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      subscription: null,
      redirect: jest.fn().mockImplementation(() => { callOrder.push('redirect'); }),
      toast:    jest.fn().mockImplementation(() => { callOrder.push('toast'); }),
    });
    useRequireSubscription(deps);
    expect(callOrder).toContain('redirect');
    expect(callOrder).toContain('toast');
  });
});

// ─── Expired subscription ─────────────────────────────────────────────────────

describe('expired subscription (isExpired: true)', () => {
  it('redirects when isExpired is true', () => {
    const deps = makeDeps({ subscription: EXPIRED_SUB });
    useRequireSubscription(deps);
    expect(deps.redirect).toHaveBeenCalledWith(SUBSCRIBE_PATH);
  });

  it('shows the warning toast when isExpired is true', () => {
    const deps = makeDeps({ subscription: EXPIRED_SUB });
    useRequireSubscription(deps);
    expect(deps.toast).toHaveBeenCalledWith(SUBSCRIBE_TOAST_MESSAGE);
  });
});

// ─── Inactive subscription (active: false, isExpired: false) ─────────────────

describe('inactive subscription (active: false, isExpired: false)', () => {
  it('redirects when subscription is inactive', () => {
    const deps = makeDeps({ subscription: INACTIVE_SUB });
    useRequireSubscription(deps);
    expect(deps.redirect).toHaveBeenCalledWith(SUBSCRIBE_PATH);
  });

  it('shows the warning toast when subscription is inactive', () => {
    const deps = makeDeps({ subscription: INACTIVE_SUB });
    useRequireSubscription(deps);
    expect(deps.toast).toHaveBeenCalledWith(SUBSCRIBE_TOAST_MESSAGE);
  });
});

// ─── Active subscription — no redirect ───────────────────────────────────────

describe('active subscription', () => {
  it('does NOT redirect when subscription is active and not expired', () => {
    const deps = makeDeps({ subscription: ACTIVE_SUB });
    useRequireSubscription(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
  });

  it('does NOT show a toast when subscription is active', () => {
    const deps = makeDeps({ subscription: ACTIVE_SUB });
    useRequireSubscription(deps);
    expect(deps.toast).not.toHaveBeenCalled();
  });
});

// ─── Redirect path and toast message constants ───────────────────────────────

describe('redirect path and toast message', () => {
  it('redirects to /subscribe specifically', () => {
    const deps = makeDeps({ subscription: null });
    useRequireSubscription(deps);
    expect(deps.redirect).toHaveBeenCalledWith('/subscribe');
  });

  it('SUBSCRIBE_PATH is /subscribe', () => {
    expect(SUBSCRIBE_PATH).toBe('/subscribe');
  });

  it('SUBSCRIBE_TOAST_MESSAGE is a non-empty string', () => {
    expect(typeof SUBSCRIBE_TOAST_MESSAGE).toBe('string');
    expect(SUBSCRIBE_TOAST_MESSAGE.length).toBeGreaterThan(0);
  });
});

// ─── Multiple invocations ─────────────────────────────────────────────────────

describe('idempotency across multiple invocations', () => {
  it('redirects every time it is called with a missing subscription', () => {
    const deps = makeDeps({ subscription: null });
    useRequireSubscription(deps);
    useRequireSubscription(deps);
    expect(deps.redirect).toHaveBeenCalledTimes(2);
  });

  it('never redirects across multiple calls when subscription is active', () => {
    const deps = makeDeps({ subscription: ACTIVE_SUB });
    useRequireSubscription(deps);
    useRequireSubscription(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
  });
});
