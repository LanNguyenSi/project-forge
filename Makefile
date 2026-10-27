.PHONY: deploy logs restart pull backup dev dev-setup dev-db dev-env

# ── Production (Docker) ──────────────────────────────────────

deploy:
	git pull
	docker compose up -d --build

logs:
	docker compose logs -f --tail=100

restart:
	docker compose restart

pull:
	git pull && docker compose up -d --build

# Host backup of the SQLite database to $FORGE_BACKUP_DIR (default
# $HOME/project-forge-backups). See docs/deployment.md, "Backup and restore".
backup:
	sh scripts/backup.sh

# ── Local Development ────────────────────────────────────────

# One-shot: install deps, generate prisma client, create DB, create .env, start dev server
dev: dev-env dev-setup dev-db
	npx next dev

# Install dependencies + generate Prisma client
dev-setup:
	npm install
	npx prisma generate

# Apply the committed migrations to the local SQLite DB (creates file if missing).
# A DB made earlier by `prisma db push` is refused (P3005): delete it, or run
# `npx prisma migrate resolve --applied 20261027000000_baseline` if it still
# matches the schema.
dev-db:
	npx prisma migrate deploy

# Create .env from example if it doesn't exist yet
dev-env:
	@if [ ! -f .env ]; then \
		set -e; \
		trap 'rm -f .env.tmp .env.tmp.bak' EXIT; \
		echo "Creating .env from .env.example..."; \
		secret=$$(openssl rand -hex 32); \
		[ -n "$$secret" ]; \
		cp .env.example .env.tmp; \
		sed -i.bak -e 's|^NEXTAUTH_SECRET=.*|NEXTAUTH_SECRET='"$$secret"'|' -e 's|^NEXTAUTH_URL=.*|NEXTAUTH_URL=http://localhost:3000|' .env.tmp; \
		rm -f .env.tmp.bak; \
		grep -q "^NEXTAUTH_SECRET=$$secret\$$" .env.tmp; \
		grep -q '^NEXTAUTH_URL=http://localhost:3000$$' .env.tmp; \
		mv .env.tmp .env; \
		echo ""; \
		echo "━━━ .env created ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; \
		echo "  NEXTAUTH_SECRET  generated"; \
		echo "  NEXTAUTH_URL     http://localhost:3000"; \
		echo "  DATABASE_URL     file:./db/project-forge.db"; \
		echo ""; \
		echo "  Needed to generate projects (agent-planforge HTTP service):"; \
		echo "    PLANFORGE_URL            (e.g. http://localhost:8223)"; \
		echo "    PLANFORGE_SERVICE_TOKEN  (same value as in the planforge service)"; \
		echo ""; \
		echo "  Optional - fill in to enable all features:"; \
		echo "    GITHUB_ID      (OAuth login)"; \
		echo "    GITHUB_SECRET  (OAuth login)"; \
		echo "    LOCAL_AI_BASE_URL + LOCAL_AI_MODEL  (optional local AI)"; \
		echo "    GROQ_API_KEY   (optional hosted AI)"; \
		echo "    OPENAI_API_KEY (optional hosted AI)"; \
		echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; \
		echo ""; \
	fi
