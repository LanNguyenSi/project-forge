# ADR 001: Migrate from SQLite to PostgreSQL

**Status:** Accepted  
**Date:** 2026-03-31  
**Authors:** Lan Nguyen Si, Ice

---

## Context

project-forge v1 used SQLite as its database via Prisma. This was acceptable during the initial development phase: no infrastructure required, no setup overhead, simple testing.

With the Wave 1 rebuild (March 2026), several requirements became clear that push SQLite to its limits:

1. **Concurrent writes:** The scaffold pipeline (planforge → scaffoldkit → GitHub API) produces multiple DB writes in rapid succession from different processes. SQLite uses file locking — concurrent requests cause lock contention.

2. **Array fields in the schema:** The new data model requires `features String[]` and `constraints String[]` on the Project model. SQLite has no native array type. With Prisma, a JSON workaround would have been necessary — with semantic limitations on queries and migrations.

3. **JSON fields with real queries:** `planArtifacts Json?` on Project will need to be queryable in the future (e.g. filter by architecture shape). PostgreSQL has `jsonb` with index support for this.

4. **Production readiness:** project-forge runs on a VPS and is intended to grow as a platform. SQLite in production requires special care around backups, replication, and deployment. PostgreSQL is the more natural choice in this environment (Docker, Stone's VPS).

---

## Decision

Switch from SQLite to **PostgreSQL 16** as the primary database, running via Docker on the same server as the application.

---

## Consequences

### Positive

- Native `String[]` arrays in Prisma without workarounds
- `jsonb` fields with real queries and indexes
- No file-lock contention on concurrent requests
- Consistent with other projects in the stack (Triologue, depsight also use PostgreSQL)
- Full Prisma migration history instead of `db:push`

### Negative / Accepted

- Local setup requires Docker (or a PostgreSQL installation)
- No longer a "start without infrastructure" zero-setup experience for developers

### Mitigated by

- `docker compose up -d postgres` is sufficient to get started
- `.env.example` contains complete configuration
- `npx prisma migrate deploy` runs automatically in the Makefile

---

## Alternatives Considered

| Alternative | Why Rejected |
|-------------|-------------|
| SQLite with JSON workarounds for arrays | Increased complexity, poor query ergonomics, lock contention remains |
| Turso (libSQL, distributed SQLite) | Vendor lock-in, additional dependency, overkill for this setup |
| PlanetScale (serverless MySQL) | Managed service = external dependency, costs, no local dev without tunnel |
| MongoDB | Schema flexibility not needed, Prisma relational query support is better |
