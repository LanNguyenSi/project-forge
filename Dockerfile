FROM node:20-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y git ca-certificates openssl --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
# Same install as CI: lockfile enforced, same flags.
RUN npm ci --legacy-peer-deps --no-audit --no-fund
COPY . .
RUN npx prisma generate
RUN npm run build

# Production-only dependencies for the runtime image. `prisma` is a regular
# dependency because the container CMD runs `prisma db push`. Dev tooling
# (eslint, vitest, typescript, ...) stays in the builder stage.
FROM node:20-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y openssl ca-certificates --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund
RUN node_modules/.bin/prisma generate

FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
# git + SSL only. Python / scaffoldkit venv removed 2026-04-21 (ADR-0002
# follow-up #5) — planforge runs scaffoldkit in its own container and
# returns the scaffolded tarball over HTTP. `tar` (for extracting that
# tarball) is already in the base image.
RUN apt-get update && apt-get install -y \
    git ca-certificates openssl \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.next ./.next
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
EXPOSE 3000
# Installed binaries, not npx: no network fetch at container start.
CMD ["sh", "-c", "node_modules/.bin/prisma db push --skip-generate && node_modules/.bin/next start"]
