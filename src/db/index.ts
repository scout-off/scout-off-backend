/**
 * Database barrel (#1535).
 *
 * The former 3,500-line module that lived here has been split into
 * `src/db/repositories/<domain>.ts` modules. This barrel re-exports every one
 * of them so existing call sites keep working unchanged; new code may import
 * from the specific repository module directly.
 *
 * Shared plumbing — connection lifecycle (`initDb`/`closeDb`), driver access
 * (`getDb`/`getDriver`) and the timing wrappers (`timedQuery`,
 * `timedQueryAsync`) — lives in `src/db/query.ts`. Repositories depend on that
 * module, never on this barrel, so the import graph stays acyclic.
 *
 * Re-exports are deliberately written as destructured `export const` rather
 * than `export *`: TypeScript compiles `export *` to non-configurable getters,
 * which would silently break `jest.spyOn(db, 'someHelper')` (and any other
 * consumer that patches the barrel) across the test suite. Destructuring
 * emits plain writable assignments, preserving the pre-split behaviour.
 */

import * as query from './query';
import * as adminActions from './repositories/adminActions';
import * as analytics from './repositories/analytics';
import * as apiKeys from './repositories/apiKeys';
import * as audit from './repositories/audit';
import * as bookmarks from './repositories/bookmarks';
import * as contacts from './repositories/contacts';
import * as contractRoles from './repositories/contractRoles';
import * as events from './repositories/events';
import * as featureFlags from './repositories/featureFlags';
import * as feeWithdrawals from './repositories/feeWithdrawals';
import * as idempotency from './repositories/idempotency';
import * as indexerState from './repositories/indexerState';
import * as notes from './repositories/notes';
import * as pendingPins from './repositories/pendingPins';
import * as players from './repositories/players';
import * as profileViews from './repositories/profileViews';
import * as savedSearches from './repositories/savedSearches';
import * as subscriptions from './repositories/subscriptions';
import * as trialOffers from './repositories/trialOffers';
import * as walletBlocklist from './repositories/walletBlocklist';
import * as webhookDeadLetters from './repositories/webhookDeadLetters';
import * as webhookDeliveries from './repositories/webhookDeliveries';
import * as webhookSubscriptions from './repositories/webhookSubscriptions';

// ─── Types ────────────────────────────────────────────────────────────────────
export type * from './query';
export type * from './repositories/indexerState';
export type * from './repositories/events';
export type * from './repositories/players';
export type * from './repositories/idempotency';
export type * from './repositories/subscriptions';
export type * from './repositories/contacts';
export type * from './repositories/analytics';
export type * from './repositories/audit';
export type * from './repositories/trialOffers';
export type * from './repositories/pendingPins';
export type * from './repositories/notes';
export type * from './repositories/apiKeys';
export type * from './repositories/walletBlocklist';
export type * from './repositories/bookmarks';
export type * from './repositories/savedSearches';
export type * from './repositories/profileViews';
export type * from './repositories/featureFlags';
export type * from './repositories/webhookSubscriptions';
export type * from './repositories/webhookDeadLetters';
export type * from './repositories/webhookDeliveries';
export type * from './repositories/adminActions';
export type * from './repositories/feeWithdrawals';

