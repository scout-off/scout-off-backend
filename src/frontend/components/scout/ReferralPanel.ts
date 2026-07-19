/**
 * ReferralPanel
 *
 * Manages scout referral code generation, stats display, and clipboard
 * interaction.  Implemented as a plain TypeScript class so the business logic
 * (async loading states, generate flow, copy UX) can be unit-tested in
 * isolation without a DOM/React environment.
 *
 * In a React frontend this class drives component state; the component itself
 * handles rendering.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReferralStats {
  totalReferrals: number;
  activeReferrals: number;
  pendingReferrals: number;
  rewardBalance: number;
}

export interface ReferralCode {
  id: string;
  code: string;
  createdAt: number;
  uses: number;
}

export interface ReferralPanelState {
  stats: ReferralStats | null;
  codes: ReferralCode[];
  loading: boolean;
  generating: boolean;
  error: string | null;
  /** ID of the code whose copy confirmation is currently displayed. */
  copiedCodeId: string | null;
}

export interface ReferralPanelDeps {
  getReferralStats: () => Promise<ReferralStats>;
  generateReferralCode: () => Promise<ReferralCode>;
  copyToClipboard: (text: string) => Promise<void>;
}

// ─── ReferralPanel ────────────────────────────────────────────────────────────

export class ReferralPanel {
  private state: ReferralPanelState;
  private deps: ReferralPanelDeps;

  constructor(deps: ReferralPanelDeps) {
    this.deps = deps;
    this.state = {
      stats:        null,
      codes:        [],
      loading:      false,
      generating:   false,
      error:        null,
      copiedCodeId: null,
    };
  }

  // ── State accessor ───────────────────────────────────────────────────────────

  getState(): Readonly<ReferralPanelState> {
    return { ...this.state };
  }

  // ── Stats loading ────────────────────────────────────────────────────────────

  /**
   * Load referral stats and populate \`state.stats\`.
   * Sets \`loading: true\` before the request and \`loading: false\` afterwards.
   * On failure, sets \`error\` instead of throwing.
   */
  async loadStats(): Promise<void> {
    this.state = { ...this.state, loading: true, error: null };
    try {
      const stats = await this.deps.getReferralStats();
      this.state = { ...this.state, stats, loading: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load referral stats';
      this.state = { ...this.state, loading: false, error: message };
    }
  }

  // ── Code generation ──────────────────────────────────────────────────────────

  /**
   * Generate a new referral code.
   * Sets \`generating: true\` while the request is in-flight and
   * appends the new code to \`state.codes\` on success.
   * On failure, sets \`error\`.
   * No-ops when \`generating\` is already true (prevents double-submit).
   */
  async generateCode(): Promise<void> {
    if (this.state.generating) return; // guard against double-submit
    this.state = { ...this.state, generating: true, error: null };
    try {
      const code = await this.deps.generateReferralCode();
      this.state = {
        ...this.state,
        codes:      [...this.state.codes, code],
        generating: false,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate referral code';
      this.state = { ...this.state, generating: false, error: message };
    }
  }

  // ── Copy to clipboard ─────────────────────────────────────────────────────────

  /**
   * Copy a referral code to the clipboard and set \`copiedCodeId\` to signal
   * the "Copied!" confirmation state.
   * On failure, sets \`error\`.
   */
  async copyCode(codeId: string, codeText: string): Promise<void> {
    try {
      await this.deps.copyToClipboard(codeText);
      this.state = { ...this.state, copiedCodeId: codeId };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to copy to clipboard';
      this.state = { ...this.state, error: message };
    }
  }

  /**
   * Clear the "Copied!" confirmation (call this after a timeout to reset the UI).
   */
  clearCopied(): void {
    this.state = { ...this.state, copiedCodeId: null };
  }
}
