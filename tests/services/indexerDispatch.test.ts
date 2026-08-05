import { indexEvents } from '../../src/services/indexer';
import { dispatchEventWebhook } from '../../src/services/webhooks';

jest.mock('../../src/services/stellar', () => ({
  server: {
    getEvents: jest.fn(),
  },
}));

jest.mock('../../src/services/webhooks', () => ({
  dispatchEventWebhook: jest.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { server } = require('../../src/services/stellar') as { server: { getEvents: jest.Mock } };
const mockedDispatch = dispatchEventWebhook as jest.MockedFunction<typeof dispatchEventWebhook>;

function makeEvent(type: string, payload: Record<string, unknown>, txHash: string, ledger = 100) {
  return {
    topic: [{ value: () => type }],
    value: { value: () => payload },
    ledger,
    txHash,
  };
}

describe('indexEvents — milestone_approved webhook dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('dispatches a webhook when a milestone_approved event is indexed', async () => {
    const payload = { player_id: 'P1', milestone_type: 'identity' };
    server.getEvents.mockResolvedValue({
      events: [makeEvent('milestone_approved', payload, 'hash-001')],
    });

    await indexEvents();

    expect(mockedDispatch).toHaveBeenCalledTimes(1);
    expect(mockedDispatch).toHaveBeenCalledWith('milestone_approved', payload);
  });

  it('dispatches a webhook for each milestone_approved event in a batch', async () => {
    server.getEvents.mockResolvedValue({
      events: [
        makeEvent('milestone_approved', { player_id: 'P1' }, 'hash-002', 100),
        makeEvent('player_registered', { player_id: 'P2', wallet: 'GWALLETP2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'hash-003', 101),
        makeEvent('milestone_approved', { player_id: 'P3' }, 'hash-004', 102),
      ],
    });

    await indexEvents();

    expect(mockedDispatch).toHaveBeenCalledTimes(2);
    expect(mockedDispatch).toHaveBeenCalledWith('milestone_approved', { player_id: 'P1' });
    expect(mockedDispatch).toHaveBeenCalledWith('milestone_approved', { player_id: 'P3' });
  });

  it('does not dispatch a webhook for non-milestone_approved events', async () => {
    server.getEvents.mockResolvedValue({
      events: [makeEvent('player_registered', { player_id: 'P1', wallet: 'GWALLETP1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'hash-005')],
    });

    await indexEvents();

    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch any webhooks when the event stream is empty', async () => {
    server.getEvents.mockResolvedValue({ events: [] });

    await indexEvents();

    expect(mockedDispatch).not.toHaveBeenCalled();
  });

  it('logs a warning and continues when the webhook dispatch fails', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const warnSpy = jest.spyOn(require('../../src/utils/logger').logger, 'warn').mockImplementation(() => {});
    mockedDispatch.mockRejectedValueOnce(new Error('endpoint unreachable'));

    server.getEvents.mockResolvedValue({
      events: [makeEvent('milestone_approved', { player_id: 'P1' }, 'hash-006')],
    });

    await expect(indexEvents()).resolves.toBeUndefined();
    await new Promise(setImmediate);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('endpoint unreachable'));
    warnSpy.mockRestore();
  });

  it('detects a reorg and rolls back previously indexed events', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDb } = require('../../src/db');
    const db = getDb();
    const warnSpy = jest.spyOn(require('../../src/utils/logger').logger, 'warn').mockImplementation(() => {});

    // Initial indexing
    server.getEvents.mockResolvedValue({
      latestLedger: 101,
      events: [
        makeEvent('player_registered', { player_id: 'R1', wallet: 'GWALLETR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'hash-R1', 100, 'hashA'),
        makeEvent('player_registered', { player_id: 'R2', wallet: 'GWALLETR2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'hash-R2', 101, 'hashB')
      ],
    });
    await indexEvents();

    let count = db.prepare("SELECT count(*) as c FROM events WHERE ledger IN (100, 101)").get().c;
    expect(count).toBe(2);

    // Reorg simulation: RPC returns a different hash for ledger 101
    server.getEvents.mockResolvedValue({
      latestLedger: 101,
      events: [
        makeEvent('player_registered', { player_id: 'R1', wallet: 'GWALLETR1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'hash-R1', 100, 'hashA'),
        makeEvent('player_registered', { player_id: 'R3', wallet: 'GWALLETR3AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'hash-R3', 101, 'hashC')
      ],
    });
    
    await indexEvents();
    
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Reorg detected at ledger 101'));
    warnSpy.mockRestore();

    count = db.prepare("SELECT count(*) as c FROM events WHERE ledger IN (100, 101)").get().c;
    expect(count).toBe(2);
    const hashes = db.prepare("SELECT tx_hash FROM events WHERE ledger = 101").all().map((r: any) => r.tx_hash);
    expect(hashes).toContain('hash-R3');
    expect(hashes).not.toContain('hash-R2');
  });

  it('rolls back the entire batch if an error occurs mid-batch', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getDb, fetchLastIndexedLedger } = require('../../src/db');
    const db = getDb();
    
    const beforeCount = db.prepare("SELECT count(*) as c FROM events").get().c;
    const beforeLedger = fetchLastIndexedLedger();

    // Mock insertOrUpdatePlayer (called from within the batch transaction) to
    // throw midway through the batch. normalizePayload can't be spied on here
    // because indexer.ts calls it as a same-module local reference, so a spy
    // on the required module's property never intercepts that internal call —
    // insertOrUpdatePlayer is imported from ../../src/db, a separate module,
    // so calls to it always go through the module's exports object and a spy
    // does intercept them.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dbModule = require('../../src/db');
    const originalInsertOrUpdatePlayer = dbModule.insertOrUpdatePlayer;
    jest.spyOn(dbModule, 'insertOrUpdatePlayer').mockImplementation((p: any) => {
      if (p.player_id === 'CRASH') throw new Error('Crash!');
      return originalInsertOrUpdatePlayer(p);
    });

    server.getEvents.mockResolvedValue({
      latestLedger: 150,
      events: [
        makeEvent('player_registered', { player_id: 'OK', wallet: 'GWALLETOKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'hash-OK', 150),
        makeEvent('player_registered', { player_id: 'CRASH', wallet: 'GWALLETCRASHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'hash-CRASH', 150)
      ],
    });

    await expect(indexEvents()).rejects.toThrow('Crash!');

    dbModule.insertOrUpdatePlayer.mockRestore();

    const afterCount = db.prepare("SELECT count(*) as c FROM events").get().c;
    expect(afterCount).toBe(beforeCount);

    expect(fetchLastIndexedLedger()).toBe(beforeLedger);
  });
});
