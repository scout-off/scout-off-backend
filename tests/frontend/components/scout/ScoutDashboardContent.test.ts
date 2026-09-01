/**
 * Tests for ScoutDashboardContent component (#683)
 *
 * Unit-tests the component's internal filtering, pagination, and empty-state
 * logic in isolation.  A page-level smoke test would only confirm the component
 * mounts; these tests verify the decision branches directly.
 */
import {
  ScoutDashboardContent,
  type Player,
  type FilterOptions,
  type DashboardState,
} from '../../../../src/frontend/components/scout/ScoutDashboardContent';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makePlayer(overrides: Partial<Player> = {}): Player {
  return {
    player_id:      overrides.player_id      ?? 'player-001',
    wallet:         overrides.wallet         ?? 'GAAKO6EK',
    position:       overrides.position       ?? 'Forward',
    region:         overrides.region         ?? 'West Africa',
    progress_level: overrides.progress_level ?? 0,
    metadataUri:    overrides.metadataUri    ?? null,
    created_at:     overrides.created_at     ?? 1_700_000_000,
  };
}

const PLAYERS: Player[] = [
  makePlayer({ player_id: 'p1', region: 'West Africa',  position: 'Forward',    progress_level: 0 }),
  makePlayer({ player_id: 'p2', region: 'West Africa',  position: 'Midfielder', progress_level: 1 }),
  makePlayer({ player_id: 'p3', region: 'East Africa',  position: 'Defender',   progress_level: 2 }),
  makePlayer({ player_id: 'p4', region: 'South America',position: 'Forward',    progress_level: 3 }),
  makePlayer({ player_id: 'p5', region: 'Europe',       position: 'Goalkeeper', progress_level: 1 }),
];

const BASE_FILTERS: FilterOptions = { page: 1, pageSize: 20 };

function makeState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    players: PLAYERS,
    total:   PLAYERS.length,
    loading: false,
    error:   null,
    filters: BASE_FILTERS,
    ...overrides,
  };
}

const dashboard = new ScoutDashboardContent();

// ─── applyFilters ─────────────────────────────────────────────────────────────

describe('applyFilters', () => {
  describe('region filter', () => {
    it('returns players matching the specified region', () => {
      const result = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, region: 'West Africa' });
      expect(result.map((p) => p.player_id)).toEqual(['p1', 'p2']);
    });

    it('returns empty array when no players are in the region', () => {
      const result = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, region: 'Antarctica' });
      expect(result).toHaveLength(0);
    });

    it('returns all players when region is undefined', () => {
      const result = dashboard.applyFilters(PLAYERS, BASE_FILTERS);
      expect(result).toHaveLength(PLAYERS.length);
    });

    it('returns all players when region is empty string', () => {
      const result = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, region: '' });
      expect(result).toHaveLength(PLAYERS.length);
    });
  });

  describe('position filter', () => {
    it('returns players matching the specified position', () => {
      const result = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, position: 'Forward' });
      expect(result.map((p) => p.player_id)).toEqual(['p1', 'p4']);
    });

    it('returns all players when position is undefined', () => {
      const result = dashboard.applyFilters(PLAYERS, BASE_FILTERS);
      expect(result).toHaveLength(PLAYERS.length);
    });

    it('returns all players when position is empty string', () => {
      const result = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, position: '' });
      expect(result).toHaveLength(PLAYERS.length);
    });
  });

  describe('minTier filter', () => {
    it('returns players at or above the minimum tier', () => {
      const result = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, minTier: 2 });
      expect(result.map((p) => p.player_id)).toEqual(['p3', 'p4']);
    });

    it('returns all players when minTier is 0', () => {
      const result = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, minTier: 0 });
      expect(result).toHaveLength(PLAYERS.length);
    });

    it('returns empty array when minTier is above all players', () => {
      const result = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, minTier: 4 });
      expect(result).toHaveLength(0);
    });
  });

  describe('combined filters', () => {
    it('applies region + position together', () => {
      const result = dashboard.applyFilters(PLAYERS, {
        ...BASE_FILTERS,
        region: 'West Africa',
        position: 'Forward',
      });
      expect(result.map((p) => p.player_id)).toEqual(['p1']);
    });

    it('applies region + minTier together', () => {
      const result = dashboard.applyFilters(PLAYERS, {
        ...BASE_FILTERS,
        region: 'West Africa',
        minTier: 1,
      });
      expect(result.map((p) => p.player_id)).toEqual(['p2']);
    });

    it('applies all three filters together', () => {
      const result = dashboard.applyFilters(PLAYERS, {
        ...BASE_FILTERS,
        region: 'West Africa',
        position: 'Midfielder',
        minTier: 1,
      });
      expect(result.map((p) => p.player_id)).toEqual(['p2']);
    });

    it('returns empty array when combined filters match nothing', () => {
      const result = dashboard.applyFilters(PLAYERS, {
        ...BASE_FILTERS,
        region: 'West Africa',
        position: 'Goalkeeper',
      });
      expect(result).toHaveLength(0);
    });
  });
});

// ─── paginatePlayers ──────────────────────────────────────────────────────────

