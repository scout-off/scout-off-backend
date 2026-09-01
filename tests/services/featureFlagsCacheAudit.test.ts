import {
  clearFeatureFlagCache,
  isFeatureEnabled,
  setFeatureFlag,
} from '../../src/services/featureFlags';
import * as db from '../../src/db';
import * as audit from '../../src/services/audit';

describe('featureFlags cache and audit behaviour', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    clearFeatureFlagCache();
  });

  it('reads the DB on the first call and caches the result', async () => {
    const getFeatureFlag = jest.spyOn(db, 'getFeatureFlag').mockResolvedValue({
      name: 'saved_searches',
      enabled: 1,
      updated_at: Date.now(),
      updated_by: 'seed',
    });

    expect(await isFeatureEnabled('saved_searches')).toBe(true);
    expect(getFeatureFlag).toHaveBeenCalledTimes(1);
  });

  it('does not hit the DB again on a cache hit', async () => {
    const getFeatureFlag = jest.spyOn(db, 'getFeatureFlag').mockResolvedValue({
      name: 'saved_searches',
      enabled: 1,
      updated_at: Date.now(),
      updated_by: 'seed',
    });

    await isFeatureEnabled('saved_searches');
    await isFeatureEnabled('saved_searches');

    expect(getFeatureFlag).toHaveBeenCalledTimes(1);
  });

  it('refreshes the cache synchronously on setFeatureFlag', async () => {
    jest.spyOn(db, 'getFeatureFlag').mockResolvedValue(null);
    jest.spyOn(db, 'upsertFeatureFlag').mockResolvedValue(undefined);
    jest.spyOn(audit, 'logAuditEvent').mockResolvedValue(undefined);

    await setFeatureFlag('player_tokens', true, 'admin-wallet');

    // Cache is refreshed synchronously — no further DB read needed.
    const getFeatureFlag = jest.spyOn(db, 'getFeatureFlag');
    const callsBefore = getFeatureFlag.mock.calls.length;
    expect(await isFeatureEnabled('player_tokens')).toBe(true);
    expect(getFeatureFlag.mock.calls.length).toBe(callsBefore);
  });

  it('emits a feature_flag_toggled audit event carrying old_value and new_value', async () => {
    jest.spyOn(db, 'getFeatureFlag').mockResolvedValue({
      name: 'graphql_enabled',
      enabled: 0,
      updated_at: Date.now(),
      updated_by: 'seed',
    });
    jest.spyOn(db, 'upsertFeatureFlag').mockResolvedValue(undefined);
    const logAuditEvent = jest.spyOn(audit, 'logAuditEvent').mockResolvedValue(undefined);

    await setFeatureFlag('graphql_enabled', true, 'admin-wallet');

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'feature_flag_toggled',
        adminWallet: 'admin-wallet',
        queryParams: expect.objectContaining({
          flag_name: 'graphql_enabled',
          old_value: false,
          new_value: true,
          admin_wallet: 'admin-wallet',
        }),
      }),
    );
  });
});
