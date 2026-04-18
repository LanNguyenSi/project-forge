# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-04-18

**Headline: First tagged release of project-forge — the web platform
that turns a project description into a planned, scaffolded, and
GitHub-published repo by orchestrating `agent-planforge` and
`scaffoldkit` end-to-end. Ships a Next.js dashboard, a v1 REST API
for agent integration, and a containerized two-service compose
(`app` + internal `planforge`) ready for VPS deploy via
deploy-panel + agent-relay.**

This is the line in the sand: from v0.1.0 onward, the v1 REST
contract (`/api/v1/projects`, `/api/v1/generate`,
`/api/v1/preview`, `/api/v1/publish`), the dashboard token model,
and the env-var contract follow SemVer. ADR-0002 is in flight —
the legacy planforge / scaffoldkit shell-out paths are still bound
in via read-only mounts during the sunset window and will be
removed in a later release; consumers should not depend on them.

### Added

#### Dashboard (Next.js 15 + Tailwind)

- App-Router-based dashboard with grouped routes:
  `/(dashboard)/dashboard`, `/(dashboard)/create`,
  `/(dashboard)/settings`, `/(dashboard)/login`.
- AppShell + UI primitives, settings page, full user-journey UX
  pass.
- "Describe → Review → Confirm → Build" flow: form-driven intake
  with optional ✨ AI magic-fill, planning preview (tasks,
  architecture, file tree), confirm step that creates a GitHub
  repo with the scaffold pushed.
- `/docs` swagger-ui surface for the v1 REST API.

#### Auth + multi-tenancy

- `next-auth` with email/password and GitHub OAuth.
- Prisma + SQLite for users, sessions, projects, and API tokens.
- Per-user dashboard tokens; `X-API-Key` header model
  (`pf_*` prefix) for v1 API access. Daily rate limit (10 req/day
  per token).
- GitHub OAuth scope includes `workflow` so generated repos can
  carry CI/CD files.

#### v1 REST API

- `GET /api/v1/projects` — list projects for the authenticated
  user.
- `DELETE /api/v1/projects` — soft-delete a project by id.
- `POST /api/v1/generate` — generate a scaffold without
  publishing; returns a preview id.
- `GET /api/v1/preview?previewId=…` — fetch the previewed file
  tree, tasks, and architecture.
- `POST /api/v1/publish` — finalize a previewed project and
  create the GitHub repo.
- `GET /api/v1/projects` returns a `nullable` `repoUrl` — drafts
  and pre-publish previews don't crash list endpoints anymore.

#### Planning + scaffolding integration

