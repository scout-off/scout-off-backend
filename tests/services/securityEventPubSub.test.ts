/**
 * Unit tests for src/services/securityEventPubSub.ts (#1586).
 *
 * Covers initialization with/without Redis, per-channel dispatch, and
 * resilience to bad messages — all without a real Redis server. Tests drive
 * the module through the mock subscriber's 'message' event.
 */

import { EventEmitter } from 'events';

jest.mock('../../src/utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../src/services/walletBlocklist', () => ({
  onWalletBlockedRemote: jest.fn(),
  onWalletUnblockedRemote: jest.fn(),
}), { virtual: false });

jest.mock('../../src/services/tokenBlocklist', () => ({
  onTokenRevokedRemote: jest.fn(),
}), { virtual: false });

type MockSubscriber = EventEmitter & {
  subscribe: jest.Mock;
  unsubscribe: jest.Mock;
  quit: jest.Mock;
};

function makeSubscriber(): MockSubscriber {
  const sub = new EventEmitter() as MockSubscriber;
  sub.subscribe = jest.fn().mockResolvedValue(1);
  sub.unsubscribe = jest.fn().mockResolvedValue(1);
  sub.quit = jest.fn().mockResolvedValue('OK');
  return sub;
}

function loadWithRedis(main: unknown, subscriber: MockSubscriber | null) {
  jest.resetModules();
  jest.doMock('../../src/services/redis', () => ({
    getRedisClient: jest.fn(() => main),
    getRedisSubscriberClient: jest.fn(() => subscriber),
    closeRedisClients: jest.fn(),
  }));
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('../../src/services/securityEventPubSub');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const logger = require('../../src/utils/logger').logger;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const wallet = require('../../src/services/walletBlocklist');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const token = require('../../src/services/tokenBlocklist');
  return { mod, logger, wallet, token };
}

async function emit(sub: MockSubscriber, channel: string, message: string) {
  sub.emit('message', channel, message);
  await new Promise(setImmediate);
}

describe('securityEventPubSub', () => {
  afterEach(() => {
    jest.dontMock('../../src/services/redis');
    jest.resetModules();
  });

  it('init with no Redis client logs info and does not subscribe', async () => {
    const { mod, logger } = loadWithRedis(null, null);
    await mod.initSecurityEventSubscriber();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Redis not configured'),
    );
    await mod.closeSecurityEventSubscriber(); // idempotent no-op
  });

  it('init with Redis subscribes to the three channels', async () => {
    const sub = makeSubscriber();
    const { mod } = loadWithRedis({}, sub);
    await mod.initSecurityEventSubscriber();
    expect(sub.subscribe).toHaveBeenCalledWith(
      'security:wallet_blocked',
      'security:wallet_unblocked',
      'security:token_revoked',
      expect.any(Function),
    );
    await mod.closeSecurityEventSubscriber();
  });

  it('security:wallet_blocked dispatches to onWalletBlockedRemote', async () => {
    const sub = makeSubscriber();
    const { mod, wallet } = loadWithRedis({}, sub);
    await mod.initSecurityEventSubscriber();
    await emit(sub, 'security:wallet_blocked', JSON.stringify({ wallet: 'GABC' }));
    expect(wallet.onWalletBlockedRemote).toHaveBeenCalledWith('GABC');
    await mod.closeSecurityEventSubscriber();
  });

  it('security:wallet_unblocked dispatches to onWalletUnblockedRemote', async () => {
    const sub = makeSubscriber();
    const { mod, wallet } = loadWithRedis({}, sub);
    await mod.initSecurityEventSubscriber();
    await emit(sub, 'security:wallet_unblocked', JSON.stringify({ wallet: 'GDEF' }));
    expect(wallet.onWalletUnblockedRemote).toHaveBeenCalledWith('GDEF');
    await mod.closeSecurityEventSubscriber();
  });

  it('security:token_revoked dispatches to onTokenRevokedRemote', async () => {
    const sub = makeSubscriber();
    const { mod, token } = loadWithRedis({}, sub);
    await mod.initSecurityEventSubscriber();
    await emit(sub, 'security:token_revoked', JSON.stringify({ token_hash: 'abc123' }));
    expect(token.onTokenRevokedRemote).toHaveBeenCalledWith('abc123');
    await mod.closeSecurityEventSubscriber();
  });

  it('invalid JSON logs a warning and does not throw', async () => {
    const sub = makeSubscriber();
    const { mod, logger } = loadWithRedis({}, sub);
    await mod.initSecurityEventSubscriber();
    await expect(emit(sub, 'security:wallet_blocked', 'not-json{{{')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to parse message'),
      expect.anything(),
    );
    await mod.closeSecurityEventSubscriber();
  });

  it('payload missing wallet does not call the handler', async () => {
    const sub = makeSubscriber();
    const { mod, wallet } = loadWithRedis({}, sub);
    await mod.initSecurityEventSubscriber();
    await emit(sub, 'security:wallet_blocked', JSON.stringify({}));
    expect(wallet.onWalletBlockedRemote).not.toHaveBeenCalled();
    await mod.closeSecurityEventSubscriber();
  });

  it('unknown channel logs a warning', async () => {
    const sub = makeSubscriber();
    const { mod, logger } = loadWithRedis({}, sub);
    await mod.initSecurityEventSubscriber();
    await emit(sub, 'security:nonsense', JSON.stringify({}));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unknown channel'),
    );
    await mod.closeSecurityEventSubscriber();
  });

  it('close unsubscribes and quits, and is idempotent', async () => {
    const sub = makeSubscriber();
    const { mod } = loadWithRedis({}, sub);
    await mod.initSecurityEventSubscriber();
    await mod.closeSecurityEventSubscriber();
    expect(sub.unsubscribe).toHaveBeenCalled();
    expect(sub.quit).toHaveBeenCalled();
    await expect(mod.closeSecurityEventSubscriber()).resolves.toBeUndefined();
    expect(sub.quit).toHaveBeenCalledTimes(1);
  });
});
