import { getFeatureFlags } from '../../src/controllers/featureFlagsController';
import { clearFeatureFlagCache, isFeatureEnabled, setFeatureFlag } from '../../src/services/featureFlags';
import * as db from '../../src/db';

describe('FeatureFlags Controller - Cache Consistency (#677)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should clear cache and return fresh flags from database when direct DB changes occur', async () => {
    const flagName = 'saved_searches';
    const updatedBy = 'test_user';

    jest.spyOn(db, 'upsertFeatureFlag').mockResolvedValue(undefined);
    jest.spyOn(db, 'getFeatureFlag').mockResolvedValue({
      name: flagName,
      enabled: 1,
      updated_at: Date.now(),
      updated_by: updatedBy,
    });

    await setFeatureFlag(flagName, true, updatedBy);

    expect(await isFeatureEnabled(flagName)).toBe(true);

    jest.spyOn(db, 'getAllFeatureFlags').mockResolvedValue([
      {
        name: flagName,
        enabled: 0,
        updated_at: Date.now(),
        updated_by: 'external_migration',
      },
    ]);

    const req = {} as any;
    const res = {
      json: jest.fn(),
    } as any;
    const next = jest.fn();

    await getFeatureFlags(req, res, next);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [
        {
          name: flagName,
          enabled: false,
          updated_at: expect.any(Number),
          updated_by: 'external_migration',
        },
      ],
    });

    clearFeatureFlagCache();

    jest.spyOn(db, 'getFeatureFlag').mockResolvedValue({
      name: flagName,
      enabled: 0,
      updated_at: Date.now(),
      updated_by: 'external_migration',
    });

    expect(await isFeatureEnabled(flagName)).toBe(false);
  });
});
