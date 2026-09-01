import {
  runDeadLetterRetryJob,
  startDeadLetterRetryJob,
  stopDeadLetterRetryJob,
  isDeadLetterJobRunning,
  MAX_AUTO_RETRIES,
  DEAD_LETTER_JOB_INTERVAL_MS,
  generateWorkerId,
} from '../../src/services/webhookDeadLetterJob';
import * as db from '../../src/db';
import * as webhooks from '../../src/services/webhooks';
import * as metrics from '../../src/middleware/metrics';

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../src/db', () => ({
  countWebhookDeadLetters: jest.fn(),
  countWebhookDeadLettersBySubscription: jest.fn(),
  listWebhookDeadLetters: jest.fn(),
  listWebhookSubscriptions: jest.fn(),
  claimWebhookDeadLetter: jest.fn(),
  releaseWebhookDeadLetterClaim: jest.fn(),
  markWebhookDeadLetterReplayed: jest.fn(),
  updateWebhookDeadLetterAttempt: jest.fn(),
}));

jest.mock('../../src/services/webhooks', () => ({
  postWebhookWithRetry: jest.fn(),
}));

jest.mock('../../src/middleware/metrics', () => ({
  incrementWebhookRetrySuccessTotal: jest.fn(),
  incrementWebhookDeadLettersTotal: jest.fn(),
}));

