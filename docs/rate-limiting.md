# Rate Limiting Documentation

## Overview

The ScoutOff backend implements multi-dimensional rate limiting to protect against abuse while maintaining availability. Rate limits are applied across multiple namespaces (per-IP, per-wallet, per-endpoint) with configurable thresholds and window sizes.

**Key design principle:** Rate limiting uses **fail-open** — if the rate limiter cannot make a decision (e.g., Redis connection down), requests are allowed through. This prioritizes availability over strict enforcement.

## Architecture

Rate limiting is implemented in two layers:

1. **In-memory store (default):** Each backend instance maintains its own rate limit counters in a JavaScript `Map`. Suitable for single-instance deployments or development. No external dependencies.

2. **Redis store (optional):** When `REDIS_URL` is set, the rate limiter can be extended to use Redis for shared state across multiple backend instances. (Implementation TBD.)

## Limiters

### 1. IP-Based Global Rate Limiter

Limits requests per IP address across all endpoints (except health checks).

**Namespace:** `ip`

**Configuration:**
- `RATE_LIMIT_ENABLED`: Enable/disable all rate limiting (default: `true`)
- `RATE_LIMIT_WINDOW_MS`: Time window in milliseconds (default: `60000` = 1 second)
- `RATE_LIMIT_MAX`: Max requests per window per IP (default: `60`)

**Example:** With defaults, each IP can make 60 requests per 60 seconds (1 req/sec average).

**Where applied:** Most API endpoints, including:
- `GET /api/players`
- `GET /api/validators`
- `POST /api/auth/challenge`
- All other public and authenticated endpoints (except health/ready probes)

**Use case:** Protect against general flooding attacks or misbehaving clients.

### 2. Authentication Rate Limiter

Stricter per-IP limit specifically on auth endpoints to prevent brute-force attacks.

**Namespace:** `auth`

**Configuration:**
- `AUTH_RATE_LIMIT_WINDOW_MS`: Time window in milliseconds (default: `60000` = 1 minute)
- `AUTH_RATE_LIMIT_MAX`: Max requests per window per IP (default: `5`)

**Example:** Each IP can attempt auth 5 times per 60 seconds.

**Where applied:**
- `POST /auth/challenge` — challenge generation
- `POST /auth/token` — token signing

**Use case:** Prevent brute-force attacks on challenge/token signing.

**Trade-off:** Legitimate clients may hit this limit if they retry aggressively. 5 requests per minute is conservative; adjust upward if you see false positives.

### 3. Wallet-Based Rate Limiter

Limits requests per authenticated wallet (when `req.account` is present).

**Namespace:** `wallet`

**Configuration:** Same as global limiter (currently uses `RATE_LIMIT_WINDOW_MS` and `RATE_LIMIT_MAX`).

**Example:** Each authenticated wallet can make 60 requests per 60 seconds, independent of IP.

**Where applied:** Endpoints that extract `req.account` from JWT and apply wallet-level limits.

**Use case:** Prevent a single compromised key from consuming all quota.

**Note:** If a wallet is compromised, the attacker can still make 60 requests per minute. Wallet revocation or rotation is the primary defense; rate limiting is an additional layer.

## Namespacing & Isolation

Rate limit namespaces are completely isolated — they do not share counters. This prevents spurious interactions:

**Example:** Suppose we have two limiters:
- Limiter A: 60 requests per 60 seconds per IP
- Limiter B: 10 requests per 60 seconds per IP

These do NOT interfere with each other. Each maintains its own `Map<ip, { count, resetAt }>`. If an IP hits Limiter B's limit (10 requests), it does not affect Limiter A — the IP can still make 60 requests per 60 seconds in Limiter A's window.

The namespace key (e.g., `ip` or `wallet`) ensures lookups happen in separate storage buckets.

## 429 Too Many Requests Response

When a client exceeds a rate limit, the server responds with HTTP 429:

**Status Code:** `429`

**Response Body:**
```json
{
  "success": false,
  "error": "Too many requests, please try again later"
}
```

**Response Headers:**
```
Retry-After: 45
```

