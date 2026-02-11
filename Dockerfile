# ─── OpenClaw Gateway Docker Build ────────────────────────────
# Multi-stage build using Next.js standalone output.

# ── Stage 1: Dependencies ─────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Stage 2: Build ────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .
RUN npm run build

# ── Stage 3: Production ──────────────────────────────────────
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

# Runtime dependencies used by custom TypeScript entrypoints
COPY --from=deps /app/node_modules/ws ./node_modules/ws
COPY --from=deps /app/node_modules/tsx ./node_modules/tsx
COPY --from=deps /app/node_modules/cron-parser ./node_modules/cron-parser
COPY --from=deps /app/node_modules/luxon ./node_modules/luxon

# Create data directory for SQLite (mount as volume)
RUN mkdir -p /app/.local && chown nextjs:nodejs /app/.local

USER nextjs

EXPOSE 3000

# Health check for web process (scheduler has its own health check in docker-compose)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

CMD ["node", "--import", "tsx", "server.ts"]