jest.mock('../../src/services/webhookDeadLetterAlerts', () => ({
  evaluateDeadLetterAlerts: jest.fn().mockResolvedValue({
    total: 0,
    bySubscription: [],
    sizeExceeded: false,
    rateExceeded: false,
    insertsInWindow: 0,
    notified: false,
  }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OLD_DATE = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min ago
const NEW_DATE = new Date(Date.now() - 2 * 60 * 1000).toISOString();  // 2 min ago (too new)

function makeLetter(overrides: Partial<db.WebhookDeadLetter> = {}): db.WebhookDeadLetter {
  return {
    id: 1,
    subscription_id: 1,
    url: 'https://example.com/webhook',
    event_type: 'player_registered',
    payload: JSON.stringify({ deliveryId: 'del-001', eventType: 'player_registered', payload: { foo: 'bar' } }),
    delivery_id: 'del-001',
    failure_reason: 'connect ECONNREFUSED',
    attempts: 1,
    status: 'pending',
    locked_by: null,
    locked_at: null,
    created_at: OLD_DATE,
    replayed_at: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('webhookDeadLetterJob — runDeadLetterRetryJob', () => {
  const mockCountDeadLetters = db.countWebhookDeadLetters as jest.Mock;
  const mockListDeadLetters = db.listWebhookDeadLetters as jest.Mock;
  const mockListSubscriptions = db.listWebhookSubscriptions as jest.Mock;
  const mockClaimDeadLetter = db.claimWebhookDeadLetter as jest.Mock;
  const mockReleaseClaim = db.releaseWebhookDeadLetterClaim as jest.Mock;
  const mockMarkReplayed = db.markWebhookDeadLetterReplayed as jest.Mock;
  const mockUpdateAttempt = db.updateWebhookDeadLetterAttempt as jest.Mock;
  const mockPost = webhooks.postWebhookWithRetry as jest.Mock;
  const mockIncrSuccess = metrics.incrementWebhookRetrySuccessTotal as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCountDeadLetters.mockReturnValue(0);
    (db.countWebhookDeadLettersBySubscription as jest.Mock).mockReturnValue([]);
    mockListSubscriptions.mockReturnValue([{ id: 1, url: 'https://example.com/webhook', secret: 'secret' }]);
  });

  it('returns 0 when there are no eligible rows', async () => {
    mockListDeadLetters.mockReturnValue([]);
    const result = await runDeadLetterRetryJob();
    expect(result).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('skips rows that are too new (< 10 min old)', async () => {
    mockListDeadLetters.mockReturnValue([makeLetter({ created_at: NEW_DATE })]);
    const result = await runDeadLetterRetryJob();
    expect(result).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('skips rows that already have MAX_AUTO_RETRIES attempts', async () => {
    mockListDeadLetters.mockReturnValue([makeLetter({ attempts: MAX_AUTO_RETRIES })]);
    const result = await runDeadLetterRetryJob();
    expect(result).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('skips rows that are already replayed', async () => {
    mockListDeadLetters.mockReturnValue([makeLetter({ status: 'replayed' })]);
    const result = await runDeadLetterRetryJob();
    expect(result).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('successfully retries an eligible dead letter after claiming it', async () => {
    const letter = makeLetter();
    mockListDeadLetters.mockReturnValue([letter]);
    mockClaimDeadLetter.mockReturnValue(letter); // claim succeeds
    mockPost.mockResolvedValue(undefined);

    const result = await runDeadLetterRetryJob();

    expect(result).toBe(1);
    expect(mockClaimDeadLetter).toHaveBeenCalledWith(letter.id, expect.stringContaining('worker-'));
    expect(mockPost).toHaveBeenCalledWith(
      letter.url,
      { deliveryId: 'del-001', eventType: 'player_registered', payload: { foo: 'bar' } },
      expect.objectContaining({ secret: 'secret' }),
    );
    expect(mockMarkReplayed).toHaveBeenCalledWith(letter.id);
    expect(mockIncrSuccess).toHaveBeenCalledTimes(1);
  });

  it('increments retry_count and releases claim on delivery failure', async () => {
    const letter = makeLetter({ attempts: 2 });
    mockListDeadLetters.mockReturnValue([letter]);
    mockClaimDeadLetter.mockReturnValue(letter);
    mockPost.mockRejectedValue(new Error('timeout'));

    const result = await runDeadLetterRetryJob();

    expect(result).toBe(0);
    expect(mockMarkReplayed).not.toHaveBeenCalled();
    expect(mockUpdateAttempt).toHaveBeenCalledWith(letter.id, 3, 'timeout');
    expect(mockReleaseClaim).toHaveBeenCalledWith(letter.id);
    expect(mockIncrSuccess).not.toHaveBeenCalled();
  });

  it('skips a row when claim fails (another sweep already claimed it)', async () => {
    const letter = makeLetter();
    mockListDeadLetters.mockReturnValue([letter]);
    mockClaimDeadLetter.mockReturnValue(null); // claim fails — another worker won

    const result = await runDeadLetterRetryJob();
    expect(result).toBe(0);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockMarkReplayed).not.toHaveBeenCalled();
  });

  it('does not retry a row with in_progress status (skipped by filter)', async () => {
    const letter = makeLetter({ status: 'in_progress' });
    mockListDeadLetters.mockReturnValue([letter]);

    const result = await runDeadLetterRetryJob();
    expect(result).toBe(0);
    expect(mockClaimDeadLetter).not.toHaveBeenCalled();
  });

  it('evaluates dead-letter alerts when queue is non-empty', async () => {
    const { evaluateDeadLetterAlerts } = require('../../src/services/webhookDeadLetterAlerts');
    mockCountDeadLetters.mockReturnValue(150);
    (db.countWebhookDeadLettersBySubscription as jest.Mock).mockReturnValue([
      { subscription_id: 1, count: 150 },
    ]);
    mockListDeadLetters.mockReturnValue([]);

    await runDeadLetterRetryJob();

    expect(evaluateDeadLetterAlerts).toHaveBeenCalledWith(
      150,
      [{ subscription_id: 1, count: 150 }],
    );
  });

  it('preserves delivery_id across retry (same ID re-sent)', async () => {
    const deliveryId = 'stable-delivery-id-abc-123';
    const letter = makeLetter({
      delivery_id: deliveryId,
      payload: JSON.stringify({ deliveryId, eventType: 'player_registered', payload: { x: 1 } }),
    });
    mockListDeadLetters.mockReturnValue([letter]);
    mockClaimDeadLetter.mockReturnValue(letter);
    mockPost.mockResolvedValue(undefined);

    await runDeadLetterRetryJob();

    // The payload sent via postWebhookWithRetry must contain the same delivery_id
    expect(mockPost).toHaveBeenCalledWith(
      letter.url,
      expect.objectContaining({ deliveryId }),
      expect.anything(),
    );
  });
});

describe('webhookDeadLetterJob — overlap guard (acceptance criterion)', () => {
  const mockListDeadLetters = db.listWebhookDeadLetters as jest.Mock;
  const mockClaimDeadLetter = db.claimWebhookDeadLetter as jest.Mock;
  const mockPost = webhooks.postWebhookWithRetry as jest.Mock;
  const mockMarkReplayed = db.markWebhookDeadLetterReplayed as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    (db.countWebhookDeadLetters as jest.Mock).mockReturnValue(0);
    (db.countWebhookDeadLettersBySubscription as jest.Mock).mockReturnValue([]);
    (db.listWebhookSubscriptions as jest.Mock).mockReturnValue([{ id: 1, url: 'https://example.com/webhook', secret: 'secret' }]);
  });

  it('two overlapping sweeps deliver a given row at most once (claim-locked)', async () => {
    // Scenario: two sweeps start concurrently over the same pending row.
    // The first sweep claims it; the second sweep's claim fails → row delivered once.
    const letter = makeLetter();

    // Both sweeps see the same pending row.
    mockListDeadLetters.mockReturnValue([letter]);

    // First sweep claims successfully, second sweep's claim returns null.
    mockClaimDeadLetter
      .mockReturnValueOnce(letter)  // sweep 1 wins
      .mockReturnValueOnce(null);   // sweep 2 loses

    mockPost.mockResolvedValue(undefined);

    const [result1, result2] = await Promise.all([
      runDeadLetterRetryJob(),
      runDeadLetterRetryJob(),
    ]);

    // Exactly one delivery across both sweeps.
    const totalDeliveries = result1 + result2;
    expect(totalDeliveries).toBe(1);
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockMarkReplayed).toHaveBeenCalledTimes(1);
  });
});

describe('webhookDeadLetterJob — scheduler', () => {
  afterEach(() => stopDeadLetterRetryJob());

  it('starts and stops correctly', () => {
    expect(isDeadLetterJobRunning()).toBe(false);
    startDeadLetterRetryJob();
    expect(isDeadLetterJobRunning()).toBe(true);
    stopDeadLetterRetryJob();
    expect(isDeadLetterJobRunning()).toBe(false);
  });

  it('is idempotent — calling start twice does not create two timers', () => {
    startDeadLetterRetryJob();
    startDeadLetterRetryJob();
    expect(isDeadLetterJobRunning()).toBe(true);
    stopDeadLetterRetryJob();
    expect(isDeadLetterJobRunning()).toBe(false);
  });

  it('uses a 5-minute interval', () => {
    expect(DEAD_LETTER_JOB_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});

describe('webhookDeadLetterJob — generateWorkerId', () => {
  it('generates unique worker IDs', () => {
    const id1 = generateWorkerId();
    const id2 = generateWorkerId();
    expect(id1).toMatch(/^worker-/);
    expect(id2).toMatch(/^worker-/);
    expect(id1).not.toBe(id2);
  });
});
