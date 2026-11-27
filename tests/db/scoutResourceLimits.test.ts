import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  getDriver,
  insertApiKey,
  revokeApiKeyById,
} from '../../src/db';
import {
  ApiKeyLimitError,
  MAX_API_KEYS_PER_SCOUT,
  MAX_WEBHOOK_SUBSCRIPTIONS_PER_SCOUT,
  WebhookSubscriptionLimitError,
} from '../../src/utils/scoutResourceLimits';

const SCOUT = 'GTESTRESOURCEQUOTALIMITS';

async function insertScoutApiKey(label: string): Promise<number> {
  return insertApiKey({
    key_hash: `salt:${label}`,
    scout_wallet: SCOUT,
    label,
    created_at: Date.now(),
    lookup_hash: `lookup-${label}`,
  });
}

describe('scout resource limits', () => {
  beforeEach(async () => {
    await getDriver().run('DELETE FROM api_keys WHERE scout_wallet = ?', [SCOUT]);
    await getDriver().run('DELETE FROM webhook_subscriptions WHERE scout_wallet = ?', [SCOUT]);
  });

  it('caps API key issuance at 10 persisted keys, including revoked keys', async () => {
    const ids: number[] = [];
    for (let i = 0; i < MAX_API_KEYS_PER_SCOUT; i++) {
      ids.push(await insertScoutApiKey(`key-${i}`));
    }
    await revokeApiKeyById(ids[0], SCOUT);

    await expect(insertScoutApiKey('over-limit')).rejects.toBeInstanceOf(ApiKeyLimitError);

    const count = await getDriver().value<number | string>(
      'SELECT COUNT(*) FROM api_keys WHERE scout_wallet = ?',
      [SCOUT],
    );
    expect(Number(count)).toBe(MAX_API_KEYS_PER_SCOUT);
  });

  it('enforces the API key cap under concurrent issuance', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: MAX_API_KEYS_PER_SCOUT + 4 }, (_, i) =>
        insertScoutApiKey(`parallel-${i}`),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(
      MAX_API_KEYS_PER_SCOUT,
    );
    expect(
      results.filter(
        (result) => result.status === 'rejected' && result.reason instanceof ApiKeyLimitError,
      ),
    ).toHaveLength(4);
  });

  it('caps webhook subscriptions at 10 and frees capacity after deletion', () => {
    const subscriptions = Array.from({ length: MAX_WEBHOOK_SUBSCRIPTIONS_PER_SCOUT }, (_, i) =>
      createWebhookSubscription(`https://example.com/${i}`, undefined, SCOUT),
    );

    expect(() =>
      createWebhookSubscription('https://example.com/over-limit', undefined, SCOUT),
    ).toThrow(WebhookSubscriptionLimitError);

    expect(deleteWebhookSubscription(subscriptions[0].id, SCOUT)).toBe(true);
    expect(() =>
      createWebhookSubscription('https://example.com/replacement', undefined, SCOUT),
    ).not.toThrow();
  });
});
