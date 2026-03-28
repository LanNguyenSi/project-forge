.PHONY: deploy logs restart pull dev dev-setup dev-db dev-env

# ── Production (Docker) ──────────────────────────────────────

deploy:
	git pull
	docker compose up -d --build

logs:
	docker compose logs -f --tail=100

restart:
	docker compose restart

pull:
	git pull && docker compose up -d

# ── Local Development ────────────────────────────────────────

# One-shot: install deps, generate prisma client, create DB, create .env, start dev server
dev: dev-env dev-setup dev-db
	npx next dev

# Install dependencies + generate Prisma client
dev-setup:
	npm install
	npx prisma generate

# Push schema to local SQLite DB (creates file if missing)
dev-db:
	npx prisma db push

# Create .env from example if it doesn't exist yet
dev-env:
	@if [ ! -f .env ]; then \
		echo "Creating .env from .env.example..."; \
		cp .env.example .env; \
		sed -i 's|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET='$$(openssl rand -hex 32)'|' .env; \
		sed -i 's|^NEXTAUTH_URL=.*|NEXTAUTH_URL=http://localhost:3000|' .env; \
		echo ""; \
		echo "━━━ .env created ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; \
		echo "  NEXTAUTH_SECRET  generated"; \
		echo "  NEXTAUTH_URL     http://localhost:3000"; \
		echo "  DATABASE_URL     file:./db/project-forge.db"; \
		echo ""; \
		echo "  Optional — fill in to enable all features:"; \
		echo "    GITHUB_TOKEN   (repo creation)"; \
		echo "    GITHUB_OWNER   (repo owner)"; \
		echo "    GITHUB_ID      (OAuth login)"; \
		echo "    GITHUB_SECRET  (OAuth login)"; \
		echo "    LOCAL_AI_BASE_URL + LOCAL_AI_MODEL  (optional local AI)"; \
		echo "    GROQ_API_KEY   (optional hosted AI)"; \
		echo "    OPENAI_API_KEY (optional hosted AI)"; \
		echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; \
		echo ""; \
	fi
