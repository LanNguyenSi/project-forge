.PHONY: deploy logs restart pull backup install-cron dev dev-setup dev-db dev-env

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
# $HOME/project-forge-backups). An unset FORGE_BACKUP_DIR is refused when the
# installed project-forge cron block names another directory, so manual and
# scheduled backups share one directory. See docs/deployment.md, "Backup and
# restore".
backup:
	sh scripts/backup.sh

# Installs three entries into this user's crontab: the hourly forge_tmp
# prune, the nightly scripts/backup.sh and the daily scripts/backup.sh
# --check-fresh (needs FORGE_BACKUP_DIR, except for --remove, which does not;
# ARGS=--dry-run prints, ARGS=--remove removes).
# See docs/deployment.md, "Backup and restore".
install-cron:
	sh scripts/install-cron.sh $(ARGS)

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

# Create .env from example if it doesn't exist yet. The recipe runs its shell
# under `umask 077`, so .env.tmp and the .env it is renamed from are created
# readable by their owner only (mode 600): the generated NEXTAUTH_SECRET never
# lands world-readable, whatever mode .env.example has (a plain `cp` would give
# the copy that template's 644). tests/integration/make-dev-env.test.ts pins it.
dev-env:
	@if [ ! -f .env ]; then \
		set -e; \
		umask 077; \
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
