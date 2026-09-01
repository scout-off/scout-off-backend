import { xdr, scValToNative } from '@stellar/stellar-sdk';
import { OnChainMilestone } from '../services/stellar';

/** Decodes an `xdr.ScVal` of type `scvBool` to a native boolean; throws if the type doesn't match. */
export function parseBoolean(val: xdr.ScVal): boolean {
  if (val.type !== 'scvBool') {
    throw new Error(`Expected scvBool, got ${val.type}`);
  }
  return scValToNative(val) as boolean;
}

/** Decodes an `xdr.ScVal` of type `scvU128` or `scvI128` to a native bigint; throws if the type doesn't match. */
export function parseU128(val: xdr.ScVal): bigint {
  const type = val.type;
  if (type !== 'scvU128' && type !== 'scvI128') {
    throw new Error(`Expected scvU128 or scvI128, got ${type}`);
  }
  return BigInt(scValToNative(val) as string | number);
}

/** Decodes an `xdr.ScVal` vector of milestone map entries into `OnChainMilestone[]`; throws if the shape doesn't match. */
export function parseMilestones(val: xdr.ScVal): OnChainMilestone[] {
  if (val.type !== 'scvVec') {
    throw new Error(`Expected scvVec, got ${val.type}`);
  }
  const items = (val as xdr.ScValVec).vec ?? [];
  return items.map((item) => {
    if (item.type !== 'scvMap') {
      throw new Error(`Expected scvMap for milestone entry, got ${item.type}`);
    }
    const map = Object.fromEntries(
      ((item as xdr.ScValMap).map ?? []).map((e) => [
        scValToNative(e.key) as string,
        scValToNative(e.val),
      ])
    );
    return {
      milestoneId: String(map.milestone_id ?? ''),
      playerId: String(map.player_id ?? ''),
      milestoneType: String(map.milestone_type ?? ''),
      evidenceUri: String(map.evidence_uri ?? ''),
      approved: Boolean(map.approved),
      approvedBy: map.approved_by ? String(map.approved_by) : null,
      ledger: map.ledger != null ? Number(map.ledger) : null,
    } as OnChainMilestone;
  });
}

/** Decodes an `xdr.ScVal` of type `scvMap` into a subscription's active/expiresAt fields; throws if the type doesn't match. */
export function parseSubscription(val: xdr.ScVal): { active: boolean; expiresAt: string | null } {
  if (val.type !== 'scvMap') {
    throw new Error(`Expected scvMap, got ${val.type}`);
  }
  const map = Object.fromEntries(
    ((val as xdr.ScValMap).map ?? []).map((e) => [
      scValToNative(e.key) as string,
      scValToNative(e.val),
    ])
  );
  return {
    active: Boolean(map.active),
    expiresAt: map.expires_at != null ? String(map.expires_at) : null,
  };
}
