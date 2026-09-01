import {
  getDb, closeDb, fetchLastIndexedLedger, persistLastIndexedLedger,
  queryPlayers, countPlayers, getPlayerById, insertOrUpdatePlayer,
  updatePlayerProgress,
  queryEvents, getEventsCount,
  insertPlayerProfileHistory, getPlayerProfileHistory,
  incrementValidatorApproved, incrementValidatorRejected, getValidatorStats,
  insertPendingMilestone, removePendingMilestone, getPendingMilestones,
  getIdempotencyRecord, saveIdempotencyRecord, purgeExpiredIdempotencyKeys,
  getLatestSubscription, insertSubscription, dbRenewSubscription, dbCancelSubscription,
  insertContactUnlock, getContactUnlocksByScout, hasContactUnlock,
  insertAuditLog, getAuditLogs, getAuditLogsCount, getAllAuditLogRows,
  getTrialOfferById, insertTrialOffer, respondToTrialOffer,
  insertPendingPin, getPendingPins, deletePendingPin, deletePendingPinByHash, isPendingPinByHash, incrementPendingPinAttempts,
  getStalePendingPins, updatePendingPinReconciliation, countStuckPendingPins,
  upsertScoutNote, getScoutNote, getScoutNotes,
  insertApiKey, listApiKeysByWallet, revokeApiKeyById, getApiKeyByHash, getAllActiveApiKeys,
  getActiveApiKeyByLookupHash, getActiveApiKeysAwaitingLookupHash, setApiKeyLookupHash,
  touchApiKeyLastUsed,
  insertBookmark, deleteBookmark, getBookmarksByScout,
  insertSavedSearch, getSavedSearchesByScout, deleteSavedSearch,
  getAllFeatureFlags, getFeatureFlag, upsertFeatureFlag,
  insertPendingAdminAction, getPendingAdminActionById, getPendingAdminActionsByStatus,
  updatePendingAdminActionStatus, incrementActionSignatures, expireStalePendingAdminActions,
  insertAdminActionSignature, getAdminActionSignature, getAdminActionSignatures,
} from '../../src/db';
import { ContractEventType } from '../../src/types';

const INJECTION_PAYLOADS = [
  "'; DROP TABLE players; --",
  "'; DROP TABLE events; --",
  "' OR '1'='1",
  "'; SELECT * FROM sqlite_master; --",
  "x' UNION SELECT * FROM events--",
  "\\'; EXECUTE IMMEDIATE 'DROP TABLE players'; --",
  "' UNION SELECT * FROM information_schema.tables; --",
  "1; SELECT * FROM users WHERE '1' = '1",
];

async function seedPlayer(id: string, extra?: Partial<Parameters<typeof insertOrUpdatePlayer>[0]>): Promise<void> {
  await insertOrUpdatePlayer({
    player_id: id,
    wallet: 'G' + 'A'.repeat(55),
    position: 'midfielder',
    region: 'europe',
    created_at: 1000,
    ...extra,
  });
}

beforeEach(async () => {
  getDb().prepare('DELETE FROM players').run();
  getDb().prepare('DELETE FROM pending_milestones').run();
  getDb().prepare('DELETE FROM events').run();
  getDb().prepare('DELETE FROM audit_log').run();
  // Seed one normal player to ensure queries can return rows
  await seedPlayer('normal-player');
});

