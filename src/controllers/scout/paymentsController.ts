import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  queryEvents,
  getContactUnlocksByScout,
  getSubscriptionsByScout,
} from '../../db';
import { ErrorCode } from '../../utils/errorCodes';

/**
 * Payment record shape returned by GET /api/scouts/:wallet/payments.
 * Covers both contact_unlock and subscription payment types.
 */
export interface PaymentRecord {
  id: string | null;
  type: 'contact_unlock' | 'subscription';
  amount_xlm: string;
  player_id: string | null;
  tier: string | null;
  tx_hash: string | null;
  created_at: string;
  // legacy aliases kept for backwards-compat
  transactionId: string | null;
  amount: string;
  token: string;
  timestamp: string;
}

const paymentHistoryQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  type: z.enum(['subscription', 'contact_unlock']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  format: z.enum(['json', 'csv']).default('json'),
});

/** GET /api/scouts/:wallet/payments — payment history */
export async function getPaymentHistory(req: Request, res: Response, _next: NextFunction): Promise<void> {
  const {wallet} = req.params as {wallet: string};

  const parsed = paymentHistoryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ success: false, error: parsed.error.issues[0]?.message ?? 'Invalid query parameters', code: ErrorCode.VALIDATION_ERROR });
    return;
  }
  const { from, to, type, page, pageSize, format } = parsed.data;

  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;

  if (fromDate && isNaN(fromDate.getTime())) {
    res.status(400).json({ success: false, error: 'Invalid from date', code: ErrorCode.VALIDATION_ERROR });
    return;
  }
  if (toDate && isNaN(toDate.getTime())) {
    res.status(400).json({ success: false, error: 'Invalid to date', code: ErrorCode.VALIDATION_ERROR });
    return;
  }

  // ── Build combined payment list ───────────────────────────────────────────
  const payments: PaymentRecord[] = [];

  // Contact unlock payments
  if (!type || type === 'contact_unlock') {
    const unlocks = await getContactUnlocksByScout(wallet);
    for (const u of unlocks) {
      const ts = new Date(u.unlocked_at * 1000).toISOString();
      if (fromDate && new Date(ts) < fromDate) continue;
      if (toDate && new Date(ts) > toDate) continue;
      payments.push({
        id: u.tx_hash ?? null,
        type: 'contact_unlock',
        amount_xlm: '0',
        player_id: u.player_id,
        tier: null,
        tx_hash: u.tx_hash ?? null,
        created_at: ts,
        // legacy aliases
        transactionId: u.tx_hash ?? null,
        amount: '0',
        token: 'XLM',
        timestamp: ts,
      });
    }

    // Also pull from contact_unlocked contract events for tx_hash + fee info
    // (these may contain fee amounts that the DB row doesn't store)
    const contactEvents = queryEvents('contact_unlocked', {
      payloadFilter: { scout: wallet },
    });
    for (const e of contactEvents) {
      const ts = (e.payload.timestamp as string | undefined) ?? new Date(0).toISOString();
      if (fromDate && new Date(ts) < fromDate) continue;
      if (toDate && new Date(ts) > toDate) continue;
      const txHash = (e.payload.tx_hash as string | undefined) ?? null;
      const playerId = (e.payload.player_id as string | undefined) ?? (e.payload.playerId as string | undefined) ?? null;
      const fee = (e.payload.fee ?? '0') as string;
      // A DB row for this tx may already be in the list (pushed above,
      // always with amount '0' since the contact_unlocks table doesn't
      // store fee). Enrich it with the event's fee instead of skipping —
      // otherwise the fee info this loop exists to attach never reaches
      // the DB-sourced entry.
      const existing = txHash
        ? payments.find((p) => p.type === 'contact_unlock' && p.tx_hash === txHash)
        : undefined;
      if (existing) {
        existing.amount = fee;
        existing.amount_xlm = fee;
      } else {
        payments.push({
          id: txHash,
          type: 'contact_unlock',
          amount_xlm: fee,
          player_id: playerId,
          tier: null,
          tx_hash: txHash,
          created_at: ts,
          transactionId: txHash,
          amount: fee,
          token: 'XLM',
          timestamp: ts,
        });
      }
    }
  }

  // Subscription payments
  if (!type || type === 'subscription') {
    const subs = await getSubscriptionsByScout(wallet);
    for (const s of subs) {
      const ts = new Date(s.created_at * 1000).toISOString();
      if (fromDate && new Date(ts) < fromDate) continue;
      if (toDate && new Date(ts) > toDate) continue;
      payments.push({
        id: String(s.id),
        type: 'subscription',
        amount_xlm: '0',
        player_id: null,
        tier: s.tier,
        tx_hash: null,
        created_at: ts,
        // legacy aliases
        transactionId: null,
        amount: '0',
        token: 'XLM',
        timestamp: ts,
      });
    }
  }

  // Sort by created_at descending (newest first)
  payments.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const total = payments.length;

  // ── CSV export ────────────────────────────────────────────────────────────
  if (format === 'csv') {
    const csvHeader = 'id,type,amount_xlm,player_id,tier,tx_hash,created_at\n';
    const csvRows = payments.map((p) =>
      [
        p.id ?? '',
        p.type,
        p.amount_xlm,
        p.player_id ?? '',
        p.tier ?? '',
        p.tx_hash ?? '',
        p.created_at,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
    res.status(200).send(csvHeader + csvRows.join('\n'));
    return;
  }

  // ── Paginated JSON response ───────────────────────────────────────────────
  const offset = (page - 1) * pageSize;
  const pageData = payments.slice(offset, offset + pageSize);

  res.json({ success: true, data: pageData, total, page, pageSize });
}
