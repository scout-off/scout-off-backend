# IP Reputation Scoring

See `src/services/ipReputation.ts` for the scoring implementation (score
thresholds, decay rate, and whitelist/blacklist behaviour).

## Known limitation: process-local storage only

Reputation scores are stored in a process-local in-memory map. They are
**not** shared across instances in a multi-instance deployment — a given
IP's score is fragmented per instance rather than tracked cross-instance.
See [issue #1100](https://github.com/scout-off/scout-off-backend/issues/1100)
for backing this store with Redis.
