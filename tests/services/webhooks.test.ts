import axios from 'axios';
import { postWebhookWithRetry } from '../../src/services/webhooks';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('postWebhookWithRetry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns successfully when the first request succeeds', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 } as any);

    await expect(postWebhookWithRetry('https://example.com', { eventType: 'test' })).resolves.toBeUndefined();
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });

  it('retries on an initial failure and succeeds on a later attempt', async () => {
    mockedAxios.post.mockRejectedValueOnce(new Error('network fail'));
    mockedAxios.post.mockResolvedValue({ status: 200 } as any);

    await expect(
      postWebhookWithRetry('https://example.com', { eventType: 'test' }, { retries: 3, baseDelayMs: 1, maxDelayMs: 2 })
    ).resolves.toBeUndefined();

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });

  it('throws after all retries fail', async () => {
    mockedAxios.post.mockRejectedValue(new Error('network down'));

    await expect(
      postWebhookWithRetry('https://example.com', { eventType: 'test' }, { retries: 2, baseDelayMs: 1, maxDelayMs: 2 })
    ).rejects.toThrow('network down');

    expect(mockedAxios.post).toHaveBeenCalledTimes(2);
  });
});
