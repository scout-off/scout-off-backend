import fs from 'fs';
import path from 'path';

/**
 * #1535 — `src/db/index.ts` is a thin barrel over `src/db/repositories/*`, with
 * the shared plumbing in `src/db/query.ts`. These assertions keep the split
 * from regressing (a new helper added straight to the barrel would grow it
 * past the limit, and a repository that imports the barrel would reintroduce a
 * cycle).
 */

const DB_DIR = path.join(__dirname, '../../src/db');
const REPOS_DIR = path.join(DB_DIR, 'repositories');
const INDEX_PATH = path.join(DB_DIR, 'index.ts');

function repositoryFiles(): string[] {
  return fs
    .readdirSync(REPOS_DIR)
    .filter((file) => file.endsWith('.ts'))
    .sort();
}

describe('db module split (#1535)', () => {
  it('src/db/index.ts is a barrel under 300 lines', () => {
    const source = fs.readFileSync(INDEX_PATH, 'utf-8');
    expect(source.split('\n').length).toBeLessThan(300);
    expect(source).toContain("from './query'");
    // Destructured re-exports keep the barrel's properties writable, so
    // jest.spyOn(db, 'helper') keeps working after the split.
    expect(source).toMatch(/export const \{[^}]+\} = query/);
  });

  it('re-exports every repository module', () => {
    const index = fs.readFileSync(INDEX_PATH, 'utf-8');
    for (const file of repositoryFiles()) {
      const moduleName = file.replace(/\.ts$/, '');
      expect(index).toContain(`'./repositories/${moduleName}'`);
    }
  });

  it('moves every query helper out of the barrel', () => {
    const index = fs.readFileSync(INDEX_PATH, 'utf-8');
    // No function implementations left behind — only re-exports.
    expect(index).not.toMatch(/^export (async )?function /m);
    expect(index).not.toMatch(/^function /m);
  });

  it('documents the driver status in every repository header', () => {
    for (const file of repositoryFiles()) {
      const source = fs.readFileSync(path.join(REPOS_DIR, file), 'utf-8');
      const header = source.split('\n').slice(0, 15).join('\n');
      expect(header).toMatch(/Driver status: (fully on|mixed|SQLite-only)/);
    }
  });

  it('keeps repositories independent of the barrel (no import cycle)', () => {
    for (const file of repositoryFiles()) {
      const source = fs.readFileSync(path.join(REPOS_DIR, file), 'utf-8');
      expect(source).not.toMatch(/from '\.\.\/index'/);
      expect(source).not.toMatch(/from "\.\.\/index"/);
    }
  });

  it('has per-domain modules for the documented domains', () => {
    const names = repositoryFiles().map((file) => file.replace(/\.ts$/, ''));
    // Pending milestones live in players.ts alongside the player helpers;
    // webhooks are split into subscriptions / dead letters / deliveries.
    const domains: Record<string, string[]> = {
      players: ['players'],
      milestones: ['players'],
      events: ['events'],
      indexerState: ['indexerState'],
      subscriptions: ['subscriptions'],
      contacts: ['contacts'],
      apiKeys: ['apiKeys'],
      bookmarks: ['bookmarks'],
      notes: ['notes'],
      savedSearches: ['savedSearches'],
      webhooks: ['webhookSubscriptions', 'webhookDeadLetters', 'webhookDeliveries'],
      featureFlags: ['featureFlags'],
      audit: ['audit'],
      idempotency: ['idempotency'],
      walletBlocklist: ['walletBlocklist'],
    };
    for (const [domain, candidates] of Object.entries(domains)) {
      expect({ domain, present: names.some((name) => candidates.includes(name)) }).toEqual({
        domain,
        present: true,
      });
    }
  });

  it('SQL-injection scanner walks the repositories directory', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '../../scripts/check-sql-injection.js'),
      'utf-8',
    );
    expect(script).toContain('scanDir');
  });
});