describe('paginatePlayers', () => {
  it('returns the first page correctly', () => {
    const result = dashboard.paginatePlayers(PLAYERS, 1, 2);
    expect(result.data.map((p) => p.player_id)).toEqual(['p1', 'p2']);
    expect(result.total).toBe(5);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);
    expect(result.pages).toBe(3); // ceil(5/2)
  });

  it('returns the second page correctly', () => {
    const result = dashboard.paginatePlayers(PLAYERS, 2, 2);
    expect(result.data.map((p) => p.player_id)).toEqual(['p3', 'p4']);
  });

  it('returns a partial last page', () => {
    const result = dashboard.paginatePlayers(PLAYERS, 3, 2);
    expect(result.data.map((p) => p.player_id)).toEqual(['p5']);
  });

  it('returns empty array for a page beyond the last page', () => {
    const result = dashboard.paginatePlayers(PLAYERS, 99, 2);
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(5);
  });

  it('returns all items on page 1 when pageSize >= total', () => {
    const result = dashboard.paginatePlayers(PLAYERS, 1, 100);
    expect(result.data).toHaveLength(5);
    expect(result.pages).toBe(1);
  });

  it('returns 0 pages for an empty player list', () => {
    const result = dashboard.paginatePlayers([], 1, 20);
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.pages).toBe(0);
  });

  it('combined filter + pagination: filter first, then paginate', () => {
    // Filter to West Africa (2 players), paginate page 1 of 1
    const filtered = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, region: 'West Africa' });
    const paginated = dashboard.paginatePlayers(filtered, 1, 10);
    expect(paginated.data).toHaveLength(2);
    expect(paginated.total).toBe(2);
    expect(paginated.pages).toBe(1);
  });

  it('infinite-scroll simulation: subsequent pages append to previous results', () => {
    const page1 = dashboard.paginatePlayers(PLAYERS, 1, 2);
    const page2 = dashboard.paginatePlayers(PLAYERS, 2, 2);
    const accumulated = [...page1.data, ...page2.data];
    expect(accumulated.map((p) => p.player_id)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });
});

// ─── isEmpty ─────────────────────────────────────────────────────────────────

describe('isEmpty', () => {
  it('returns true when players array is empty and not loading', () => {
    const state = makeState({ players: [], total: 0 });
    expect(dashboard.isEmpty(state)).toBe(true);
  });

  it('returns false when players array is non-empty', () => {
    const state = makeState();
    expect(dashboard.isEmpty(state)).toBe(false);
  });

  it('returns false while loading (even with empty players)', () => {
    const state = makeState({ players: [], total: 0, loading: true });
    expect(dashboard.isEmpty(state)).toBe(false);
  });

  it('returns false when there is an error (error state takes precedence)', () => {
    const state = makeState({ players: [], total: 0, error: 'Network error' });
    expect(dashboard.isEmpty(state)).toBe(false);
  });
});

// ─── isLoading ────────────────────────────────────────────────────────────────

describe('isLoading', () => {
  it('returns true when loading is true', () => {
    const state = makeState({ loading: true });
    expect(dashboard.isLoading(state)).toBe(true);
  });

  it('returns false when loading is false', () => {
    const state = makeState({ loading: false });
    expect(dashboard.isLoading(state)).toBe(false);
  });
});

// ─── hasError ─────────────────────────────────────────────────────────────────

describe('hasError', () => {
  it('returns true when error is non-null', () => {
    const state = makeState({ error: 'Failed to fetch players' });
    expect(dashboard.hasError(state)).toBe(true);
  });

  it('returns false when error is null', () => {
    const state = makeState({ error: null });
    expect(dashboard.hasError(state)).toBe(false);
  });
});

// ─── getEmptyStateMessage ─────────────────────────────────────────────────────

describe('getEmptyStateMessage', () => {
  it('returns a filter-hint message when region is set', () => {
    const msg = dashboard.getEmptyStateMessage({ ...BASE_FILTERS, region: 'Europe' });
    expect(msg).toContain('filter');
  });

  it('returns a filter-hint message when position is set', () => {
    const msg = dashboard.getEmptyStateMessage({ ...BASE_FILTERS, position: 'Goalkeeper' });
    expect(msg).toContain('filter');
  });

  it('returns a filter-hint message when minTier is set', () => {
    const msg = dashboard.getEmptyStateMessage({ ...BASE_FILTERS, minTier: 2 });
    expect(msg).toContain('filter');
  });

  it('returns a generic "no players" message when no filters are active', () => {
    const msg = dashboard.getEmptyStateMessage(BASE_FILTERS);
    expect(msg).not.toContain('filter');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('returns a generic message when region is empty string (not active)', () => {
    const msg = dashboard.getEmptyStateMessage({ ...BASE_FILTERS, region: '' });
    expect(msg).not.toContain('filter');
  });

  it('returns different messages for filtered vs unfiltered state', () => {
    const filteredMsg   = dashboard.getEmptyStateMessage({ ...BASE_FILTERS, region: 'Europe' });
    const unfilteredMsg = dashboard.getEmptyStateMessage(BASE_FILTERS);
    expect(filteredMsg).not.toBe(unfilteredMsg);
  });
});

// ─── PlayerFilterForm interaction simulation ──────────────────────────────────

describe('PlayerFilterForm interaction (simulated)', () => {
  it('applying a region filter reduces the visible player count', () => {
    const all  = dashboard.applyFilters(PLAYERS, BASE_FILTERS);
    const west = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, region: 'West Africa' });
    expect(west.length).toBeLessThan(all.length);
  });

  it('clearing filters (undefined) restores the full player set', () => {
    const filtered = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, region: 'West Africa' });
    const cleared  = dashboard.applyFilters(PLAYERS, BASE_FILTERS); // no region filter
    expect(cleared.length).toBeGreaterThan(filtered.length);
  });

  it('changing page does not change the filter result total', () => {
    const filtered = dashboard.applyFilters(PLAYERS, { ...BASE_FILTERS, region: 'West Africa' });
    const page1 = dashboard.paginatePlayers(filtered, 1, 1);
    const page2 = dashboard.paginatePlayers(filtered, 2, 1);
    expect(page1.total).toBe(page2.total); // total is consistent across pages
  });
});
