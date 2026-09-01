/**
 * Regression coverage for src/services/stellar.ts module wiring.
 *
 * purchaseSubscription() previously had its closing brace dropped, which
 * left the following `export interface UpdateProfileResult` declaration
 * nested inside the function body. That's a parse error — the whole module
 * fails to compile, and every export downstream of purchaseSubscription
 * (including UpdateProfileResult and updateProfile) becomes unreachable.
 * This guards against that regression independently of any single
 * function's happy-path tests.
 */
describe('src/services/stellar.ts module wiring', () => {
  it('requires without throwing (the module parses and compiles cleanly)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(() => require('../../src/services/stellar')).not.toThrow();
  });

  it('exports purchaseSubscription and updateProfile as top-level functions', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stellar = require('../../src/services/stellar');
    expect(typeof stellar.purchaseSubscription).toBe('function');
    expect(typeof stellar.updateProfile).toBe('function');
  });
});
