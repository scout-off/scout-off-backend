#!/usr/bin/env node
/**
 * scout-off-admin — Operator CLI for common maintenance tasks.
 *
 * Issue #1823: replaces raw curl + SQL runbook steps with a typed CLI that:
 *   - calls the same service layer used by HTTP controllers (no duplicated logic)
 *   - requires --operator <name> for every mutating command (audit attribution)
 *   - refuses to run mutating commands in production without --yes
 *   - emits JSON output with --json
 *
 * Entry point: node dist/cli/index.js <command> [options]
 *
 * Commands
 * ─────────
 *   reindex start --from <ledger>        Start a background reindex from <ledger>
 *   reindex status                       Print current reindex job status
 *   reindex cancel                       Cancel a running reindex job
 *
 *   dlq list [--limit N]                 List dead-letter queue entries
 *   dlq requeue <id>                     Requeue a single dead-letter entry
 *   dlq purge --older-than 30d           Purge dead-letter entries older than N days/hours
 *
 *   tokens revoke --jti <id>             Revoke a JWT by its JTI claim
 *   tokens revoke-wallet <G...>          Revoke all active API keys for a wallet
 *
 *   flags list                           List all feature flags
 *   flags set <name> <true|false>        Set a feature flag value
 *       --reason "..."
 *
 *   audit verify                         Verify the audit-log hash chain
 *
 *   migrate status                       Show applied/pending migration status
 *   migrate up                           Apply pending migrations
 */

import { parseArgs } from 'node:util';
import process from 'node:process';

// ── Lazy imports ──────────────────────────────────────────────────────────────
// Services are imported inside command handlers so the module-level side
// effects of importing config (dotenv, validation) only run once at startup,
// and so individual test mocks work per-command without importing everything.

async function getServices() {
  // All service imports are deferred to avoid running config side-effects in
  // imports that run before the args are parsed.
  const [
    { startReindex, getReindexStatus, cancelReindex },
    { listWebhookDeadLetters, markWebhookDeadLetterReplayed, purgeOldWebhookDeadLetters, getWebhookDeadLetterById },
    { revokeToken, getActiveRevokedJtis },
    { isFeatureEnabled, setFeatureFlag },
    { insertAuditLog },
    { initDb, getDriver },
    migrateModule,
    migrationStatusModule,
  ] = await Promise.all([
    import('../services/reindexService'),
    import('../db'),
    import('../services/tokenBlocklist'),
    import('../services/featureFlags'),
    import('../db'),
    import('../db'),
    import('../db/migrate'),
    import('../db/migration-status'),
  ]);

  return {
    startReindex,
    getReindexStatus,
    cancelReindex,
    listWebhookDeadLetters,
    markWebhookDeadLetterReplayed,
    purgeOldWebhookDeadLetters,
    getWebhookDeadLetterById,
    revokeToken,
    getActiveRevokedJtis,
    isFeatureEnabled,
    setFeatureFlag,
    insertAuditLog,
    initDb,
    getDriver,
    runMigrations: migrateModule.runMigrations,
    discoverMigrationFiles: migrationStatusModule.discoverMigrationFiles,
    getAppliedMigrations: migrationStatusModule.getAppliedMigrations,
    generateStatusReport: migrationStatusModule.generateStatusReport,
    formatStatusReport: migrationStatusModule.formatStatusReport,
  };
}

// ── Output helpers ────────────────────────────────────────────────────────────

let jsonMode = false;

function out(data: unknown): void {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else if (typeof data === 'string') {
    process.stdout.write(data + '\n');
  } else {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  }
}

function err(message: string, detail?: unknown): void {
  if (jsonMode) {
    process.stderr.write(JSON.stringify({ error: message, detail: detail ?? null }) + '\n');
  } else {
    process.stderr.write(`ERROR: ${message}${detail ? `\n  ${String(detail)}` : ''}\n`);
  }
}

// ── Production guard ──────────────────────────────────────────────────────────

function requireYes(yes: boolean): void {
  const env = process.env.NODE_ENV ?? 'development';
  if ((env === 'production' || env === 'staging') && !yes) {
    err(
      `Mutating commands require --yes in ${env}. ` +
      'Pass --yes to confirm you intend to modify production data.',
    );
    process.exit(1);
  }
}

