/**
 * Repository: indexed contract role memberships.
 *
 * Added after the #1535 split; `src/db/index.ts` re-exports every symbol below.
 *
 * Driver status: fully on `getDriver()` (async) — works on both SQLite and PostgreSQL.
 */
import { getDriver } from '../query';


/** Indexed on-chain membership; canonical event replay/reorgs update the view directly. */
export async function listContractRoleMembers(): Promise<Array<{ contract_id: string; role: string; account: string }>> {
  return getDriver().all('SELECT contract_id, role, account FROM contract_role_memberships ORDER BY contract_id, role, account');
}
