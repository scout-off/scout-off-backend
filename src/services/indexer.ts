/**
 * Indexer service — stable public entry point.
 *
 * The 1,100-line implementation that used to live here is now split into
 * cohesive modules under ./indexer:
 *
 *   - decode.ts    pure decoding/normalisation of raw Soroban events
 *   - fetch.ts     RPC polling + contract-filter chunking (getIndexedContractIds)
 *   - apply.ts     DB application, reorg detection, cursor persistence, replay
 *   - dispatch.ts  SSE broadcast + webhook fan-out (pipeline-internal)
 *   - registry.ts  local mirrors: trial-offer log + validator registry
 *   - state.ts     mutable lag/counter state read by src/app.ts
 *
 * This file stays a thin barrel so every existing `./services/indexer` import,
 * `jest.mock` factory and `jest.requireActual` keeps resolving to exactly the
 * same named exports. Values are re-exported as plain (configurable) own
 * properties so tests can still `jest.spyOn` them; the lag counters are
 * re-exported as live getters so src/app.ts always observes the current value.
 */

import * as decode from './indexer/decode';
import * as fetchMod from './indexer/fetch';
import * as applyMod from './indexer/apply';
import * as registry from './indexer/registry';

// ─── decode ───────────────────────────────────────────────────────────────────
export const normalizePayload = decode.normalizePayload;
export const normalizeSorobanEvent = decode.normalizeSorobanEvent;
export const isKnownEventType = decode.isKnownEventType;
export const serializeEventForReplay = decode.serializeEventForReplay;
export const deserializeEventFromReplay = decode.deserializeEventFromReplay;

// ─── fetch ────────────────────────────────────────────────────────────────────
export const getIndexedContractIds = fetchMod.getIndexedContractIds;

// ─── apply ────────────────────────────────────────────────────────────────────
export const normalizeEventId = applyMod.normalizeEventId;
export const __indexerHooks = applyMod.__indexerHooks;
export const indexEvents = applyMod.indexEvents;
export const replayUnprocessedEvent = applyMod.replayUnprocessedEvent;

// ─── registry ─────────────────────────────────────────────────────────────────
export const insertTrialOffer = registry.insertTrialOffer;
export const getTrialOffers = registry.getTrialOffers;
export const insertValidator = registry.insertValidator;
export const revokeValidatorRow = registry.revokeValidatorRow;
export const getAllValidators = registry.getAllValidators;
export const getValidatorByWallet = registry.getValidatorByWallet;

export type TrialOfferEventRow = registry.TrialOfferEventRow;
export type ValidatorRow = registry.ValidatorRow;

// ─── state (live bindings, read by src/app.ts) ────────────────────────────────
export { indexerLedgerLag, indexerLastSuccessAt, indexerPollFailuresTotal } from './indexer/state';
