/**
 * ScoutDashboardContent
 *
 * Encapsulates the filtering, pagination, and empty-state logic for the scout
 * player-discovery dashboard.  Implemented as a plain TypeScript class so the
 * business logic can be unit-tested in isolation without a DOM/React environment.
 *
 * In a React frontend this class would be used inside the component to derive
 * display state; the component itself handles rendering.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Player {
  player_id: string;
  wallet: string;
  position: string | null;
  region: string | null;
  progress_level: number;
  metadataUri: string | null;
  created_at: number | null;
}

export interface FilterOptions {
  region?: string;
  position?: string;
  /** Minimum progress tier (0–3) */
  minTier?: number;
  page: number;
  pageSize: number;
}

export interface PaginatedResult {
  data: Player[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
}

export interface DashboardState {
  players: Player[];
  total: number;
  loading: boolean;
  error: string | null;
  filters: FilterOptions;
}

// ─── ScoutDashboardContent ────────────────────────────────────────────────────

export class ScoutDashboardContent {
  /**
   * Apply filter criteria to a list of players.
   * Returns players matching ALL active filters.
   */
  applyFilters(players: Player[], filters: FilterOptions): Player[] {
    return players.filter((p) => {
      if (filters.region !== undefined && filters.region !== '') {
        if (p.region !== filters.region) return false;
      }
      if (filters.position !== undefined && filters.position !== '') {
        if (p.position !== filters.position) return false;
      }
      if (filters.minTier !== undefined) {
        if (p.progress_level < filters.minTier) return false;
      }
      return true;
    });
  }

  /**
   * Paginate a flat list of players.
   * `page` is 1-indexed; `pageSize` is the number of items per page.
   */
  paginatePlayers(
    players: Player[],
    page: number,
    pageSize: number,
  ): PaginatedResult {
    const total = players.length;
    const pages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
    const offset = (page - 1) * pageSize;
    const data = players.slice(offset, offset + pageSize);
    return { data, total, page, pageSize, pages };
  }

  /**
   * Returns true when the dashboard has no players to display and is not loading.
   */
  isEmpty(state: DashboardState): boolean {
    return !state.loading && state.error === null && state.players.length === 0;
  }

  /**
   * Returns true when data is currently being fetched.
   */
  isLoading(state: DashboardState): boolean {
    return state.loading;
  }

  /**
   * Returns true when the last data fetch ended in an error.
   */
  hasError(state: DashboardState): boolean {
    return state.error !== null;
  }

  /**
   * Returns a context-sensitive message for the empty state.
   * When filters are active the message guides the scout to widen the search;
   * when there are no filters it prompts them to check back later.
   */
  getEmptyStateMessage(filters: FilterOptions): string {
    const hasFilters =
      (filters.region && filters.region !== '') ||
      (filters.position && filters.position !== '') ||
      filters.minTier !== undefined;

    if (hasFilters) {
      return 'No players match your current filters. Try broadening your search.';
    }
    return 'No players are available right now. Check back later.';
  }
}
