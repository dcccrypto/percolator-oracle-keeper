# Oracle Keeper — standalone deployment
FROM node:22-slim AS base
WORKDIR /app

# Install git (needed for github: npm deps) + curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends git curl && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd -r keeper && useradd -r -g keeper -d /app keeper

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies (includes tsx runtime)
RUN npm ci --omit=dev

# Copy source
COPY src/ src/

# Set ownership and switch to non-root
RUN chown -R keeper:keeper /app
USER keeper

EXPOSE 18810

# Health check: /health returns 200 when all markets fresh, 503 when degraded
# Use curl without -f so 503 doesn't fail the health check (service still running)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=60s \
  CMD curl -sf -o /dev/null -H "Authorization: Bearer ${HEALTH_AUTH_TOKEN:-}" http://localhost:${HEALTH_PORT:-18810}/health || exit 1

# Environment defaults (override via Railway service variables)
ENV PUSH_INTERVAL_MS=3000
ENV HEALTH_PORT=18810
ENV HEALTH_BIND=0.0.0.0
ENV MAX_PRICE_MOVE_PCT=10
ENV STALE_THRESHOLD_S=30

# Use tsx to run TypeScript directly (same as original oracle-keeper)
CMD ["npx", "tsx", "src/index.ts"]
