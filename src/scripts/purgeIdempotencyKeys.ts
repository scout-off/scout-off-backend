import { purgeExpiredIdempotencyKeys } from '../middleware/idempotency';

const deleted = purgeExpiredIdempotencyKeys();
console.log(`Deleted ${deleted} expired idempotency key rows.`);