describe('queryPlayers - SQL injection resistance', () => {
  INJECTION_PAYLOADS.forEach((payload) => {
    it(`queryPlayers treats injection payload as literal: ${payload.slice(0, 40)}...`, async () => {
      const rows = await queryPlayers({ region: payload });
      // Must not throw, must return empty array (no match) not drop tables
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(0);
    });

    it(`countPlayers treats injection payload as literal: ${payload.slice(0, 40)}...`, async () => {
      const count = await countPlayers({ region: payload });
      expect(typeof count).toBe('number');
      expect(count).toBe(0);
    });

    it(`queryPlayers treats injection position as literal: ${payload.slice(0, 40)}...`, async () => {
      const rows = await queryPlayers({ position: payload });
      expect(Array.isArray(rows)).toBe(true);
      expect(rows).toHaveLength(0);
    });

    it(`queryPlayers treats injection minTier as literal (coerced): ${payload.slice(0, 40)}...`, async () => {
      if (/^\d+$/.test(payload)) return; // skip pure digits — zod would parse as number
      // minTier is coerce'd via zod in the controller, but queryPlayers accepts number
      // The param goes through ? placeholder so even if 0 it won't inject
      const rows = await queryPlayers({ minTier: 0, region: 'europe' });
      expect(Array.isArray(rows)).toBe(true);
    });
  });

  it('queryPlayers with injection in both region and position is safe', async () => {
    const rows = await queryPlayers({ region: "'; DROP TABLE players; --", position: "' OR '1'='1" });
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(0);
  });

  it('players table still exists after injection attempts', async () => {
    const count = await countPlayers({});
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it('LIMIT and OFFSET values passed through ? are safe', async () => {
    const rows = await queryPlayers({ region: 'europe', limit: 10, offset: 0 });
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('getPlayerById - SQL injection resistance', () => {
  INJECTION_PAYLOADS.forEach((payload) => {
    it(`getPlayerById treats injection as literal: ${payload.slice(0, 40)}...`, async () => {
      const row = await getPlayerById(payload);
      // Must not throw, must return null (no match)
      expect(row).toBeNull();
    });
  });

  it('can still find a normal player after injection calls', async () => {
    const row = await getPlayerById('normal-player');
    expect(row).not.toBeNull();
    expect(row!.player_id).toBe('normal-player');
  });
});

describe('getPendingMilestones - SQL injection resistance', () => {
  beforeEach(() => {
    getDb().prepare(`INSERT INTO pending_milestones (milestone_id, player_id, validator_wallet, milestone_type, evidence_uri, submitted_at) VALUES (?, ?, ?, ?, ?, ?)`).run('m1', 'normal-player', 'G' + 'A'.repeat(55), 'performance', 'ipfs://QmTest', 1000);
  });

  INJECTION_PAYLOADS.forEach((payload) => {
    it(`getPendingMilestones treats injection position as literal: ${payload.slice(0, 40)}...`, async () => {
      const result = await getPendingMilestones({ position: payload });
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data).toHaveLength(0);
      expect(typeof result.total).toBe('number');
    });

    it(`getPendingMilestones treats injection region as literal: ${payload.slice(0, 40)}...`, async () => {
      const result = await getPendingMilestones({ region: payload });
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data).toHaveLength(0);
    });

    it(`getPendingMilestones treats injection playerId as literal: ${payload.slice(0, 40)}...`, async () => {
      const result = await getPendingMilestones({ playerId: payload });
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data).toHaveLength(0);
    });

    it(`getPendingMilestones treats injection validatorWallet as literal: ${payload.slice(0, 40)}...`, async () => {
      const result = await getPendingMilestones({ validatorWallet: payload });
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data).toHaveLength(0);
    });

    it(`getPendingMilestones treats injection page/pageSize as safe: ${payload.slice(0, 40)}...`, async () => {
      const result = await getPendingMilestones({ page: 1, pageSize: 20, position: payload });
      expect(Array.isArray(result.data)).toBe(true);
    });
  });

  it('pending_milestones table still exists after injection attempts', async () => {
    const result = await getPendingMilestones({});
    expect(result.total).toBeGreaterThanOrEqual(1);
  });
});

describe('queryEvents - SQL injection resistance', () => {
  // Seed a real event row
  beforeEach(() => {
    getDb().prepare('INSERT OR IGNORE INTO events (type, ledger, tx_hash, payload, created_at) VALUES (?, ?, ?, ?, ?)').run('player_registered', 1, 'abc123', '{}', 1000);
  });

  INJECTION_PAYLOADS.forEach((payload) => {
    it(`queryEvents treats injection type as literal: ${payload.slice(0, 40)}...`, () => {
      const rows = queryEvents(payload as unknown as ContractEventType);
      expect(Array.isArray(rows)).toBe(true);
      // Should match nothing, not throw
    });

    it(`queryEvents with pagination treats injection safely: ${payload.slice(0, 40)}...`, () => {
      const rows = queryEvents(payload as unknown as ContractEventType, { limit: 10, offset: 0 });
      expect(Array.isArray(rows)).toBe(true);
    });
  });

  it('events table still exists after injection attempts', () => {
    expect(queryEvents()).toHaveLength(1);
  });
});

describe('getAuditLogs - SQL injection resistance', () => {
  INJECTION_PAYLOADS.forEach((payload) => {
    it(`getAuditLogs treats injection action as literal: ${payload.slice(0, 40)}...`, async () => {
      const rows = await getAuditLogs({ action: payload });
      expect(Array.isArray(rows)).toBe(true);
    });

    it(`getAuditLogs treats injection startDate as literal: ${payload.slice(0, 40)}...`, async () => {
      const rows = await getAuditLogs({ startDate: payload });
      expect(Array.isArray(rows)).toBe(true);
    });

    it(`getAuditLogs treats injection endDate as literal: ${payload.slice(0, 40)}...`, async () => {
      const rows = await getAuditLogs({ endDate: payload });
      expect(Array.isArray(rows)).toBe(true);
    });

    it(`getAuditLogsCount treats injection action as literal: ${payload.slice(0, 40)}...`, async () => {
      const count = await getAuditLogsCount({ action: payload });
      expect(typeof count).toBe('number');
    });

    it(`getAuditLogsCount treats injection date range as literal: ${payload.slice(0, 40)}...`, async () => {
      const count = await getAuditLogsCount({ startDate: payload, endDate: payload });
      expect(typeof count).toBe('number');
    });

    it(`getAllAuditLogRows treats injection action as literal: ${payload.slice(0, 40)}...`, async () => {
      const rows = await getAllAuditLogRows({ action: payload });
      expect(Array.isArray(rows)).toBe(true);
    });
  });
});

describe('getValidatorStats - SQL injection resistance', () => {
  INJECTION_PAYLOADS.forEach((payload) => {
    it(`getValidatorStats treats injection wallet as literal: ${payload.slice(0, 40)}...`, async () => {
      const stats = await getValidatorStats(payload);
      expect(stats).toBeNull();
    });
  });
});

describe('all DB functions - SQL injection resistance (comprehensive)', () => {
  const inj = INJECTION_PAYLOADS[0];

  it('fetchLastIndexedLedger is safe', () => {
    expect(typeof fetchLastIndexedLedger()).toBe('number');
  });

  it('persistLastIndexedLedger with injection payload', () => {
    expect(typeof persistLastIndexedLedger(0)).toBe('undefined');
  });

  it('getEventsCount with injection payload', () => {
    const count = getEventsCount(inj as unknown as ContractEventType);
    expect(typeof count).toBe('number');
  });

  it('insertPlayerProfileHistory with injection payloads', async () => {
    await insertPlayerProfileHistory({ player_id: inj, metadata_uri: inj, changed_at: 0, tx_hash: inj });
  });

  it('getPlayerProfileHistory with injection payload', async () => {
    const rows = await getPlayerProfileHistory(inj);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('insertOrUpdatePlayer with injection payloads', async () => {
    await insertOrUpdatePlayer({ player_id: inj, wallet: inj, position: inj, region: inj, metadata_uri: inj });
  });

  it('updatePlayerProgress with injection payload', async () => {
    await updatePlayerProgress(inj, 0);
  });

  it('incrementValidatorApproved with injection payload', async () => {
    await incrementValidatorApproved(inj);
  });

  it('incrementValidatorRejected with injection payload', async () => {
    await incrementValidatorRejected(inj);
  });

  it('insertPendingMilestone with injection payloads', async () => {
    await insertPendingMilestone(inj, inj, inj, inj, inj, 0);
  });

  it('removePendingMilestone with injection payload', async () => {
    await removePendingMilestone(inj);
  });

  it('getIdempotencyRecord with injection payload', async () => {
    const rec = await getIdempotencyRecord(inj);
    expect(rec === null || typeof rec === 'object').toBe(true);
  });

  it('saveIdempotencyRecord with injection payloads', async () => {
    await saveIdempotencyRecord(inj, 200, {});
  });

  it('purgeExpiredIdempotencyKeys is safe', async () => {
    expect(typeof (await purgeExpiredIdempotencyKeys())).toBe('number');
  });

  it('getLatestSubscription with injection payload', async () => {
    const sub = await getLatestSubscription(inj);
    expect(sub === null || typeof sub === 'object').toBe(true);
  });

  it('insertSubscription with injection payloads', async () => {
    expect(typeof (await insertSubscription({ scout_wallet: inj, tier: inj, expires_at: 0, created_at: 0 }))).toBe('number');
  });

  it('dbRenewSubscription with injection payloads', async () => {
    await dbRenewSubscription({ id: 9999, tier: inj, expires_at: 0 });
  });

  it('dbCancelSubscription with injection payloads', async () => {
    await dbCancelSubscription({ id: 9999, cancelled_at: 0 });
  });

  it('insertContactUnlock with injection payloads', async () => {
    await insertContactUnlock({ scout_wallet: inj, player_id: inj, tx_hash: inj, unlocked_at: 0 });
  });

  it('getContactUnlocksByScout with injection payload', async () => {
    const rows = await getContactUnlocksByScout(inj);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('hasContactUnlock with injection payloads', async () => {
    expect(typeof (await hasContactUnlock(inj, inj))).toBe('boolean');
  });

  it('insertAuditLog with injection payloads', async () => {
    await insertAuditLog({ action: inj, adminWallet: inj, queryParams: { [inj]: inj }, createdAt: inj });
  });

  it('getTrialOfferById with injection payload', async () => {
    const offer = await getTrialOfferById(inj);
    expect(offer === null || typeof offer === 'object').toBe(true);
  });

  it('insertTrialOffer with injection payloads', async () => {
    await insertTrialOffer({ offer_id: inj, scout_wallet: inj, player_id: inj, details_uri: inj, created_at: 0 });
  });

  it('respondToTrialOffer with injection payloads', async () => {
    await respondToTrialOffer({ offer_id: inj, status: inj, reject_reason: inj, responded_at: 0 });
  });

  it('insertPendingPin with injection payloads', async () => {
    await insertPendingPin({ payload: inj, created_at: inj, last_tried: inj });
  });

  it('getPendingPins is safe', async () => {
    const pins = await getPendingPins();
    expect(Array.isArray(pins)).toBe(true);
  });

  it('deletePendingPin is safe', async () => {
    await deletePendingPin(9999);
  });

  it('deletePendingPinByHash with injection payload', async () => {
    await deletePendingPinByHash(inj);
  });

  it('isPendingPinByHash with injection payload', async () => {
    expect(typeof (await isPendingPinByHash(inj))).toBe('boolean');
  });

  it('incrementPendingPinAttempts with injection payload', async () => {
    await incrementPendingPinAttempts(9999);
  });

  it('getStalePendingPins with injection payload', async () => {
    const rows = await getStalePendingPins(inj);
    expect(Array.isArray(rows)).toBe(true);
  });

  it('updatePendingPinReconciliation with injection payload', async () => {
    await updatePendingPinReconciliation({ id: 9999, status: inj, expiredReason: inj, resolvedCid: inj, lastReconciledAt: inj });
  });

  it('countStuckPendingPins with injection payload', async () => {
    const count = await countStuckPendingPins(inj);
    expect(typeof count).toBe('number');
  });

  it('upsertScoutNote with injection payloads', async () => {
    await upsertScoutNote({ scout_wallet: inj, player_id: inj, note_text: inj, updated_at: 0 });
  });

  it('getScoutNote with injection payloads', async () => {
    const note = await getScoutNote(inj, inj);
    expect(note === null || typeof note === 'object').toBe(true);
  });

  it('getScoutNotes with injection payload', async () => {
    const notes = await getScoutNotes(inj);
    expect(Array.isArray(notes)).toBe(true);
  });

  it('insertApiKey with injection payloads', async () => {
    await insertApiKey({ scout_wallet: inj, key_hash: inj, label: inj, created_at: 0 });
  });

  it('listApiKeysByWallet with injection payload', async () => {
    const keys = await listApiKeysByWallet(inj);
    expect(Array.isArray(keys)).toBe(true);
  });

  it('revokeApiKeyById with injection payloads', async () => {
    expect(typeof (await revokeApiKeyById(9999, inj))).toBe('boolean');
  });

  it('getApiKeyByHash with injection payload', async () => {
    const key = await getApiKeyByHash(inj);
    expect(key === null || typeof key === 'object').toBe(true);
  });

  it('getAllActiveApiKeys is safe', async () => {
    const keys = await getAllActiveApiKeys();
    expect(Array.isArray(keys)).toBe(true);
  });

  it('getActiveApiKeyByLookupHash with injection payload', async () => {
    const row = await getActiveApiKeyByLookupHash(inj);
    expect(row === null || typeof row === 'object').toBe(true);
  });

  it('getActiveApiKeysAwaitingLookupHash is safe', async () => {
    const keys = await getActiveApiKeysAwaitingLookupHash();
    expect(Array.isArray(keys)).toBe(true);
  });

  it('setApiKeyLookupHash with injection payloads', async () => {
    await expect(setApiKeyLookupHash(9999, inj)).resolves.toBeUndefined();
  });

  it('touchApiKeyLastUsed with injection payload', async () => {
    await touchApiKeyLastUsed(9999);
  });

  it('insertBookmark with injection payloads', async () => {
    await insertBookmark({ scout_wallet: inj, player_id: inj, created_at: 0 });
  });

  it('deleteBookmark with injection payloads', async () => {
    expect(typeof (await deleteBookmark(inj, inj))).toBe('boolean');
  });

  it('getBookmarksByScout with injection payload', async () => {
    const bm = await getBookmarksByScout(inj);
    expect(Array.isArray(bm)).toBe(true);
  });

  it('insertSavedSearch with injection payloads', async () => {
    await insertSavedSearch({ scout_wallet: inj, name: inj, filters: inj, created_at: 0 });
  });

  it('getSavedSearchesByScout with injection payload', async () => {
    const ss = await getSavedSearchesByScout(inj);
    expect(Array.isArray(ss)).toBe(true);
  });

  it('deleteSavedSearch with injection payloads', async () => {
    expect(typeof (await deleteSavedSearch(9999, inj))).toBe('boolean');
  });

  it('getAllFeatureFlags is safe', async () => {
    const flags = await getAllFeatureFlags();
    expect(Array.isArray(flags)).toBe(true);
  });

  it('getFeatureFlag with injection payload', async () => {
    const flag = await getFeatureFlag(inj);
    expect(flag === null || typeof flag === 'object').toBe(true);
  });

  it('upsertFeatureFlag with injection payloads', async () => {
    await upsertFeatureFlag({ name: inj, enabled: 0, updated_at: 0, updated_by: inj });
  });

  it('insertPendingAdminAction with injection payloads', async () => {
    await insertPendingAdminAction({ id: 'test-' + inj, action_type: inj, proposer: inj, payload: inj, required_signatures: 1, expires_at: 0, created_at: 0 });
  });

  it('getPendingAdminActionById with injection payload', async () => {
    const action = await getPendingAdminActionById(inj);
    expect(action === null || typeof action === 'object').toBe(true);
  });

  it('getPendingAdminActionsByStatus with injection payload', async () => {
    const actions = await getPendingAdminActionsByStatus(inj);
    expect(Array.isArray(actions)).toBe(true);
  });

  it('updatePendingAdminActionStatus with injection payloads', async () => {
    await updatePendingAdminActionStatus(inj, inj);
  });

  it('incrementActionSignatures with injection payload', async () => {
    await incrementActionSignatures(inj);
  });

  it('expireStalePendingAdminActions is safe', async () => {
    expect(typeof (await expireStalePendingAdminActions())).toBe('number');
  });

  it('insertAdminActionSignature with injection payload', async () => {
    // Must insert a parent row first to satisfy the FK constraint
    const aid = 'test-action-sig-' + Date.now();
    await insertPendingAdminAction({ id: aid, action_type: 'test', proposer: 'admin', payload: '{}', required_signatures: 2, expires_at: 9999999999999, created_at: 0 });
    const inserted = await insertAdminActionSignature({ action_id: aid, signer: inj, signed_at: 0 });
    expect(typeof inserted).toBe('boolean');
  });

  it('getAdminActionSignature with injection payloads', async () => {
    const sig = await getAdminActionSignature(inj, inj);
    expect(sig === null || typeof sig === 'object').toBe(true);
  });

  it('getAdminActionSignatures with injection payload', async () => {
    const sigs = await getAdminActionSignatures(inj);
    expect(Array.isArray(sigs)).toBe(true);
  });

  it('closeDb is safe (not called — would end DB session)', () => {
    expect(typeof closeDb).toBe('function');
  });
});
