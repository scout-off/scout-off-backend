jest.mock('../../src/db/query', () => ({
  getDriver: jest.fn(),
  timedQueryAsync: jest.fn((_sql: string, run: () => unknown) => run()),
}));

// tests/setup.ts imports src/db before this file's mocks apply, so reload the
// repository after resetting the registry to bind it to the mocked query module.
function load() {
  jest.resetModules();
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { getBookmarkFoldersWithCounts } =
    require('../../src/db/repositories/bookmarks') as typeof import('../../src/db/repositories/bookmarks');
  const { getDriver } = require('../../src/db/query') as typeof import('../../src/db/query');
  /* eslint-enable @typescript-eslint/no-require-imports */
  return { getBookmarkFoldersWithCounts, getDriver };
}

describe('getBookmarkFoldersWithCounts (#1792)', () => {
  it('executes exactly one grouped query and returns numeric counts including empty folders', async () => {
    const { getBookmarkFoldersWithCounts, getDriver } = load();
    const all = jest.fn().mockResolvedValue([
      { id: 2, scout_wallet: 'GSCOUT', name: 'new', created_at: 20, bookmark_count: '50' },
      { id: 1, scout_wallet: 'GSCOUT', name: 'empty', created_at: 10, bookmark_count: '0' },
    ]);
    (getDriver as jest.Mock).mockReturnValue({ all });

    const rows = await getBookmarkFoldersWithCounts('GSCOUT');

    expect(all).toHaveBeenCalledTimes(1);
    expect(all.mock.calls[0][0]).toMatch(/LEFT JOIN scout_bookmarks/i);
    expect(all.mock.calls[0][0]).toMatch(/GROUP BY f\.id/i);
    expect(all.mock.calls[0][1]).toEqual(['GSCOUT']);
    expect(rows.map(({ bookmark_count }) => bookmark_count)).toEqual([50, 0]);
    expect(rows[0]).toMatchObject({ name: 'new', scout_wallet: 'GSCOUT' });
  });
});