The `Retry-After` header (in seconds) tells the client how long to wait before retrying. The value is calculated as:

```
retryAfterSeconds = ceil((resetAt - now) / 1000)
```

Where `resetAt` is when the current rate limit window closes.

**Client behavior:** Well-behaved HTTP clients (and tools like curl with `--retry-after`) will wait the specified duration before retrying. Misbehaving clients may ignore the header and retry immediately, in which case they'll hit the limit again.

## Fail-Open Policy

If the rate limiter encounters an error (e.g., Redis connection lost, in-memory store corruption), it **fails open**: requests are allowed through without enforcement.

**Rationale:** An outage in the rate limiter should not cascade into an outage of the entire API. It's better to briefly lose rate limit protection than to block legitimate traffic.

**Example:**
```typescript
try {
  const entry = hits.get(ip);
  // ... rate limit logic ...
} catch (err) {
  logger.warn(`[rateLimit] error: ${err.message}`);
  next(); // Allow the request through
}
```

**Implications:**
- A Redis failure temporarily disables rate limiting across instances
- Attackers could exploit the window to send more requests
- Monitoring should alert on rate limiter errors so operators can investigate

**Mitigation:**
- Monitor rate limiter error logs
- Maintain Redis with high availability (replication, failover)
- Consider periodic health checks of the rate limiter itself

## Configuration

### Per-Environment Defaults

