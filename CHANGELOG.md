# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Per-provider character budget for the intake-enrichment call.** A new `maxContextChars` capability (local 20000, hosted 50000) drives proportional truncation of large uploaded attachment bodies so the enrichment prompt no longer risks a silent context-window overflow on small-context local models; truncation keeps the injection sentinels intact and is surfaced non-silently via `orchestration.attachmentsTruncated`/`notice` and a warning.

## [0.3.0] - 2026-05-28

**Headline: Publishing now works for project-pilot SSO users without a second GitHub step. The OAuth token forwarded from pilot is stored and reused to create and push the repo, and when publish fails the real reason surfaces instead of an opaque error. Plus two AI-input hardenings and a round of dependency/security bumps.**

### Added

- **Injection-sentinel wrap for attachment `inlineText`** in the enrichment prompt, so attachment content can no longer smuggle instructions into the LLM call (#58).
- Mirror planforge's `input_unreadable` skipped value through the generate flow so an unreadable input is surfaced rather than silently dropped (#64).

### Fixed

- **SSO publish: store and reuse the forwarded GitHub OAuth token.** `register-from-project-pilot` persists the verified token as `githubPat` (on create always; on update when none is set or the stored one is itself an OAuth `gho_` token), so a pilot SSO user can publish without connecting GitHub a second time, and a pilot-side scope upgrade propagates on next login. A manually-entered classic (`ghp_`) or fine-grained (`github_pat_`) PAT is never overwritten (#67, #68).
- **Surface the real publish failure reason.** A failed publish now returns a PAT-sanitized, one-line reason in `error` (e.g. a missing `workflow` OAuth scope on a git push) instead of an opaque "Publish failed". The error path also scrubs bare token shapes as defense-in-depth (#68).
- Migrate `next lint` to the ESLint CLI and fix the `any` sites it surfaced, unblocking preflight (#63).

### Security

- Bump `next` to ^15.5.18 to patch 3 high-severity CVEs (#62).
- Bump `brace-expansion` and `ws` to patch CVE-2026-45149 (#65).
- Bump `postcss` (XSS, alert #15) (#60) and `uuid` to ^14.0.0 (bounds-check) (#59).

### Documentation

- Open-source surface: Code of Conduct, contributing, security policy, issue + PR templates (#61).
- Align README and compose comments with Next 15 and the relative planforge path (#66).

## [0.2.0] - 2026-04-24

**Headline: Attachments land end-to-end. A user can now upload an
arc42 / RFC / charter document on the create form, watch the AI
extract intake fields into the form for review, let the attachment
ride through to planforge where its content influences plan generation,
and see the original document committed into the generated GitHub repo
under `docs/context/`. The create-flow also got a unified "Magic Fill"
surface with Prompt | File tabs — single pattern, two seed sources.**

### Added

#### Attachments (v0.1c / v0.1d / v0.2a)

- **Upload control on the create form** (`.md`, `.txt`, `.adoc`; 50k char limit). Filename + char-count chip; Remove button. File content is read UTF-8 client-side and travels in the request body as `attachments: [{ name, mimeType, tier: "text", inlineText }]`.
- **AI enrichment sees the attachment**. `enrichIntake` threads attachment content into the enrichment LLM call under an `additionalContext` key; `ENRICHMENT_SYSTEM_PROMPT` directs the model to use it as primary evidence for NFRs, integrations, data-sensitivity, and planner profile. Single existing LLM call — no new provider hop, no fan-out.
- **Attachments persist into the scaffolded repo** under `docs/context/<name>`, with a README.md index listing each attachment's name + char count + mimeType. The files ride through to the published GitHub repo so the document used as planning input lives alongside the generated code.
- Server-side safety: `persistableAttachments` filters to text-tier with safe filenames (rejects `/`, `\`, `\0`, `.`, `..`, > 200 chars); `writeAttachmentsToScaffold` runs a `path.resolve` + `startsWith(dirPrefix)` runtime guard as defense-in-depth against a future filter regression.

#### Unified Magic Fill

- One "AI Magic Fill" panel with **Prompt | File tabs** (`components/ProjectForm.tsx`) replaces the previous two separate surfaces (prompt row + standalone attachment block).
- Prompt tab: unchanged one-line input.
- File tab: drop a `.md`/`.txt`/`.adoc`, click Fill Form, the five intake fields populate from the document's content (extraction mode; the LLM is prompted not to invent scope beyond what's stated). The attachment is retained in state after the fill so it still rides along on submit.
- Standing chip in the Prompt tab reminds users the doc will still travel with the submit (v0.1d enrichment + v0.2a persist remain active).
- Server-side hardenings on the route: 50k-char cap on `fileContent` (**413** on overflow) and `fileName` sanitization (collapse newlines, truncate to 200 chars) to block in-prompt injection via a crafted filename.

#### Auth

- `register-from-project-pilot` identity-broker endpoint + optional GitHub-login allowlist.
- Per-user isolation test suite pinning v1 REST endpoints against cross-user leakage.

### Changed

- **ADR-0002 sunset complete: legacy shell-out paths removed.** All four generate routes (`/api/generate`, `/api/planforge`, `/api/v1/generate`, `/api/v1/projects`) previously had a `child_process.spawn("node bootstrap-plan.js …")` code path guarded by `PLANFORGE_MODE` or env-presence checks, and a separate `runCommand(scaffoldkitPython, ["-m", "scaffoldkit.cli", "from-planforge", …])` step. Both are gone. The sole path is now `POST ${PLANFORGE_URL}/api/generate` with `scaffold: true` (default); planforge runs both the CLI and scaffoldkit in its container and returns a tarball carrying planning artifacts and scaffolded files together.
- Docker compose sibling-relative build contexts fixed (host-path for volumes, relative for build).

### Removed

- **Python + scaffoldkit venv from the runtime image.** `Dockerfile` no longer installs `python3`, `python3-pip`, or `python3-venv`; the `CMD` no longer creates `/app/.sk-venv` or `pip install -e /tools/scaffoldkit`. Expected image-size shrink is ~100–150 MB.
- **Bind-mounts for `/root/git/agent-planforge` and `/root/git/scaffoldkit`** from `docker-compose.yml`. project-forge's `app` container no longer sees `/tools/agent-planforge` or `/tools/scaffoldkit`.
- **`app/api/planforge/route.ts`** — dead route, no callers.
- **`lib/planforge-runner.ts`** (`executePlanforgeWorkflow`) — no longer used by any caller.
- **Env vars**: `PLANFORGE_PATH`, `PLANFORGE_MODE`, `SCAFFOLDKIT_PATH`, `SCAFFOLDKIT_PYTHON` deleted from `docker-compose.yml`, `Dockerfile`, `.github/workflows/ci.yml`.

### Migration

Operators running project-forge on VPS:
1. Ensure the planforge container (>= v0.2.0) is running and healthy. The default `docker-compose.yml` builds planforge from `../agent-planforge/server/Dockerfile` alongside `app`.
2. After pulling this release, `docker compose build && docker compose up -d` recreates `app` without Python.
3. `PLANFORGE_URL` + `PLANFORGE_SERVICE_TOKEN` remain required in `.env`.

### Known follow-ups (non-blocking)

- `67b5b608` — injection-sentinel wrap for attachment `inlineText` in the enrichment prompt
- `96ec97bc` — soften "primary evidence" prompt wording so explicit user intake choices aren't silently overridden
- `bb8d1687` — per-provider token-budget for small-context local models

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
  service when `PLANFORGE_URL` is set (ADR-0002 v1, #45). Service
  URL + bearer token come from env (`PLANFORGE_URL`,
  `PLANFORGE_SERVICE_TOKEN`); without `PLANFORGE_URL` the route
  falls back to the legacy shell-out path.
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
- AI provider precedence: when `LOCAL_AI_BASE_URL` +
  `LOCAL_AI_MODEL` are set, the local OpenAI-compatible endpoint
  wins; otherwise Groq (`llama-3.3-70b-versatile`) when
  `GROQ_API_KEY` is set; otherwise OpenAI (`gpt-4o-mini`) when
  `OPENAI_API_KEY` is set; otherwise no AI features.
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
