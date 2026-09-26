/** Regression coverage for the public Stellar barrel and focused modules. */
describe('Stellar service module wiring', () => {
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

  it('exposes operations from their focused modules through the compatibility barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const stellar = require('../../src/services/stellar');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const payments = require('../../src/services/stellarPayments');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const withdrawals = require('../../src/services/stellarWithdrawals');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const admin = require('../../src/services/stellarAdmin');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const profiles = require('../../src/services/stellarProfiles');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const milestones = require('../../src/services/stellarMilestones');

    expect(stellar.submitContactPayment).toBe(payments.submitContactPayment);
    expect(stellar.withdrawFees).toBe(withdrawals.withdrawFees);
    expect(stellar.pauseContractOnChain).toBe(admin.pauseContractOnChain);
    expect(stellar.updateProfile).toBe(profiles.updateProfile);
    expect(stellar.queryMilestones).toBe(milestones.queryMilestones);
  });
});
