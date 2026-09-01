/**
 * Tests for useRequireWallet hook (#718)
 *
 * Covers:
 *  - No redirect while loading is true
 *  - Redirect + toast when publicKey is null (wallet absent)
 *  - Redirect + toast when publicKey is empty string (wallet absent)
 *  - No redirect when publicKey is present (wallet connected)
 *  - Warning toast is shown alongside every redirect
 *  - Redirect destination is '/connect'
 */
import {
  useRequireWallet,
  type RequireWalletDeps,
} from '../../../src/frontend/hooks/useRequireWallet';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<RequireWalletDeps> = {}): RequireWalletDeps & {
  redirect: jest.Mock;
  toast: jest.Mock;
} {
  const redirect = jest.fn();
  const toast    = jest.fn();
  return {
    publicKey: 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3',
    loading: false,
    redirect,
    toast,
    ...overrides,
  };
}

const CONNECT_PATH = '/connect';
const WALLET_TOAST = 'Please connect your Stellar wallet to continue.';

// ─── Loading state ────────────────────────────────────────────────────────────

describe('loading state', () => {
  it('does NOT redirect while loading is true, even with no wallet', () => {
    const deps = makeDeps({ loading: true, publicKey: null });
    useRequireWallet(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
  });

  it('does NOT show a toast while loading is true', () => {
    const deps = makeDeps({ loading: true, publicKey: null });
    useRequireWallet(deps);
    expect(deps.toast).not.toHaveBeenCalled();
  });

  it('does NOT redirect while loading even when publicKey is present', () => {
    const deps = makeDeps({
      loading: true,
      publicKey: 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3',
    });
    useRequireWallet(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
  });
});

// ─── Wallet absent ────────────────────────────────────────────────────────────

describe('wallet absent (publicKey is null)', () => {
  it('redirects to /connect when publicKey is null', () => {
    const deps = makeDeps({ publicKey: null });
    useRequireWallet(deps);
    expect(deps.redirect).toHaveBeenCalledTimes(1);
    expect(deps.redirect).toHaveBeenCalledWith(CONNECT_PATH);
  });

  it('shows the warning toast when publicKey is null', () => {
    const deps = makeDeps({ publicKey: null });
    useRequireWallet(deps);
    expect(deps.toast).toHaveBeenCalledTimes(1);
    expect(deps.toast).toHaveBeenCalledWith(WALLET_TOAST);
  });

  it('shows toast and redirect in the same invocation when wallet is null', () => {
    const callOrder: string[] = [];
    const deps = makeDeps({
      publicKey: null,
      redirect: jest.fn().mockImplementation(() => { callOrder.push('redirect'); }),
      toast:    jest.fn().mockImplementation(() => { callOrder.push('toast'); }),
    });
    useRequireWallet(deps);
    expect(callOrder).toContain('redirect');
    expect(callOrder).toContain('toast');
  });
});

describe('wallet absent (publicKey is empty string)', () => {
  it('redirects to /connect when publicKey is empty string', () => {
    const deps = makeDeps({ publicKey: '' });
    useRequireWallet(deps);
    expect(deps.redirect).toHaveBeenCalledWith(CONNECT_PATH);
  });

  it('shows the warning toast when publicKey is empty string', () => {
    const deps = makeDeps({ publicKey: '' });
    useRequireWallet(deps);
    expect(deps.toast).toHaveBeenCalledWith(WALLET_TOAST);
  });
});

// ─── Wallet present ───────────────────────────────────────────────────────────

describe('wallet present (publicKey is set)', () => {
  it('does NOT redirect when publicKey is a valid Stellar address', () => {
    const deps = makeDeps({
      publicKey: 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3',
    });
    useRequireWallet(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
  });

  it('does NOT show a toast when wallet is connected', () => {
    const deps = makeDeps({
      publicKey: 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3',
    });
    useRequireWallet(deps);
    expect(deps.toast).not.toHaveBeenCalled();
  });

  it('does NOT redirect for any truthy publicKey value', () => {
    const deps = makeDeps({ publicKey: 'GSOME_OTHER_KEY' });
    useRequireWallet(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
    expect(deps.toast).not.toHaveBeenCalled();
  });
});

// ─── Redirect path ────────────────────────────────────────────────────────────

describe('redirect path', () => {
  it('always redirects to /connect specifically', () => {
    const deps = makeDeps({ publicKey: null });
    useRequireWallet(deps);
    expect(deps.redirect).toHaveBeenCalledWith('/connect');
  });
});

// ─── Multiple invocations ─────────────────────────────────────────────────────

describe('idempotency across multiple invocations', () => {
  it('redirects every time it is called with wallet absent', () => {
    const deps = makeDeps({ publicKey: null });
    useRequireWallet(deps);
    useRequireWallet(deps);
    expect(deps.redirect).toHaveBeenCalledTimes(2);
  });

  it('never redirects across multiple calls when wallet is present', () => {
    const deps = makeDeps({
      publicKey: 'GAAKO6EK5AIJWZH7ITXBFZTPASYKPY3YVMFVFVD5UDG2C6NUIXTT7BE3',
    });
    useRequireWallet(deps);
    useRequireWallet(deps);
    expect(deps.redirect).not.toHaveBeenCalled();
  });
});
