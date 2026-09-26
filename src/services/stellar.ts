/**
 * Backwards-compatible public entrypoint for Stellar service operations.
 * Implementations live in focused modules; existing imports from this file
 * continue to work.
 */
export * from './stellarCore';
export * from './stellarPayments';
export * from './stellarWithdrawals';
export * from './stellarAdmin';
export * from './stellarProfiles';
export * from './stellarMilestones';
