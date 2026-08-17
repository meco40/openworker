# ─── OpenClaw Gateway Docker Build ────────────────────────────
# Multi-stage build using Next.js standalone output.

# ── Base ───────────────────────────────────────────────────────
FROM node:22-alpine AS base
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
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# ── Stage 3: Production ────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Copy TypeScript server entrypoints for custom web/scheduler processes
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/scheduler.ts ./scheduler.ts
COPY --from=builder /app/types.ts ./types.ts
COPY --from=builder /app/src ./src

# Complete flattened production dependency graph for custom entrypoints.
COPY --from=deps /app/node_modules ./node_modules

# Create data directory for SQLite (mount as volume)
RUN mkdir -p /app/.local && chown nextjs:nodejs /app/.local

USER nextjs

EXPOSE 3000

# Health check for web process (scheduler has its own health check in docker-compose)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "--import", "tsx", "server.ts"]