- agent-planforge HTTP service client (`PLANFORGE_SERVICE_TOKEN`
  bearer auth) — first step of ADR-0002 decoupling. Generate
  route now talks to the planforge container instead of shelling
  out (#45).
- Resolves planforge artifacts via `planforge-index.json` when
  available, with a legacy-root fallback for older planforge
  installations.
- scaffoldkit invocation runs inside the container against
  bundled Python 3 (no host `sk-venv` required); writes directly
  to the temp dir, no `scaffold/` subdir.
- AI providers: Groq (`llama-3.3-70b-versatile`, primary, free
  tier), OpenAI (`gpt-4o-mini`, fallback), or any
  OpenAI-compatible local endpoint. Lazy instantiation so build
  doesn't prerender against a missing key.
- Server-side intake enrichment + post-scaffold review when an AI
  provider is configured.

#### Container + deploy

- Multi-service `docker-compose.yml` shipping `app` +
  internal-only `planforge` (built from
  `agent-planforge/server/Dockerfile`). `app` reaches `planforge`
  at `http://planforge:8223` over the shared `traefik` docker
  network. No public port for `planforge`.
- Both services share `PLANFORGE_SERVICE_TOKEN` from `.env`;
  manual rotation procedure documented in README.
- `Dockerfile` bundles Python 3 + scaffoldkit so the host needs
  only the source directory and the `SCAFFOLDKIT_PATH` env var.
- `Makefile` with `make deploy`, `.env.example`, and
  `docker-compose.override.example.yml` for local development
  customizations.
- `.relay.yml` so agent-relay can deploy the platform onto a VPS.
- ADR-0002 sunset bind-mounts (`agent-planforge`, `scaffoldkit`)
  for the shell-out fallback paths — read-only, removed once the
  client-swap is complete.

#### Project artifacts + documentation

- `architecture-overview.md`, `delivery-plan.md`,
  `project-charter.md`.
- ADRs: 0001 (overall architecture), 0002 (tool decoupling /
  service boundary).
- Full README covering prerequisites, env-var contract, deploy
  flow, API reference, token rotation.

#### Repo + release engineering

- `.github/workflows/ci.yml` — Node 20, `npm ci --legacy-peer-deps`,
  Prisma generate, `tsc --noEmit --skipLibCheck`, Next.js
  production build (with mocked GitHub + planforge env), vitest.
  Now reusable via `workflow_call` for the release workflow.
- `.github/workflows/release.yml` — tag-driven (`v*`) GitHub
  Release flow that calls CI as a reusable workflow and publishes
  the matching CHANGELOG section as the release body.
- `CHANGELOG.md`, this file. MIT license.

### Changed

- Generate route swapped from shell-out to planforge HTTP
  service (ADR-0002 v1, #45). Service URL + bearer token come
  from env (`PLANFORGE_SERVICE_URL`, `PLANFORGE_SERVICE_TOKEN`).
- Health endpoint is `/` (not `/health`) — agent-relay's
  `health:` field in `.relay.yml` reflects that.
- Removed redundant `pre_update` build step in `.relay.yml`;
  build was running twice per deploy.
- Compose now ships `env_file:` and a SQLite db volume by
  default; relay deploys no longer drop the database between
  redeploys.
- `prisma generate` runs in CI before the TypeScript check (#36).
- Removed Prisma `post_update` migrate from `.relay.yml` —
  SQLite + `db push` doesn't need migration apply on deploy
  (#34).
- Publish flow embeds the user's PAT in the git push remote URL
  (#39) so brand-new empty repos get the first commit cleanly.
- AI provider order: Groq primary, OpenAI fallback. Local AI
  optional, third in the chain.
- Footer links updated: project-forge → GitHub, planforge +
  scaffoldkit linked from footer.

### Fixed

- Soft-delete for projects in v1 API path (#38).
- Nullable `repoUrl` no longer crashes
  `GET /api/v1/projects` (#37).
- Dependabot sweep: hono, follow-redirects, dompurify, axios,
  next, happy-dom — all bumped past advisories (#19, #33, #41,
  #42).
- `/api/v1/projects` scaffoldkit invocation path corrected.
- Lazy OpenAI client construction — fixed build-time
  prerender error when no `OPENAI_API_KEY` is set.
- `publish` uses the logged-in user's GitHub token instead of
  the server-level `GITHUB_TOKEN` so per-user repo ownership
  works.

### Migration notes

- **Two-service compose**: pre-v0.1.0 single-service installs
  must redeploy with the new `docker-compose.yml`. Set
  `PLANFORGE_SERVICE_TOKEN` (`openssl rand -hex 32`) in `.env`
  before `make deploy` — both containers consume the same value
  and mismatched values surface as 401s in the `app` logs.
- **`PLANFORGE_PATH` / `SCAFFOLDKIT_PATH`** are still required
  during the ADR-0002 sunset window for the legacy shell-out
  paths. They will be removed in a later release alongside the
  client swap.
- **AI provider keys** are all optional; without any key the
  intake fall-back uses deterministic mapping plus planforge
  heuristics.
- **API token model**: `X-API-Key` header carries dashboard-issued
  tokens (`pf_*` prefix). Rate limit: 10 req/day per token. Plan
  capacity accordingly.

### Out of scope for v0.1.0

- npm publish — project-forge is consumed as a hosted Next.js
  app or via Docker compose; there is no `npm install
  project-forge` use case. Deferred until a Node SDK ships.
- Token-store + in-place `PLANFORGE_SERVICE_TOKEN` rotation
  (manual rotation only — see README).
- Removal of legacy planforge / scaffoldkit shell-out paths
  (tracked under ADR-0002 client-swap follow-up).
