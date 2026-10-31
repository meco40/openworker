# ─── BetaClaw Gateway Docker Build ────────────────────────────
# Multi-stage build for the custom Next.js + WebSocket server.

# ── Base ───────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base
ENV HUSKY=0
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

# ── Stage 1: Dependencies ─────────────────────────────────────
FROM base AS deps
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
# The custom server.ts/scheduler.ts entrypoints are executed through tsx at
# runtime, so keep the runtime dependency graph flat and complete in this
# stage. This avoids copying pnpm's root symlinks (and missing transitive
# packages such as luxon) into the final image.
RUN pnpm config set node-linker hoisted && \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# ── Stage 2: Build ────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY scripts/avatar/sync-headaudio-assets.mjs ./scripts/avatar/sync-headaudio-assets.mjs
RUN pnpm config set node-linker hoisted && pnpm install --frozen-lockfile

COPY . .
# NextAuth is evaluated during prerender; the runtime stage gets its real secret separately.
RUN NEXTAUTH_SECRET=build-only-not-for-runtime pnpm run build

# ── Stage 3: Production ────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV DATABASE_PATH=/app/.local/mission-control.db
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN groupadd --gid 1001 nodejs && \
    useradd --uid 1001 --gid nodejs --create-home nextjs && \
    apt-get update && apt-get install -y --no-install-recommends python3 wget ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy the regular Next.js output used by the custom server entrypoint.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public

# Copy TypeScript server entrypoints for custom web/scheduler processes
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/scheduler.ts ./scheduler.ts
COPY --from=builder /app/tsconfig.json /app/package.json /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts

# Complete flattened production dependency graph for custom entrypoints.
COPY --from=deps /app/node_modules ./node_modules
# better-sqlite3 ships its native binding in prebuilds/, so the script-free install is complete.
RUN node node_modules/playwright/cli.js install --with-deps chromium && \
    rm -rf /var/lib/apt/lists/*

# Create data directory for SQLite (mount as volume)
RUN mkdir -p /app/.local /app/workspaces /app/.next/cache && \
    chown -R nextjs:nodejs /app/.local /app/workspaces /app/.next/cache

USER nextjs

EXPOSE 3000

# Health check for web process (scheduler has its own health check in docker-compose)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "--import", "tsx", "server.ts"]
