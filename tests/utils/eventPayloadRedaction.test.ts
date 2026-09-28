import { payloadReferencesPlayer, redactEventPayload } from '../../src/utils/eventPayloadRedaction';

describe('eventPayloadRedaction (#1329)', () => {
  const PLAYER = 'player-redact-1';

  it('redacts PII fields while keeping structure', () => {
    const payload = {
      player_id: PLAYER,
      wallet: 'GWALLET123',
      metadata_uri: 'QmMeta',
      region: 'EU',
      evidence_uri: 'ipfs://evidence',
      ledger: 100,
      tx_hash: 'abc123',
      type: 'player_registered',
    };
    const redacted = redactEventPayload(payload, PLAYER);
    expect(redacted.player_id).toBe(PLAYER);
    expect(redacted.wallet).toBe('[anonymized]');
    expect(redacted.metadata_uri).toBe('[anonymized]');
    expect(redacted.region).toBe('[anonymized]');
    expect(redacted.evidence_uri).toBe('[anonymized]');
    expect(redacted.ledger).toBe(100);
    expect(redacted.tx_hash).toBe('abc123');
  });

  it('does not redact unrelated players', () => {
    const payload = { player_id: 'other-player', wallet: 'GKEEP' };
    expect(payloadReferencesPlayer(payload, PLAYER)).toBe(false);
    expect(redactEventPayload(payload, PLAYER)).toEqual(payload);
  });
});
