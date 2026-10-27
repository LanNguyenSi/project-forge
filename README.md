# project-forge

A web platform for creating AI-toolchain projects. Describe your project and
[agent-planforge](https://github.com/LanNguyenSi/agent-planforge) plus
[scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit) do the rest.

[![CI](https://github.com/LanNguyenSi/project-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/LanNguyenSi/project-forge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Live:** [project-forge.opentriologue.ai](https://project-forge.opentriologue.ai)

![project-forge New Project view: a generated plan with a scaffold-fit review, task and wave counts, and a file-tree preview before pushing to GitHub.](docs/img/new-project.png)

## Overview

You describe a project in a form, project-forge asks the agent-planforge HTTP
service to plan and scaffold it, you review the generated tasks and file
tree, and on confirmation it creates a GitHub repository with the scaffold
pushed. AI is optional: without it, project-forge uses deterministic intake
mapping plus agent-planforge heuristics; with a local or hosted AI provider
configured, it also enriches intake and reviews scaffold fit server-side.
The same flow is exposed as a token-authenticated REST API so agents can
drive generation programmatically.

## Key Features

- Form-based project intake, with optional AI magic fill
- Deterministic fallback when no AI provider is configured
- Review generated tasks, architecture overview, and file tree before anything is created
- One-click GitHub repository creation with the scaffold pushed (the repository is public, see [GitHub publishing](docs/api.md#github-publishing))
- Token-authenticated REST API (`X-API-Key`) for agents: generate, preview, publish, or one-shot create
- Single toolchain dependency: the agent-planforge HTTP service, which bundles scaffoldkit in its own container (see [ADR-0002](docs/adrs/0002-tool-decoupling-service-boundary.md))

## Quick Start (Docker)

```bash
git clone https://github.com/LanNguyenSi/project-forge.git
cd project-forge
cp .env.example .env
# Fill in required values, see docs/configuration.md
cp docker-compose.override.example.yml docker-compose.override.yml
# Fill in NEXTAUTH_SECRET (openssl rand -hex 32) and NEXTAUTH_URL, or delete
# them from the override (its values take precedence over .env). The database
# needs no setting: docker-compose.yml keeps it on the forge_db volume
# (file:/data/project-forge.db) unless FORGE_DATABASE_URL is set in .env.
make deploy
```

Prerequisites: Docker with Compose (the planforge service is built from a
pinned [agent-planforge](https://github.com/LanNguyenSi/agent-planforge)
release fetched from GitHub, see
[docs/deployment.md](docs/deployment.md#planforge-version); no sibling checkout
is needed), and an existing external Docker network named `traefik`
(`docker network create traefik`). The app is reachable only through Traefik
or a port you publish in the override, see
[docs/deployment.md](docs/deployment.md#routing). The SQLite database is
on the persistent `/data` volume by default; the `DATABASE_URL` in `.env` is
for local development and does not reach the container (use
`FORGE_DATABASE_URL` for another path). Deploys that run
`docker compose -f docker-compose.yml` (deploy-panel, agent-relay) skip the
override file, so keep the secrets in `.env` there. See
[docs/deployment.md](docs/deployment.md).

## Usage

```bash
curl -X POST https://project-forge.opentriologue.ai/api/v1/generate \
  -H "X-API-Key: pf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "projectName": "my-cli-tool",
    "summary": "A CLI that syncs agent memory via Git",
    "features": ["push memory files", "pull and merge"]
  }'
```

Returns `{ ok: true, sessionId, preview }`; pass `sessionId` to `preview` or
`publish`. See [docs/api.md](docs/api.md) for the full REST API reference,
including the one-shot create endpoint and the publish rate limit.

## Documentation

- [Configuration](docs/configuration.md) - required and optional environment variables
- [API reference](docs/api.md) - all v1 REST endpoints, with examples
- [Deployment](docs/deployment.md) - Docker Compose services, service-token rotation
- [Architecture](docs/architecture.md) - system structure, key subsystems, CI/CD pipeline
- [ADR-0002](docs/adrs/0002-tool-decoupling-service-boundary.md) - why planforge is the single HTTP boundary (scaffoldkit stays behind it)
- [Ways of working](docs/ways-of-working.md) - contributor conventions, API conventions, versioning

## Development and Contributing

```bash
cp .env.example .env   # set NEXTAUTH_SECRET, NEXTAUTH_URL=http://localhost:3000, PLANFORGE_URL, PLANFORGE_SERVICE_TOKEN
npm install
npx prisma generate
npx prisma migrate deploy
npm run dev
```

`migrate deploy` applies the committed migrations in `prisma/migrations/`. A
local database that an earlier checkout created with `prisma db push` is
refused (`P3005`): delete it, or run
`npx prisma migrate resolve --applied 20261027000000_baseline` when it still
matches the schema.

Or run `make dev`, which creates `.env` from `.env.example` when it does not
exist yet, then installs dependencies, generates the Prisma client, creates the
database and starts the dev server. The new `.env` gets a generated
`NEXTAUTH_SECRET` and `NEXTAUTH_URL=http://localhost:3000`, with GNU and BSD
(macOS) sed alike; if either edit does not apply, `make` stops with an error
and leaves no `.env` behind. It does not set `PLANFORGE_URL` or
`PLANFORGE_SERVICE_TOKEN`; the summary it prints names both.

Generating a project needs the agent-planforge HTTP service with scaffoldkit.
Locally, run its container from an agent-planforge checkout:
`docker build -f server/Dockerfile -t agent-planforge .` and
`docker run -p 8223:8223 -e PLANFORGE_SERVICE_TOKEN=<token> agent-planforge`.
Then set `PLANFORGE_URL=http://localhost:8223` and the same
`PLANFORGE_SERVICE_TOKEN` in `.env`.

Run `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test`
before opening a PR; `npm run test:coverage` reproduces CI's coverage
thresholds. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[docs/ways-of-working.md](docs/ways-of-working.md) for full conventions.

## License

MIT
