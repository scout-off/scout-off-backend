/**
 * Soroban RPC startup and health checks (issue #1824).
 *
 * Performs three checks against the configured SOROBAN_RPC_URL:
 *
 * 1. Passphrase match — getNetwork().passphrase must equal config.networkPassphrase.
 *    A mismatch means the RPC is pointing at a different network (e.g. testnet
 *    RPC + mainnet passphrase), which causes all transactions to fail silently.
 *    Hard failure in production; warning elsewhere.
 *
 * 2. Protocol version — the RPC's reported protocolVersion must be >= the
 *    configured minimum (SOROBAN_RPC_MIN_PROTOCOL_VERSION, default 20).
 *    A stale node may lack methods the backend depends on.
 *    Hard failure when configured to be strict; warning otherwise.
 *
 * 3. Ledger liveness — getLatestLedger() must return a sequence number that
 *    has advanced compared to a prior poll within SOROBAN_RPC_LEDGER_STUCK_MS
 *    milliseconds (default 60 000 ms). A stuck ledger means the RPC is not
 *    receiving new ledgers from the network.
 *
 * Results are exposed through:
 *   - probeSorobanRpcCheck() — called by /health/dependencies
 *   - Prometheus gauges: stellar_rpc_network_match, stellar_rpc_protocol_version
 *   - Hard failure at startup (via runSorobanRpcStartupCheck) in production
 */

import { rpc } from '@stellar/stellar-sdk';
import config from '../config';
import { logger } from '../utils/logger';

// ── Gauge state (read by metrics.ts) ─────────────────────────────────────────

/** 1 = network passphrase matches config, 0 = mismatch, -1 = unknown (RPC unreachable). */
let _networkMatchGauge: number = -1;
/** Reported protocol version, or -1 when unknown. */
let _protocolVersionGauge: number = -1;

export function getStellarRpcNetworkMatchGauge(): number { return _networkMatchGauge; }
export function getStellarRpcProtocolVersionGauge(): number { return _protocolVersionGauge; }

// ── Liveness tracking ─────────────────────────────────────────────────────────

interface LedgerSnapshot {
  sequence: number;
  seenAtMs: number;
}

let _lastLedgerSnapshot: LedgerSnapshot | null = null;

// ── Types ─────────────────────────────────────────────────────────────────────

export type RpcCheckSeverity = 'ok' | 'warning' | 'error';

export interface RpcCheckResult {
  passphrase: RpcCheckSeverity;
  passphraseDetail: string;
  protocolVersion: RpcCheckSeverity;
  protocolVersionDetail: string;
  ledgerLiveness: RpcCheckSeverity;
  ledgerLivenessDetail: string;
  overall: RpcCheckSeverity;
}

// ── Config knobs ──────────────────────────────────────────────────────────────

function getMinProtocolVersion(): number {
  return config.sorobanRpc?.minProtocolVersion ?? 20;
}

function getLedgerStuckMs(): number {
  return config.sorobanRpc?.ledgerStuckMs ?? 60_000;
}

// ── Core check ────────────────────────────────────────────────────────────────

/**
 * Run the three Soroban RPC checks and return a structured result.
 * Never throws — all RPC errors are caught and reflected in the result.
 */