// ── Audit helper ──────────────────────────────────────────────────────────────

async function writeAudit(
  insertAuditLogFn: Awaited<ReturnType<typeof getServices>>['insertAuditLog'],
  operator: string,
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await insertAuditLogFn({
      action,
      adminWallet: `cli:${operator}`,
      queryParams: detail,
      eventSource: 'cli',
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Non-fatal: audit failure must not prevent the operation from completing.
  }
}

// ── Command: reindex ─────────────────────────────────────────────────────────

async function cmdReindex(
  sub: string,
  positional: string[],
  flags: Record<string, unknown>,
  operator: string,
  yes: boolean,
): Promise<void> {
  const { startReindex, getReindexStatus, cancelReindex, insertAuditLog } = await getServices();

  switch (sub) {
    case 'start': {
      const from = typeof flags['from'] === 'string' ? parseInt(flags['from'], 10) : NaN;
      if (Number.isNaN(from) || from < 0) {
        err('--from <ledger> is required and must be a non-negative integer');
        process.exit(1);
      }
      requireYes(yes);
      startReindex(from, 0, operator);
      await writeAudit(insertAuditLog, operator, 'cli_reindex_start', { from });
      out(jsonMode ? { ok: true, from } : `Reindex started from ledger ${from}.`);
      break;
    }
    case 'status': {
      const status = getReindexStatus();
      out(jsonMode ? status : `Status: ${status.status}  ledger: ${status.ledgersProcessed}/${status.ledgersTotal}  mode: ${status.mode}`);
      break;
    }
    case 'cancel': {
      requireYes(yes);
      const cancelled = cancelReindex(operator);
      await writeAudit(insertAuditLog, operator, 'cli_reindex_cancel', {});
      out(jsonMode ? { ok: cancelled } : (cancelled ? 'Reindex cancelled.' : 'No running reindex to cancel.'));
      break;
    }
    default:
      void positional;
      err(`Unknown reindex sub-command: "${sub}". Use: start | status | cancel`);
      process.exit(1);
  }
}

// ── Command: dlq ─────────────────────────────────────────────────────────────

async function cmdDlq(
  sub: string,
  positional: string[],
  flags: Record<string, unknown>,
  operator: string,
  yes: boolean,
): Promise<void> {
  const {
    listWebhookDeadLetters,
    markWebhookDeadLetterReplayed,
    purgeOldWebhookDeadLetters,
    getWebhookDeadLetterById,
    insertAuditLog,
  } = await getServices();

  switch (sub) {
    case 'list': {
      const limit = typeof flags['limit'] === 'string' ? parseInt(flags['limit'], 10) : 50;
      const rows = await listWebhookDeadLetters(limit, 0);
      out(jsonMode ? rows : rows.map((r) => `${r.id}  ${r.event_type}  ${r.created_at}  status=${r.status}`).join('\n') || '(empty)');
      break;
    }
    case 'requeue': {
      const id = positional[0];
      if (!id) {
        err('Usage: dlq requeue <id>');
        process.exit(1);
      }
      requireYes(yes);
      const row = await getWebhookDeadLetterById(Number(id));
      if (!row) {
        err(`Dead-letter entry "${id}" not found.`);
        process.exit(1);
      }
      await markWebhookDeadLetterReplayed(Number(id));
      await writeAudit(insertAuditLog, operator, 'cli_dlq_requeue', { id });
      out(jsonMode ? { ok: true, id } : `Entry ${id} marked for replay.`);
      break;
    }
    case 'purge': {
      const olderThanRaw = typeof flags['older-than'] === 'string' ? flags['older-than'] : '30d';
      const days = parseDuration(olderThanRaw as string);
      if (days === null) {
        err(`--older-than must be like "30d" or "24h". Got: "${olderThanRaw}"`);
        process.exit(1);
      }
      requireYes(yes);
      const deleted = await purgeOldWebhookDeadLetters(days);
      await writeAudit(insertAuditLog, operator, 'cli_dlq_purge', { olderThan: olderThanRaw, deleted });
      out(jsonMode ? { ok: true, deleted } : `Purged ${deleted} entries older than ${olderThanRaw}.`);
      break;
    }
    default:
      err(`Unknown dlq sub-command: "${sub}". Use: list | requeue | purge`);
      process.exit(1);
  }
}

/** Parse "30d" → 30, "24h" → 1 (days). Returns null on parse failure. */
function parseDuration(raw: string): number | null {
  const match = raw.match(/^(\d+)(d|h)$/);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return match[2] === 'h' ? n / 24 : n;
}

// ── Command: tokens ───────────────────────────────────────────────────────────

async function cmdTokens(
  sub: string,
  positional: string[],
  flags: Record<string, unknown>,
  operator: string,
  yes: boolean,
): Promise<void> {
  const { revokeToken, insertAuditLog } = await getServices();

  switch (sub) {
    case 'revoke': {
      const jti = typeof flags['jti'] === 'string' ? flags['jti'] : null;
      if (!jti) {
        err('Usage: tokens revoke --jti <id>');
        process.exit(1);
      }
      requireYes(yes);
      // Expire far in the future (year 2099) so the revocation persists.
      const expiresAt = Math.floor(new Date('2099-01-01').getTime() / 1000);
      await revokeToken(jti, expiresAt);
      await writeAudit(insertAuditLog, operator, 'cli_token_revoke', { jti });
      out(jsonMode ? { ok: true, jti } : `Token ${jti} revoked.`);
      break;
    }
    case 'revoke-wallet': {
      const wallet = positional[0];
      if (!wallet) {
        err('Usage: tokens revoke-wallet <G...>');
        process.exit(1);
      }
      requireYes(yes);
      // Revoke all active API keys for the wallet via the DB.
      const { listApiKeysByWallet, revokeApiKeyById } = await import('../db');
      const keys = await listApiKeysByWallet(wallet);
      let count = 0;
      for (const key of keys) {
        if (!key.revoked_at) {
          await revokeApiKeyById(key.id, wallet);
          count++;
        }
      }
      await writeAudit(insertAuditLog, operator, 'cli_token_revoke_wallet', { wallet, count });
      out(jsonMode ? { ok: true, wallet, revokedKeys: count } : `Revoked ${count} API key(s) for wallet ${wallet}.`);
      break;
    }
    default:
      err(`Unknown tokens sub-command: "${sub}". Use: revoke | revoke-wallet`);
      process.exit(1);
  }
}

// ── Command: flags ────────────────────────────────────────────────────────────

async function cmdFlags(
  sub: string,
  positional: string[],
  flags: Record<string, unknown>,
  operator: string,
  yes: boolean,
): Promise<void> {
  const { isFeatureEnabled, setFeatureFlag, insertAuditLog } = await getServices();

  switch (sub) {
    case 'list': {
      // List all known flags.  FeatureFlags enum is the canonical list.
      const { FeatureFlags } = await import('../services/featureFlags');
      const results: Record<string, boolean> = {};
      for (const name of Object.values(FeatureFlags)) {
        results[name] = await isFeatureEnabled(name);
      }
      out(jsonMode ? results : Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('\n'));
      break;
    }
    case 'set': {
      const name = positional[0];
      const value = positional[1];
      const reason = typeof flags['reason'] === 'string' ? flags['reason'] : '';
      if (!name || (value !== 'true' && value !== 'false')) {
        err('Usage: flags set <name> <true|false> [--reason "..."]');
        process.exit(1);
      }
      requireYes(yes);
      await setFeatureFlag(name, value === 'true', operator);
      await writeAudit(insertAuditLog, operator, 'cli_flag_set', { name, value, reason });
      out(jsonMode ? { ok: true, name, value } : `Flag "${name}" set to ${value}.${reason ? ` Reason: ${reason}` : ''}`);
      break;
    }
    default:
      err(`Unknown flags sub-command: "${sub}". Use: list | set`);
      process.exit(1);
  }
}

// ── Command: audit verify ─────────────────────────────────────────────────────

async function cmdAuditVerify(): Promise<void> {
  const { runScheduledAuditChainVerification } = await import('../services/auditChainVerifier');
  await runScheduledAuditChainVerification();
  out(jsonMode ? { ok: true } : 'Audit chain verification complete. Check logs for any breaks.');
}

// ── Command: migrate ──────────────────────────────────────────────────────────

async function cmdMigrate(
  sub: string,
  _positional: string[],
  _flags: Record<string, unknown>,
  operator: string,
  yes: boolean,
): Promise<void> {
  const {
    initDb, getDriver, runMigrations,
    discoverMigrationFiles, getAppliedMigrations, generateStatusReport, formatStatusReport,
    insertAuditLog,
  } = await getServices();

  switch (sub) {
    case 'status': {
      await initDb();
      const driver = getDriver();
      const migrationsDir = `${process.cwd()}/src/db/migrations`;
      const files = discoverMigrationFiles(migrationsDir);
      // Use the async version from migrate.ts that accepts the DbDriver abstraction.
      const { getAppliedMigrations: getAppliedMigrationsAsync } = await import('../db/migrate');
      const applied = await getAppliedMigrationsAsync(driver);
      const report = generateStatusReport(files, applied);
      out(jsonMode ? report : formatStatusReport(report));
      break;
    }
    case 'up': {
      requireYes(yes);
      await initDb();
      const driver = getDriver();
      await runMigrations(driver);
      await writeAudit(insertAuditLog, operator, 'cli_migrate_up', {});
      out(jsonMode ? { ok: true } : 'Migrations applied.');
      break;
    }
    default:
      err(`Unknown migrate sub-command: "${sub}". Use: status | up`);
      process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

function usage(): void {
  process.stdout.write(`
scout-off-admin — ScoutOff operator CLI

Usage:
  node dist/cli/index.js <command> <sub-command> [args] [options]

Global options:
  --operator <name>   Your name or handle (required for mutating commands)
  --yes               Confirm mutating commands in production/staging
  --json              Emit JSON output

Commands:
  reindex start --from <ledger>        Start background reindex from ledger
  reindex status                       Show current reindex job state
  reindex cancel                       Cancel a running reindex job

  dlq list [--limit N]                 List dead-letter queue entries
  dlq requeue <id>                     Mark a dead-letter entry for replay
  dlq purge --older-than <Nd|Nh>       Purge entries older than N days/hours

  tokens revoke --jti <id>             Revoke a JWT by JTI
  tokens revoke-wallet <G...>          Revoke all API keys for a wallet

  flags list                           List feature flags
  flags set <name> <true|false>        Set a feature flag
        --reason "..."

  audit verify                         Verify audit-log hash chain

  migrate status                       Show applied/pending migrations
  migrate up                           Apply pending migrations
`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      operator: { type: 'string' },
      yes:      { type: 'boolean', default: false },
      json:     { type: 'boolean', default: false },
      from:     { type: 'string' },
      jti:      { type: 'string' },
      reason:   { type: 'string' },
      limit:    { type: 'string' },
      'older-than': { type: 'string' },
    },
  });

  jsonMode = values.json === true;

  const [command, sub, ...rest] = positionals;

  if (!command || command === '--help' || command === 'help') {
    usage();
    process.exit(0);
  }

  const operator = typeof values.operator === 'string' ? values.operator.trim() : '';
  const yes = values.yes === true;

  // Mutating commands require --operator.
  const readOnly = new Set(['reindex status', 'dlq list', 'flags list', 'migrate status', 'audit verify']);
  const cmdKey = `${command} ${sub ?? ''}`.trim();
  if (!readOnly.has(cmdKey) && !operator) {
    err('--operator <name> is required for mutating commands.');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'reindex':
        await cmdReindex(sub ?? '', rest, values as Record<string, unknown>, operator, yes);
        break;
      case 'dlq':
        await cmdDlq(sub ?? '', rest, values as Record<string, unknown>, operator, yes);
        break;
      case 'tokens':
        await cmdTokens(sub ?? '', rest, values as Record<string, unknown>, operator, yes);
        break;
      case 'flags':
        await cmdFlags(sub ?? '', rest, values as Record<string, unknown>, operator, yes);
        break;
      case 'audit':
        if (sub === 'verify') {
          await cmdAuditVerify();
        } else {
          err(`Unknown audit sub-command: "${sub}". Use: verify`);
          process.exit(1);
        }
        break;
      case 'migrate':
        await cmdMigrate(sub ?? '', rest, values as Record<string, unknown>, operator, yes);
        break;
      default:
        err(`Unknown command: "${command}".`);
        usage();
        process.exit(1);
    }
  } catch (e) {
    err('Command failed', e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
