# ─── Stage 1: Build ──────────────────────────────────────────────────────────
# Pin the multi-architecture Node image index digest so both stages build from
# the same immutable base. Update this digest deliberately to pick up patches.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder

# Accept the Git commit SHA at build time (defaults to "unknown")
ARG GIT_COMMIT=unknown

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3 uses node-gyp).
# These are needed in the builder stage to compile better-sqlite3 for Alpine (musl).
RUN apk add --no-cache python3 make g++

# Install dependencies first (better layer caching).
# Disable husky install via HUSKY=0 environment variable (husky v9 respects this).
# This allows scripts to run for better-sqlite3's prebuild-install/node-gyp,
# while skipping the husky prepare hook.
COPY package*.json ./
RUN HUSKY=0 npm ci

# Copy source and compile TypeScript → dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies so only production deps are copied to runtime stage.
# `npm prune` rather than a second `npm ci --omit=dev`: a fresh install re-runs
# the root `prepare` script (`husky`), which fails with "husky: not found"
# because husky is a dev dependency. Pruning runs no lifecycle scripts and
# keeps the better-sqlite3 binary already compiled above.
RUN npm prune --omit=dev

# ─── Stage 2: Runtime ────────────────────────────────────────────────────────
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runtime

# Build arguments for OCI annotations and runtime environment
ARG GIT_COMMIT=unknown
ARG VERSION=0.0.0-dev
ARG BUILD_DATE=""
ARG SOURCE=https://github.com/scout-off/scout-off-backend
ARG TITLE="scout-off-backend"
ARG DESCRIPTION="Backend API for ScoutOff — decentralized football scouting platform on Stellar"
ARG LICENSES="Apache-2.0"

# OCI Image Spec annotations (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
LABEL org.opencontainers.image.title="${TITLE}" \
      org.opencontainers.image.description="${DESCRIPTION}" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.revision="${GIT_COMMIT}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="${LICENSES}"

# Non-root user for least-privilege runtime. The app runs as `node dist/index.js`
# and never needs npm at runtime, so drop the npm/npx bundled with the base
# image: it is unused attack surface and the source of every HIGH finding in
# the CI Trivy scan (vulnerable copies of brace-expansion, picomatch, etc.).
RUN addgroup -S appgroup && adduser -S appuser -G appgroup \
  && apk add --no-cache tini \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

# Copy compiled output and production node_modules from builder
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package.json ./

# Copy database migration files — migrate.ts resolves migrations relative to
# /app/db at runtime, so they must be present in the image
COPY --chown=appuser:appgroup db ./db

# Create a directory for the SQLite database file and give the app user ownership
RUN mkdir -p /data && chown appuser:appgroup /data

USER appuser

# Expose the default API port (documentation only; actual port is $PORT at runtime)
EXPOSE 4000

# Set default DB path to the /data volume mount
ENV DB_PATH=/data/scout-off.db \
    NODE_ENV=production \
    PORT=4000 \
    GIT_COMMIT=$GIT_COMMIT

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-4000}/health/liveness" || exit 1

# Run Node under tini so signals are forwarded correctly and zombie child
# processes are reaped (Node as PID 1 does neither by default). Graceful
# shutdown still works: `docker stop` sends SIGTERM to tini, which forwards
# it to Node, triggering the "Received SIGTERM, starting graceful
# shutdown..." sequence in src/index.ts.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
