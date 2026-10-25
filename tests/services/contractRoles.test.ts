import { Address, Keypair, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { normalizeSorobanEvent } from '../../src/services/indexer';
import { listContractRoleMembers } from '../../src/db';
import { dbRun, insertEvent } from '../helpers/db';

describe('indexed contract roles', () => {
  it.each(['role_granted', 'role_revoked'])('decodes %s positional data', (type) => {
    const account = Keypair.random().publicKey();
    const sender = Keypair.random().publicKey();
    expect(normalizeSorobanEvent({
      topic: [nativeToScVal(type, { type: 'symbol' }), nativeToScVal('PAUSER', { type: 'symbol' })],
      value: xdr.ScVal.scvVec([Address.fromString(account).toScVal(), Address.fromString(sender).toScVal()]),
    })).toEqual({ type, payload: { role: 'PAUSER', account, sender } });
  });

  it('tracks latest canonical grant, replay, revoke and reorg independently per contract', async () => {
    const payload = JSON.stringify({ role: 'PAUSER', account: 'holder', sender: 'root' });
    const event = { type: 'role_granted', ledger: 100, tx_hash: 'grant', contract_id: 'contract-a', payload };
    await insertEvent(event);
    await insertEvent(event);
    await insertEvent({ ...event, tx_hash: 'grant-b', contract_id: 'contract-b' });
    expect(await listContractRoleMembers()).toEqual([
      { contract_id: 'contract-a', role: 'PAUSER', account: 'holder' },
      { contract_id: 'contract-b', role: 'PAUSER', account: 'holder' },
    ]);
    await insertEvent({ ...event, type: 'role_revoked', ledger: 101, tx_hash: 'revoke' });
    expect((await listContractRoleMembers()).map((row) => row.contract_id)).toEqual(['contract-b']);
    await dbRun('DELETE FROM events WHERE tx_hash = ?', ['revoke']);
    expect(await listContractRoleMembers()).toHaveLength(2);
  });
});