**Development** (`NODE_ENV=development`):
- `RATE_LIMIT_ENABLED=true`
- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX=60`
- `AUTH_RATE_LIMIT_MAX=5`

**Test** (`NODE_ENV=test`):
- `RATE_LIMIT_ENABLED=true` (typically disabled in tests via middleware)
- `RATE_LIMIT_MAX=1000` (high, to avoid test flakiness)
- `AUTH_RATE_LIMIT_MAX=1000`

**Staging** (`NODE_ENV=staging`):
- Same as production defaults (see below)

**Production** (`NODE_ENV=production`):
- `RATE_LIMIT_ENABLED=true`
- `RATE_LIMIT_WINDOW_MS=60000`
- `RATE_LIMIT_MAX=60` (1 req/sec average)
- `AUTH_RATE_LIMIT_MAX=5`

### Adjusting Limits

**To allow more requests from trusted IPs:**
```env
RATE_LIMIT_MAX=200
```

This increases the global limit to 200 requests per 60 seconds per IP. If you have a trusted partner or internal service making bulk requests, this may be necessary. Consider IP allowlisting as an alternative if available.

**To tighten auth limits (more aggressive brute-force protection):**
```env
AUTH_RATE_LIMIT_MAX=3
AUTH_RATE_LIMIT_WINDOW_MS=300000  # 5-minute window instead of 1-minute
```

This allows only 3 auth attempts per 5 minutes per IP — very strict, suitable for high-security deployments.

**To disable rate limiting entirely (not recommended):**
```env
RATE_LIMIT_ENABLED=false
```

Rate limiting is disabled globally. All requests are allowed. Use only for testing or if you have external rate limiting (e.g., WAF or API gateway).

## Metrics & Monitoring

### Logging

Rate limit enforcement is logged at `warn` or `info` level (depending on logger config). No log entries are emitted for allowed requests — only for hits and blocks.

**Hit (request blocked):**
```
[rateLimit] IP=192.0.2.1 exceeded max=60 in window=60000ms, next reset in 45s
```

**Errors:**
```
[rateLimit] error: Redis connection lost — failing open
```

### Tracking

Recommended metrics to expose (via Prometheus or similar):
- `rate_limit_hits_total{namespace="ip", endpoint="/api/players"}` — Total 429 responses
- `rate_limit_resets_total{namespace="wallet"}` — Total window resets
- `rate_limit_errors_total{namespace="ip"}` — Total limiter errors (fail-open incidents)

### Alerting

- Alert if `rate_limit_errors_total` is increasing (indicates Redis or store problems)
- Alert if a single IP is hitting the limit repeatedly (possible attacker, or legitimate bulk client needing a higher limit)

## Routes & Endpoints

### Exempted from Rate Limiting

The following endpoints bypass rate limiting entirely:

- `GET /health` — Liveness check
- `GET /health/liveness` — Liveness check (alias)
- `GET /health/readiness` — Readiness check
- `GET /ready` — Readiness check (alias)
- `GET /metrics` — Prometheus metrics

These are exempted because they are health probes and should not be subject to rate limiting, which could give false negatives during monitoring.

**Configuration:** The exempted paths are defined in `config.requestLog.skipPaths` and can be customized via `LOG_SKIP_PATHS` env var.

### Subject to Rate Limiting

All other endpoints are subject to rate limiting:
- `GET /api/players`
- `POST /api/auth/challenge`
- `POST /api/auth/token`
- `GET /api/validators`
- `POST /api/admin/*` (high-value operations — consider stricter limits)
- Any endpoint not explicitly exempted

## Best Practices

1. **Monitor for attacks:** Set up alerts on rate limit hit rate. A sudden spike may indicate an active attack.

2. **Use IP allowlisting:** For trusted internal services or partners making bulk requests, implement IP allowlisting to bypass rate limits. (This is application-level; not yet implemented in the rate limiter.)

3. **Test before production:** Load test your rate limits in staging to ensure legitimate peak traffic does not trigger false positives.

4. **Keep Redis healthy:** If using Redis, monitor its connectivity and latency. A slow Redis can cause fail-open incidents.

5. **Document your limits:** Communicate rate limits to API consumers. Publish SLA docs stating the limits.

6. **Consider per-endpoint limits:** Currently, all endpoints share the same limit. Future versions may implement per-endpoint configurability.

7. **Rotate compromised keys:** If a wallet is rate-limited due to abuse, rotate the associated secret key immediately.

## Implementation Details

**Source:** `src/middleware/rateLimit.ts`

**Key functions:**
- `rateLimit(options)` — Global IP-based limiter middleware
- `walletRateLimit(options)` — Per-wallet limiter middleware
- `authRateLimit()` — Auth-specific limiter (stricter)

**State storage:** In-memory `Map<string, { count, resetAt }>` (per-instance)

**Window reset logic:**
```typescript
const now = Date.now();
if (!entry || now >= entry.resetAt) {
  // Window has expired, reset the counter
  hits.set(ip, { count: 1, resetAt: now + windowMs });
  return next(); // Allow this request
}
```

## Troubleshooting

### "Too many requests" errors in logs

**Symptom:** Legitimate clients are getting 429 responses.

**Causes:**
1. Rate limit is too low for your traffic profile
2. A bot or attacker is consuming quota
3. A single client is retrying aggressively

**Solution:**
1. Check `RATE_LIMIT_MAX` — increase if needed
2. Identify the IP in logs and decide: allowlist it, block it, or investigate
3. Add monitoring to detect this pattern earlier

### Rate limiter not enforcing (requests always allowed)

**Symptom:** Clients making thousands of requests without hitting 429.

**Causes:**
1. `RATE_LIMIT_ENABLED=false` (disabled)
2. Middleware not mounted on a route
3. Fail-open due to an error

**Solution:**
1. Check `config.rateLimit.enabled` — should be `true`
2. Verify middleware is applied to all routes (check `src/routes/`)
3. Check logs for `[rateLimit] error:` entries

### Per-IP limits working, but per-wallet limits not enforced

**Symptom:** High-traffic wallet not being rate-limited.

**Causes:**
1. `req.account` not being set (JWT not authenticated)
2. Wallet limiter middleware not mounted
3. Wallet limiter has a higher threshold than IP limiter

**Solution:**
1. Verify JWT is being validated before the wallet limiter
2. Check middleware order in router
3. Review config for wallet vs. IP thresholds

## References

- [Rate Limiter Implementation](../src/middleware/rateLimit.ts)
- [Rate Limiter Tests](../tests/middleware/rateLimit.test.ts)
- [Config: Rate Limit Settings](../src/config.ts#L118-L127)
- [DEPLOYMENT.md: Rate Limiting Section](../DEPLOYMENT.md#rate-limiting)