// ─── Values ───────────────────────────────────────────────────────────────────
export const { timedQuery, timedQueryAsync, initDb, getDriver, getDb, closeDb } = query;
export const { insertPendingAdminAction, getPendingAdminActionById, getPendingAdminActionsByStatus, updatePendingAdminActionStatus, incrementActionSignatures, expireStalePendingAdminActions, insertAdminActionSignature, getAdminActionSignature, getAdminActionSignatures } = adminActions;
export const { getNewPlayersTimeSeries, getMilestonesApprovedTimeSeries, getContactUnlocksTimeSeries, getSubscriptionsStartedTimeSeries, getNewPlayersByRegionTimeSeries } = analytics;
export const { insertApiKey, listApiKeysByWallet, revokeApiKeyById, getApiKeyByHash, getApiKeyById, getAllActiveApiKeys, getActiveApiKeyIds, getActiveApiKeyByLookupHash, getActiveApiKeysAwaitingLookupHash, scheduleApiKeyRevocation, setApiKeyLookupHash, touchApiKeyLastUsed } = apiKeys;
export const { insertAuditLog, getAuditLogRowsAfterId, getAuditLogs, getAuditLogsCount, getAllAuditLogRows } = audit;
export const { insertBookmark, deleteBookmark, getBookmarksByScout, insertBookmarkFolder, getBookmarkFoldersByScout, getBookmarkFolderById, deleteBookmarkFolder, moveBookmarksToRoot, countBookmarksInFolder, getBookmarkedPlayersWithDetails, countBookmarkedPlayers } = bookmarks;
export const { insertContactUnlock, getContactUnlocksByScout, getContactUnlocksByPlayer, hasContactUnlock } = contacts;
export const { listContractRoleMembers } = contractRoles;
export const { queryEvents, getEvents, rollbackEventsFromLedger, getEventsCount, encodeEventsCursor, decodeEventsCursor, getEventsPageKeyset, countEventsFiltered, getEventsIterable, getEventsPage, insertUnprocessedEvent, listUnprocessedEvents, getUnprocessedEventById, deleteUnprocessedEvent } = events;
export const { getAllFeatureFlags, getFeatureFlag, upsertFeatureFlag } = featureFlags;
export const { insertFeeWithdrawal, getFeeWithdrawalByIdempotencyKey, listFeeWithdrawals, insertAdminFeeConfigLog, listAdminFeeConfigLog } = feeWithdrawals;
export const { releaseIdempotencyKey, getIdempotencyRecord, claimIdempotencyKey, updateIdempotencyRecord, saveIdempotencyRecord, purgeExpiredIdempotencyKeys } = idempotency;
export const { fetchLastIndexedLedger, getLastLedger, persistLastIndexedLedger, setLastLedger } = indexerState;
export const { upsertScoutNote, getScoutNote, getScoutNotes, insertScoutPlayerNote, getScoutPlayerNotes, updateScoutPlayerNote, deleteScoutPlayerNote } = notes;
export const { insertPendingPin, getPendingPins, deletePendingPin, deletePendingPinByHash, isPendingPinByHash, incrementPendingPinAttempts, setPendingPinResolvedCid, getResolvedCidByHash, getStalePendingPins, updatePendingPinReconciliation, countStuckPendingPins } = pendingPins;
export const { insertPlayerProfileHistory, getPlayerProfileHistory, getPlayerProfileHistoryVersioned, insertOrUpdatePlayer, upsertPlayer, updatePlayerProgress, incrementValidatorApproved, incrementValidatorRejected, getValidatorStats, insertPendingMilestone, removePendingMilestone, cancelPendingMilestonesForPlayer, getPendingMilestones, getPlayerById, getPlayerByWallet, getPlayerByOnChainId, getPlayersMissingOnChainId, setPlayerOnChainId, seedPlayerTokenSupply, getPlayerTokenInventory, purchasePlayerTokens, resetPlayerTokenRegistry, deactivatePlayer, deactivatePlayerWithReason, reactivatePlayer, reactivatePlayerWithReason, queryPlayers, countPlayers, searchPlayers } = players;
export const { recordProfileView, getLastProfileView, getProfileViewCount, getUniqueViewerCount, getContactUnlockCount } = profileViews;
export const { getAllActiveSavedSearches, getSavedSearchNotification, recordSavedSearchNotification, insertSavedSearch, getSavedSearchesByScout, deleteSavedSearch, getSavedSearchById, updateSavedSearch, countSavedSearchesByScout } = savedSearches;
export const { getLatestSubscription, getSubscriptionsByScout, insertSubscription, dbRenewSubscription, dbCancelSubscription } = subscriptions;
export const { getTrialOfferById, insertTrialOffer, respondToTrialOffer, cancelTrialOffer, countTrialOffersByPlayer } = trialOffers;
export const { blockWalletDb, unblockWalletDb, isWalletBlocklistedDb, listBlockedWalletsDb } = walletBlocklist;
export const { insertWebhookDeadLetter, listWebhookDeadLetters, countWebhookDeadLetters, countWebhookDeadLettersBySubscription, getWebhookDeadLetterById, markWebhookDeadLetterReplayed, claimWebhookDeadLetter, releaseWebhookDeadLetterClaim, updateWebhookDeadLetterAttempt, deleteWebhookDeadLetter, purgeOldWebhookDeadLetters } = webhookDeadLetters;
export const { insertWebhookDelivery, getWebhookDeliveries, getWebhookDeliverySummary, pruneWebhookDeliveries } = webhookDeliveries;
export const { createWebhookSubscription, listWebhookSubscriptions, getWebhookSubscriptionById, getWebhookSubscriptionsByScout, deleteWebhookSubscription, ensureLegacyWebhookSubscription, updateWebhookSubscriptionPreviousSecret, clearWebhookSubscriptionPreviousSecret, recordWebhookSubscriptionSuccess, recordWebhookSubscriptionFailure, reactivateWebhookSubscription, countWebhookSubscriptionsByStatus } = webhookSubscriptions;
