import { Request, Response, NextFunction } from 'express';
import {
  queryEvents,
  getLatestSubscription,
  getContactUnlocksByScout,
  getBookmarksByScout,
  getSavedSearchesByScout,
} from '../../db';
import { isSubscribed } from '../../services/stellar';
import { checkWalletOwnership } from '../../middleware/requireOwner';
import config from '../../config';

// ─── GET /api/scouts/:wallet/dashboard (#1141) ────────────────────────────────

/**
 * Bound applied to each section of the dashboard response.
 * Full lists are available via the dedicated paginated endpoints.
 */
const DASHBOARD_SECTION_LIMIT = 10;

/**
 * GET /api/scouts/:wallet/dashboard
 *
 * Consolidated dashboard for a scout home screen. Returns four sections in a
 * single authenticated call — each bounded and independently linked to its
 * full paginated endpoint:
 *
 *   - subscription: current subscription status (same as GET /:wallet/subscription)
 *   - contacts:     first N unlocked contacts, with link to full list
 *   - bookmarks:    first N bookmarked players, with link to full list
 *   - savedSearches: first N saved searches, with link to full list
 *
 * Auth: own wallet or admin.
 * Each section is fetched via the existing per-resource service functions to
 * reuse query logic without duplication.
 */
export async function getScoutDashboard(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { wallet } = req.params as { wallet: string };

    // Ownership enforced by requireWalletOwner() at the route level; also
    // checked here so direct callers (unit tests) get the same protection.
    if (!checkWalletOwnership(req, res)) return;

    // ── 1. Subscription status (same logic as getSubscription) ───────────────
    const now = Math.floor(Date.now() / 1000);
    const graceSeconds = config.subscriptionGracePeriodHours * 3600;

    const onChain = await isSubscribed(wallet);
    let subscriptionData: {
      active: boolean;
      tier: string | null;
      expiresAt: number | null;
      remainingDays: number | null;
      gracePeriodActive: boolean;
    };

    if (onChain.active) {
      subscriptionData = {
        active: true,
        tier: 'basic',
        // The on-chain contract exposes only a boolean subscription flag, not
        // an expiry timestamp (isSubscribed returns '' when active), so there
        // is no numeric expiresAt to surface here.
        expiresAt: null,
        remainingDays: null,
        gracePeriodActive: false,
      };
    } else {
      const localSub = await getLatestSubscription(wallet);
      if (localSub) {
        const active = localSub.expires_at > now;
        const gracePeriodActive = !active && localSub.expires_at > now - graceSeconds;
        const remainingDays = active ? Math.ceil((localSub.expires_at - now) / 86400) : 0;
        subscriptionData = {
          active: active || gracePeriodActive,
          tier: localSub.tier,
          expiresAt: localSub.expires_at,
          remainingDays,
          gracePeriodActive,
        };
      } else {
        // Fall back to indexed events
        const subs = queryEvents('scout_subscribed', { payloadFilter: { scout: wallet } });
        const latest = subs.at(-1);
        if (latest) {
          const expiresAt = latest.payload.subscription_expiry as number;
          const active = expiresAt > now;
          const gracePeriodActive = !active && expiresAt > now - graceSeconds;
          const remainingDays = active ? Math.ceil((expiresAt - now) / 86400) : 0;
          subscriptionData = {
            active: active || gracePeriodActive,
            tier: (latest.payload.tier as string) ?? 'basic',
            expiresAt,
            remainingDays,
            gracePeriodActive,
          };
        } else {
          subscriptionData = {
            active: false,
            tier: null,
            expiresAt: null,
            remainingDays: 0,
            gracePeriodActive: false,
          };
        }
      }
    }

    // ── 2. Contacts (bounded) ─────────────────────────────────────────────────
    const allContacts = await getContactUnlocksByScout(wallet);
    const contactsSlice = allContacts.slice(0, DASHBOARD_SECTION_LIMIT).map((c) => ({
      playerId: c.player_id,
      unlockedAt: c.unlocked_at,
    }));

    // ── 3. Bookmarks (bounded) ────────────────────────────────────────────────
    const allBookmarks = await getBookmarksByScout(wallet);
    const bookmarksSlice = allBookmarks.slice(0, DASHBOARD_SECTION_LIMIT).map((b) => ({
      playerId: b.player_id,
      folderId: b.folder_id,
      note: b.note,
      bookmarkedAt: b.created_at,
    }));

    // ── 4. Saved searches (bounded) ───────────────────────────────────────────
    const allSavedSearches = await getSavedSearchesByScout(wallet);
    const savedSearchesSlice = allSavedSearches.slice(0, DASHBOARD_SECTION_LIMIT).map((s) => ({
      id: s.id,
      name: s.name,
      filters: (() => {
        try { return JSON.parse(s.filters); } catch { return s.filters; }
      })(),
      createdAt: s.created_at,
    }));

    // ── Compose response ──────────────────────────────────────────────────────
    res.json({
      success: true,
      data: {
        wallet,
        subscription: subscriptionData,
        contacts: {
          items: contactsSlice,
          total: allContacts.length,
          hasMore: allContacts.length > DASHBOARD_SECTION_LIMIT,
          _links: { full: `/api/scouts/${wallet}/contacts` },
        },
        bookmarks: {
          items: bookmarksSlice,
          total: allBookmarks.length,
          hasMore: allBookmarks.length > DASHBOARD_SECTION_LIMIT,
          _links: { full: `/api/scouts/${wallet}/bookmarks` },
        },
        savedSearches: {
          items: savedSearchesSlice,
          total: allSavedSearches.length,
          hasMore: allSavedSearches.length > DASHBOARD_SECTION_LIMIT,
          _links: { full: `/api/scouts/${wallet}/saved-searches` },
        },
      },
    });
  } catch (err) {
    next(err);
  }
}
