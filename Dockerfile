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
# Install git, SSL, Python 3 (for scaffoldkit)
RUN apt-get update && apt-get install -y \
    git ca-certificates openssl \
    python3 python3-pip python3-venv \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Create scaffoldkit venv inside the image (scaffoldkit source mounted at runtime)
# The venv is built at startup once scaffoldkit source is available
ENV SCAFFOLDKIT_VENV=/app/.sk-venv
ENV SCAFFOLDKIT_PYTHON=/app/.sk-venv/bin/python3

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/public ./public
EXPOSE 3000
CMD ["sh", "-c", "\
  npx prisma db push --skip-generate && \
  python3 -m venv $SCAFFOLDKIT_VENV && \
  $SCAFFOLDKIT_VENV/bin/pip install -e /tools/scaffoldkit -q && \
  npx next start \
"]
