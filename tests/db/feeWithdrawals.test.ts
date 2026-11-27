/**
 * Direct repository tests for src/db/repositories/feeWithdrawals.ts (#1870).
 *
 * Covers insert, listing order, total aggregation and amount precision —
 * including 9007199254740993 (2^53 + 1), which is NOT representable as a JS
 * number and must survive the round-trip as an exact string.
 *
 * Driver-agnostic: every call goes through getDriver(), so the same suite runs
 * under DB_DRIVER=sqlite (default) and DB_DRIVER=postgres (CI postgres job).
 */
import { getDriver } from '../../src/db';
import {
  insertFeeWithdrawal,
  getFeeWithdrawalByIdempotencyKey,
  listFeeWithdrawals,
} from '../../src/db/repositories/feeWithdrawals';

const TREASURY = 'GTREASURY0000000000000000000000000000000000000000000000';
const ADMIN = 'GADMIN000000000000000000000000000000000000000000000000';

function withdrawal(overrides: Partial<Parameters<typeof insertFeeWithdrawal>[0]> = {}) {
  return {
    idempotencyKey: null,
    treasuryAddress: TREASURY,
    amountStroops: '10000000',
    txHash: 'tx-default',
    adminWallet: ADMIN,
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Sum of amount_stroops as BigInt — the only lossless way to aggregate u128s. */
async function totalStroops(): Promise<bigint> {
  const rows = await listFeeWithdrawals(1000, 0);
  return rows.reduce((acc, r) => acc + BigInt(r.amount_stroops), 0n);
}

describe('feeWithdrawals repository (#1870)', () => {
  beforeEach(async () => {
    await getDriver().run('DELETE FROM fee_withdrawals');
  });

  it('inserts a withdrawal and returns its id', async () => {
    const id = await insertFeeWithdrawal(withdrawal({ idempotencyKey: 'idem-1', txHash: 'tx-1' }));
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);

    const row = await getFeeWithdrawalByIdempotencyKey('idem-1');
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.treasury_address).toBe(TREASURY);
    expect(row!.amount_stroops).toBe('10000000');
    expect(row!.tx_hash).toBe('tx-1');
    expect(row!.admin_wallet).toBe(ADMIN);
    expect(row!.created_at).toBe('2025-01-01T00:00:00.000Z');
  });

  it('returns null for an unknown idempotency key', async () => {
    expect(await getFeeWithdrawalByIdempotencyKey('does-not-exist')).toBeNull();
  });

  it('lists withdrawals newest-first by created_at', async () => {
    await insertFeeWithdrawal(
      withdrawal({ txHash: 'tx-old', createdAt: '2025-01-01T00:00:00.000Z' }),
    );
    await insertFeeWithdrawal(
      withdrawal({ txHash: 'tx-new', createdAt: '2025-03-01T00:00:00.000Z' }),
    );
    await insertFeeWithdrawal(
      withdrawal({ txHash: 'tx-mid', createdAt: '2025-02-01T00:00:00.000Z' }),
    );

    const rows = await listFeeWithdrawals();
    expect(rows.map((r) => r.tx_hash)).toEqual(['tx-new', 'tx-mid', 'tx-old']);
  });

  it('honours limit and offset', async () => {
    for (let i = 0; i < 5; i++) {
      await insertFeeWithdrawal(
        withdrawal({
          txHash: `tx-${i}`,
          createdAt: `2025-01-0${i + 1}T00:00:00.000Z`,
        }),
      );
    }

    const page = await listFeeWithdrawals(2, 1);
    expect(page.map((r) => r.tx_hash)).toEqual(['tx-3', 'tx-2']);
  });

  it('aggregates the total withdrawn amount exactly', async () => {
    await insertFeeWithdrawal(withdrawal({ txHash: 'tx-a', amountStroops: '10000000' }));
    await insertFeeWithdrawal(withdrawal({ txHash: 'tx-b', amountStroops: '25000000' }));
    await insertFeeWithdrawal(withdrawal({ txHash: 'tx-c', amountStroops: '5000000' }));

    expect(await totalStroops()).toBe(40000000n);
  });

  it('preserves amount precision for 9007199254740993 (2^53 + 1)', async () => {
    const precise = '9007199254740993';
    await insertFeeWithdrawal(withdrawal({ txHash: 'tx-precise', amountStroops: precise }));

    const rows = await listFeeWithdrawals();
    expect(rows).toHaveLength(1);
    expect(rows[0].amount_stroops).toBe(precise);
    // A JS number round-trip would collapse this to 9007199254740992.
    expect(rows[0].amount_stroops).not.toBe(String(Number(precise)));
    expect(await totalStroops()).toBe(9007199254740993n);
  });

  it('aggregates a u128-scale amount without precision loss', async () => {
    const huge = '340282366920938463463374607431768211455'; // u128::MAX
    await insertFeeWithdrawal(withdrawal({ txHash: 'tx-huge', amountStroops: huge }));
    await insertFeeWithdrawal(withdrawal({ txHash: 'tx-one', amountStroops: '1' }));

    const rows = await listFeeWithdrawals();
    const byHash = new Map(rows.map((r) => [r.tx_hash, r.amount_stroops]));
    expect(byHash.get('tx-huge')).toBe(huge);
    expect(await totalStroops()).toBe(BigInt(huge) + 1n);
  });
});
