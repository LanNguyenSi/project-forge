FROM node:20-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y git ca-certificates openssl --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm install
COPY . .
RUN npx prisma generate
RUN npm run build

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
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx next start"]