export async function probeSorobanRpcCheck(): Promise<RpcCheckResult> {
  const rawServer = new rpc.Server(config.sorobanRpcUrl, {
    allowHttp: config.sorobanRpcUrl.startsWith('http://'),
    timeout: config.stellarRpcTimeoutMs,
  });

  // ── 1. Passphrase check ───────────────────────────────────────────────────
  let passphraseSeverity: RpcCheckSeverity = 'ok';
  let passphraseDetail = '';

  try {
    const network = await (rawServer as unknown as { getNetwork: () => Promise<{ passphrase: string; protocolVersion?: number }> }).getNetwork();
    const reported = network.passphrase ?? '';
    const expected = config.networkPassphrase;

    if (reported !== expected) {
      passphraseSeverity = 'error';
      passphraseDetail =
        `RPC passphrase "${reported}" does not match config "${expected}". ` +
        'The RPC node is on a different network. Correct SOROBAN_RPC_URL or NETWORK_PASSPHRASE.';
      _networkMatchGauge = 0;
    } else {
      passphraseDetail = `Passphrase matches: "${reported}"`;
      _networkMatchGauge = 1;
    }

    // ── 2. Protocol version check ─────────────────────────────────────────
    const version = typeof network.protocolVersion === 'number' ? network.protocolVersion : -1;
    _protocolVersionGauge = version;
    const minVersion = getMinProtocolVersion();

    let protocolSeverity: RpcCheckSeverity = 'ok';
    let protocolDetail = `Protocol version ${version}`;

    if (version < 0) {
      protocolSeverity = 'warning';
      protocolDetail = 'RPC did not report a protocol version.';
    } else if (version < minVersion) {
      protocolSeverity = config.sorobanRpc?.strictProtocolVersion ? 'error' : 'warning';
      protocolDetail =
        `RPC protocol version ${version} is below the configured minimum ${minVersion}. ` +
        'Some methods may be unavailable. Upgrade the RPC node.';
    }

    // ── 3. Ledger liveness check ──────────────────────────────────────────
    let livenessSeverity: RpcCheckSeverity = 'ok';
    let livenessDetail = '';

    try {
      const latestLedger = await rawServer.getLatestLedger();
      const seq = latestLedger.sequence;
      const now = Date.now();
      const stuckMs = getLedgerStuckMs();

      if (_lastLedgerSnapshot === null) {
        _lastLedgerSnapshot = { sequence: seq, seenAtMs: now };
        livenessDetail = `Latest ledger: ${seq} (first observation)`;
      } else if (seq > _lastLedgerSnapshot.sequence) {
        _lastLedgerSnapshot = { sequence: seq, seenAtMs: now };
        livenessDetail = `Latest ledger: ${seq} (advancing)`;
      } else {
        const staleMs = now - _lastLedgerSnapshot.seenAtMs;
        if (staleMs > stuckMs) {
          livenessSeverity = 'warning';
          livenessDetail =
            `Ledger sequence ${seq} has not advanced in ${Math.round(staleMs / 1000)} s ` +
            `(stuck threshold: ${Math.round(stuckMs / 1000)} s). ` +
            'The RPC node may not be receiving new ledgers.';
        } else {
          livenessDetail = `Latest ledger: ${seq} (not yet advanced; within tolerance)`;
        }
      }
    } catch (livenessErr) {
      livenessSeverity = 'warning';
      livenessDetail = `getLatestLedger failed: ${livenessErr instanceof Error ? livenessErr.message : String(livenessErr)}`;
    }

    const severity = (s: RpcCheckSeverity): number => s === 'error' ? 2 : s === 'warning' ? 1 : 0;
    const worstSeverity = [passphraseSeverity, protocolSeverity, livenessSeverity].reduce(
      (worst, s) => severity(s) > severity(worst) ? s : worst,
      'ok' as RpcCheckSeverity,
    );

    return {
      passphrase: passphraseSeverity,
      passphraseDetail,
      protocolVersion: protocolSeverity,
      protocolVersionDetail: protocolDetail,
      ledgerLiveness: livenessSeverity,
      ledgerLivenessDetail: livenessDetail,
      overall: worstSeverity,
    };
  } catch (rpcErr) {
    _networkMatchGauge = -1;
    _protocolVersionGauge = -1;
    const msg = rpcErr instanceof Error ? rpcErr.message : String(rpcErr);
    return {
      passphrase: 'error',
      passphraseDetail: `RPC unreachable: ${msg}`,
      protocolVersion: 'error',
      protocolVersionDetail: `RPC unreachable: ${msg}`,
      ledgerLiveness: 'error',
      ledgerLivenessDetail: `RPC unreachable: ${msg}`,
      overall: 'error',
    };
  }
}

// ── Startup check ─────────────────────────────────────────────────────────────

/**
 * Run the checks at process startup.  A passphrase mismatch in production
 * throws an error (which index.ts will catch and exit on).  Protocol version
 * failures emit warnings in non-strict mode.
 *
 * Call this early in src/index.ts before the server starts accepting requests.
 */
export async function runSorobanRpcStartupCheck(): Promise<void> {
  if (!config.stellarHealthCheckEnabled) {
    logger.info('[soroban-check] STELLAR_HEALTH_CHECK=false — skipping Soroban RPC startup check.');
    return;
  }

  let result: RpcCheckResult;
  try {
    result = await probeSorobanRpcCheck();
  } catch (e) {
    // probeSorobanRpcCheck never throws, but be safe.
    logger.warn('[soroban-check] Unexpected error during startup check:', e);
    return;
  }

  // Passphrase mismatch
  if (result.passphrase === 'error') {
    const msg = `[soroban-check] FATAL: ${result.passphraseDetail}`;
    if (config.nodeEnv === 'production') {
      throw new Error(msg);
    } else {
      logger.error(msg);
    }
  }

  // Protocol version
  if (result.protocolVersion === 'error') {
    const msg = `[soroban-check] FATAL: ${result.protocolVersionDetail}`;
    if (config.nodeEnv === 'production') {
      throw new Error(msg);
    } else {
      logger.error(msg);
    }
  } else if (result.protocolVersion === 'warning') {
    logger.warn(`[soroban-check] WARNING: ${result.protocolVersionDetail}`);
  }

  // Ledger liveness (warning only at startup — it can't have stuck yet)
  if (result.ledgerLiveness === 'warning') {
    logger.warn(`[soroban-check] WARNING: ${result.ledgerLivenessDetail}`);
  }

  if (result.overall === 'ok') {
    logger.info(`[soroban-check] RPC checks passed. ${result.passphraseDetail}`);
  }
}
