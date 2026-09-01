/**
 * useRequireWallet
 *
 * Access-guard hook that redirects to the wallet-connection page when no
 * Stellar wallet is connected.  This is the companion hook to
 * useRequireSubscription and is referenced as the model for its test structure.
 *
 * Implemented as a plain TypeScript function (no React dependency) so it can
 * be exercised in the backend Jest environment without a DOM.
 */

export interface RequireWalletDeps {
  /** Current connected wallet public key, or null when disconnected. */
  publicKey: string | null;
  /** True while the wallet connection state is being resolved. */
  loading: boolean;
  /** Called when a redirect should happen (e.g. router.push). */
  redirect: (path: string) => void;
  /** Called to surface a warning toast to the user. */
  toast: (message: string) => void;
}

/**
 * Enforces that a wallet is connected before the caller proceeds.
 *
 * - While `loading` is true: no-op (wait for resolution).
 * - When `publicKey` is falsy after loading: redirect to '/connect' + show toast.
 * - When `publicKey` is present: no-op (wallet is connected).
 */
export function useRequireWallet(deps: RequireWalletDeps): void {
  const { publicKey, loading, redirect, toast } = deps;
  if (loading) return;
  if (!publicKey) {
    toast('Please connect your Stellar wallet to continue.');
    redirect('/connect');
  }
}
