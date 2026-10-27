# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **The database schema is managed by committed migrations instead of `prisma db push` at container start.** `prisma/migrations/` holds a baseline migration (`20261027000000_baseline`, generated from the current `prisma/schema.prisma`), and the container CMD is now `sh scripts/start.sh node_modules/.bin/next start`. The script applies `prisma migrate deploy` before the server starts and never runs `db push`: a missing or empty database is created from the migrations; a database with migration history gets `migrate deploy` (with a copy first when a migration is pending); a database that `db push` created (tables, no `_prisma_migrations`) is baselined only when it equals `prisma/schema.prisma` exactly (checked with `prisma migrate diff --exit-code`), and otherwise the start aborts with a message and leaves the file untouched. Before the baseline is recorded and before a pending migration is deployed, the script copies the SQLite file to `<database file>.pre-migrate-<UTC timestamp>` next to it (`sqlite3 .backup`, mode 600; the runner image now installs `sqlite3`); a failed copy, check, resolve or deploy ends the start with a non-zero exit and no server. A migration that fails halfway (prisma keeps the statements that ran and records the migration as failed) stops every later start before `migrate status`, without a new copy and without `migrate deploy`; the log names the migration, its start time and the newest pre-migrate copy that is not newer than that start, which is the one to restore. CI gains a `Migrations match schema.prisma` step (`sh scripts/check-migrations.sh`: `migrate deploy` on a fresh SQLite file, then `migrate diff --exit-code` against the schema, so a schema change without a migration fails) and checks that the built image carries `sqlite3`, the start script and the migrations; the start script has its own tests (`tests/integration/start-script.test.ts`, stub `prisma` plus real SQLite and real `prisma`), and so has the check (`tests/integration/check-migrations-script.test.ts`). `npm run db:push` is replaced by `db:migrate`, `db:migrate:dev` and `db:check-migrations`; `make dev-db`, CONTRIBUTING, the PR template and the docs follow. `docs/deployment.md` gains the "Database migrations" and "Upgrading to committed migrations" sections (auto-baseline, the abort message and its recovery, the copy and its cleanup, rollback does not undo the schema, expand/contract with migrations) the "A migration failed halfway" recovery, a rollback warning (never start a `db push` release, 0.8.0 and earlier, on a database with any migration after the baseline: it silently drops empty columns, tables and indexes that the older schema does not know), and a note that the 0.7.0 steps predate migrations: an upgrade from before 0.7.0 straight to this release must tighten `ApiToken` (nullable `tokenHash` and `tokenPrefix` after the contract step) before the start can baseline the file. Operator note for the next deploy: with the production database equal to the schema (check beforehand, read-only: `docker compose exec app sh -c 'node_modules/.bin/prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code'` exits 0), the first start writes `/data/project-forge.db.pre-migrate-<timestamp>` on the `forge_db` volume (a full copy of the database, free space needed), records the baseline and starts as before; no manual step is required, and the copy can be deleted once the release has run well. If the database differs, the container exits with `[db-start] ERROR: ... differs from prisma/schema.prisma` and the file is unchanged; recovery is in `docs/deployment.md`. A local database created by `db push` is refused by `migrate deploy` (`P3005`): delete it or run `npx prisma migrate resolve --applied 20261027000000_baseline` when it still matches the schema. Rolling the code back does not undo a migration.
- **The planforge image is built from a pinned agent-planforge revision, not from a sibling checkout.** The `planforge` service in `docker-compose.yml` now uses the git build context `https://github.com/LanNguyenSi/agent-planforge.git#2438f9a47da23de378b0943e8f073a41decdb00a` (the agent-planforge main commit production already built from, one commit after v0.6.0 with the scaffoldkit v0.4.3 bump) instead of `../agent-planforge`, so a clean clone builds, a rollback rebuilds the same toolchain, and project-forge no longer builds whatever the separately deployed agent-planforge checkout holds. The ref is set in one place (the default of `PLANFORGE_CONTEXT`); updating planforge is a one-line change, and `PLANFORGE_CONTEXT=../agent-planforge` in `.env` points a local build back at a checkout. Operator note: the first deploy after this change fetches agent-planforge from GitHub (the Docker daemon on the host needs outbound access to github.com), and the sibling `agent-planforge` checkout on the VPS is no longer used by project-forge. The README prerequisite for a sibling checkout is gone.
- **Docker image installs what CI tests.** The builder stage now runs `npm ci --legacy-peer-deps --no-audit --no-fund` (same flags as CI) instead of `npm install`, so the lockfile is enforced. The runtime image no longer copies the builder's full `node_modules`: a separate `deps` stage installs production dependencies only (`npm ci --omit=dev`) and runs `prisma generate`, so eslint, vitest, typescript and the other dev tooling are no longer in the image (about 40 MB smaller). `prisma` moved from `devDependencies` to `dependencies` because the container CMD runs `prisma db push`; the lockfile changes only in the prisma entry and in dev flags. The CMD calls `node_modules/.bin/prisma` and `node_modules/.bin/next` instead of `npx`, so start needs no network fetch; the semantics (`db push` then `next start`) are unchanged. A `.dockerignore` keeps host `node_modules`, `.next`, `.git` and `.env*` out of the build context. CI gains a `docker-build` job that builds the image (no push) so Dockerfile drift fails a pull request.

## [0.8.0] - 2026-10-25

Operator action required before deploying: unauthenticated `/api/ai-assist` calls now answer 401, `PLANFORGE_SERVICE_TOKEN` is required in `.env`, the database defaults to the `forge_db` volume (`FORGE_DATABASE_URL`), and deploy-panel and agent-relay skip `docker-compose.override.yml`.

### Changed

- **Compose stack safe by default.** `docker-compose.yml` now sets the app's `DATABASE_URL` to `${FORGE_DATABASE_URL:-file:/data/project-forge.db}`, so a deploy without any database setting keeps the database on the `forge_db` volume instead of in the container layer. `FORGE_DATABASE_URL` is a compose-only knob read from `.env` or the shell; the `DATABASE_URL` in `.env` is for local development and does not reach the container. A `DATABASE_URL` set only in `docker-compose.override.yml` still wins for plain `docker compose` runs, but deploy-panel and agent-relay run `docker compose -f docker-compose.yml`, which skips the override, so on those deploys the database path and the secrets must come from `.env`. `PLANFORGE_SERVICE_TOKEN` is required (`${VAR:?}`) for both services, so compose stops with an error naming it instead of starting `planforge` with an empty token; it must be in `.env` or the shell even when the override also sets it, because compose interpolates `docker-compose.yml` before merging the override, so a token that only the override sets now stops every compose command. The `app` service gets a healthcheck against the new public `GET /api/health` route, and both services use bounded `json-file` logs (`max-size: 10m`, `max-file: 3`). `make pull` now rebuilds with `--build` like `make deploy`, so it no longer starts a stale image. The production server refuses to serve (the process keeps running, every request returns 500, the healthcheck fails and the container turns `unhealthy`) when `NEXTAUTH_SECRET` is missing, empty or still the placeholder from the example files. `docker-compose.override.example.yml` shrinks to the secrets, and `docs/deployment.md` documents the precedence with a table for plain and `-f docker-compose.yml` runs, the required secrets, the `forge_tmp` cleanup as a cron step, and an upgrade note that reads the live `DATABASE_URL` before the deploy.
- The app now self-hosts its fonts: `next/font/google` (Space Grotesk 500/700, IBM Plex Sans 400/500/600, IBM Plex Mono 400/500) is replaced by `next/font/local` with vendored woff2 files and their OFL licenses in `app/fonts/` (Space Grotesk as a variable font, IBM Plex as the static weights actually used). `next build` no longer contacts fonts.googleapis.com or fonts.gstatic.com, so a throttled or malformed Google response can no longer fail CI or a deploy. Every subset Google served for these families is vendored (latin, latin-ext, vietnamese, and cyrillic, cyrillic-ext, greek where the family has them), so glyph coverage matches the previous build; only latin is preloaded. The `--font-display`, `--font-sans` and `--font-mono` variables and `display: swap` are unchanged. CI gains a guard that fails when `next/font/google` is imported again.

### Security

- Publish 500 responses no longer echo git stderr to clients. `POST /api/publish` and `POST /api/v1/publish` stopped returning the secret-scrubbed git stderr in `details` (`/api/v1/publish` also embedded it in `error`). The body now carries a known, user-actionable reason as a fixed sentence (GitHub push refused for a missing `workflow` scope, rejected credentials, repository name already taken, rate limit, network unreachable) or `An internal error occurred. Reference: <id>` like the other API 500 responses; the full PAT-scrubbed stderr is always logged server-side, and only the generic answer carries a reference id (the id the client receives, tying the response to the log line) (`summarizePublishError` in `lib/publish-error.ts`). `/api/v1/publish` drops its private three-pattern token mask in favor of the shared `lib/scrub-secrets.ts`, which also masks `https://TOKEN@` userinfo. Every status code is unchanged, and `/api/v1/publish` keeps the `Publish failed: ` prefix on `error`, so the consumer that shows the publish reason (project-pilot) keeps working and now shows a complete sentence instead of a raw git line. Temp-dir paths, remote URLs and git internals no longer reach clients.
- `GET` and `POST /api/ai-assist` now require a NextAuth session and answer `401 { ok: false, error: "Not authenticated" }` without one, like `/api/generate` and `/api/publish`. Before, an anonymous caller could read the configured AI provider and model and drive LLM calls at the instance's cost. The magic-fill form treats a 401 as "feature unavailable" on load and shows a sign-in message when a request is rejected.
- API 500 responses no longer return the raw exception message in `details`. `POST /api/auth/register`, `POST /api/generate`, `POST /api/ai-assist`, `POST /api/dashboard/pat`, `POST /api/dashboard/tokens`, `DELETE /api/dashboard/tokens/[id]` and `POST /api/v1/projects` now answer with a generic sentence and a short reference id, and the full error is logged server-side under the same id (`lib/server-error.ts`), with GitHub tokens and token-bearing remote URLs masked (`lib/scrub-secrets.ts`) because Prisma errors can embed argument values. Prisma messages, file paths and upstream payloads no longer reach the client. `POST /api/v1/projects` still returns its user-actionable GitHub messages (invalid or expired PAT, missing permissions, repository name already exists) in `details`, at the same status as before. The publish routes (`/api/publish`, `/api/v1/publish`) were left with their scrubbed, user-facing failure reason at that time, and 4xx validation details are unchanged; the entry above replaces that failure reason with fixed sentences and a reference id.
- **tailwindcss 4.3.3** (GHSA-rj75-hqrm-r3gf): the app moves from Tailwind CSS 3 to 4 (`@tailwindcss/postcss`, theme now in the `@theme` block of `app/globals.css`, `tailwind.config.ts` and `autoprefixer` removed), which drops `postcss-selector-parser` 6.x from the tree. The UI is unchanged apart from Tailwind 4 rendering details.
- **next 15.5.27** (GHSA-mcj8-r9mp-w47p, GHSA-4jqv-mc3x-m676): the lockfile resolves 15.5.27 with its matching `@next/env` and `@next/swc-*` packages and the `next` dependency floor is now `^15.5.27`.
- **next 15.5.28** (GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r): the lockfile resolves 15.5.28 with its matching `@next/env` and `@next/swc-*` packages and the `next` dependency floor is now `^15.5.28`, superseding the 15.5.27 entry above.
- **dompurify 3.4.17** (GHSA-cg2g-xh64-v4q7, GHSA-mrv2-3pqr-j5jr, GHSA-c6gr-qvv4-5v3f), installed through `swagger-ui-react`: the lockfile resolves 3.4.17, the first release patched for all three advisories.
- **happy-dom 21.0.4** (GHSA-834v-8h66-3h79), a dev dependency used as the vitest test environment: the `happy-dom` range moves from `^20.8.8` to `^21.0.4`, the first release line patched for the advisory. It pulls in `buffer-image-size` and raises its `ws` floor to `^8.21.0` (already resolved). No test changes were needed; the npm audit gate reports no HIGH or CRITICAL advisory outside the allowlist again.
- **sharp 0.35.5** (GHSA-wq5f-xc86-pv6w, task aff72e2b), installed through `next`: the lockfile resolves 0.35.5 with matching `@img/*` binaries and the `sharp` override floor is now `^0.35.5`.

### Fixed

- **`/create` form and app shell accessibility.** The five project form fields (`Project Name`, `Summary`, `Core Features`, `Constraints`, `Target Users`) are wrapped in `Field`, so their labels are programmatically associated and they no longer take their names from placeholders; the magic-fill prompt input and the document upload input get screen-reader-only labels ("AI seed prompt", "Upload a project document"). The "AI Magic Fill" heading is an `h2` under the page `h1` (it was an `h3`, skipping a heading level). The task category label in the generation preview is plain `text-forge-ash` instead of `text-forge-ash/60` (5.7:1 on the `forge-iron` card, was about 2.9:1). The mobile top bar is a `<header>` (banner landmark), so page content is no longer outside every landmark at 390 px (axe `region`); `md:hidden` keeps it out of the accessibility tree at the desktop layout, where the shell (sidebar `aside` + `main`) adds no banner, so a page never shows two banners in one viewport.
- Docs drifts corrected: the CI step list, the structure trees (`app/api/health`) and the `PLANFORGE_URL` note now match the code.
- **Accessibility primitives.** `Label` and `Input`/`Textarea` are now associated through a new `Field` wrapper (generated id, or explicit `id`/`htmlFor`), so the login email and password fields (the password field had no accessible name), the styleguide inputs and the Settings fields are named in the accessibility tree; the Settings PAT and token-name inputs get `aria-label`s. `Alert` announces: `role="alert"` for the error variant, `role="status"` (polite) for success, warning and info. The Settings token meta line (`text-forge-ash/70`, about 3.3:1) now uses plain `text-forge-ash` (about 5.2:1), and the dashboard "Step 1 of 2" pill uses `text-ember-soft` (about 5.0:1 instead of 4.2:1). `/styleguide` gets a `<main>` landmark and its color swatch names are readable (they were rendered in the page background color), and the "GitHub connection required" heading on `/create` is an `h2` under the page `h1`. `@testing-library/dom` (the peer of `@testing-library/react`) is now a dev dependency so component tests run under `npm ci --legacy-peer-deps`.
- **Mobile navigation and API docs are usable by keyboard and screen reader.** The hamburger button has an accessible name ("Open navigation menu") with `aria-expanded` and `aria-controls`, and is 44 px square (was 36 px). The mobile drawer is now a modal dialog built on `DialogShell` (new `drawer` variant): `role="dialog"`, `aria-modal`, a label, focus moves into it on open and back to the hamburger on close, Tab stays inside, and Escape or a click on the overlay closes it. The drawer also closes when the window grows to the desktop layout (768 px and wider, for example a phone rotated to landscape), so its focus trap and scroll lock never outlive the hidden drawer. The public navigation links ("Docs", "Login") have a 36 px tall hit area (were 20 px). On `/docs` both code blocks scroll inside themselves and are keyboard focusable, so the page no longer scrolls horizontally at 390 px, and the swagger-ui server select gets the accessible name "API server".
- **Copy and dev setup match the code.** The Settings PAT field suggests a classic `ghp_` token, the only format the API accepts. Rate-limit texts (Settings, docs page, API error, OpenAPI) say "rolling 24-hour window" instead of "per day"; the OpenAPI publish descriptions say the repository is created as public. The landing page no longer claims no PAT is needed. `.env.example` documents `PLANFORGE_URL` and the AI provider order, and `make dev-env` works with BSD sed and fails instead of reporting a secret it did not write (task a4bfb0cc).
- AI magic fill ("Fill Form"), intake enrichment and the post-scaffold
  review failed on Groq ("AI assist failed"): the hard-coded
  `llama-3.3-70b-versatile` was retired by Groq and now returns 404. The
  Groq default is `openai/gpt-oss-120b` (Groq's named replacement), sent
  with `reasoning_effort: "low"` and extra token headroom so the reasoning
  does not truncate the JSON answer.

### Added

- `npm audit` gate: an ID-scoped, dated allowlist (`.github/audit-allowlist.json`) with one entry for GHSA-vfj7-8cjw-p6xm (braces 3.0.3, dev dependency only, no upstream fix; reviewBy 2027-01-08). The gate step now captures `npm audit --audit-level=high --json` and classifies it with the dependency-free `scripts/audit-gate.mjs`, vendored from depsight commit be8c7ea, so any other HIGH or CRITICAL advisory still fails the job. A dependency-free self-test (`node --test scripts/audit-gate.test.mjs`) runs before the gate.
- The `Audit` gate is re-vendored from depsight #172: `scripts/audit-gate.mjs` now treats a report whose `metadata.vulnerabilities` HIGH plus CRITICAL tally disagrees with, or is missing against, its `vulnerabilities` map as UNCLASSIFIED (exit 3), prints npm's stderr itself through a sanitiser (each line behind an `npm stderr| ` prefix, reduced to a safe character set, length and count bounded) instead of the workflow step copying it raw, and the gate step fails (exit 3) when the classifier exits 0 without the `npm audit gate: CLEAN` line. The non-blocking report step prints npm's output between `::stop-commands::` and a per-run random resume token. The allowlist entries are unchanged. Tracker task dbbc4994.
- `GROQ_MODEL` env var to override the Groq model without a release.

## [0.7.0] - 2026-10-04

Breaking: API tokens are now stored hashed (schema change plus a two-phase data migration that must run during the deploy, see Migration), `GET /api/dashboard` no longer returns `user.githubPat` (now `githubPatConnected`) or `tokens[].token` (now `tokenPrefix`), and a repeat `register-from-project-pilot` call now revokes the previous token and issues a new one. Error responses from the routes that still returned a bare `{ error }` now also carry `ok: false` (an added field, breaking only for strict-schema validators).

### Added

- `tasks[].dependsOn` in the `/api/v1/generate` and `/api/v1/preview`
  responses, merged from `planning/plan-output.json` (ids reference the
  ids of the same response; dangling ids are dropped, empty lists omit
  the field). `wave` is backfilled from the same source when a task file
  carries no `## Wave` section. Feeds project-pilot's dependency-aware
  Forge-v2 import (pilot #125).
- The v1 OpenAPI spec (`public/openapi.json`) now documents every v1
  operation (`GET`/`DELETE /api/v1/projects`, `POST /api/v1/generate`,
  `GET /api/v1/preview`, `POST /api/v1/publish`, in addition to
  `POST /api/v1/projects`), and `ErrorResponse` requires `ok: false`. A
  contract test keeps the spec in step with the exported v1 routes.
- Optional `API_TOKEN_HASH_SECRET` environment variable: the key used to
  hash API tokens at rest. Defaults to `NEXTAUTH_SECRET`.
- `scripts/backfill-api-token-hashes.js`: two-phase (expand, then
  `--contract`) migration that hashes existing plaintext API tokens in
  place, so existing tokens keep working.
- `GET /api/dashboard/pat`: returns the signed-in owner's stored GitHub
  PAT for the settings page.
- Documentation: the README is condensed, with the environment variables,
  the v1 REST reference and the compose runbook moved to
  `docs/configuration.md`, `docs/api.md` and `docs/deployment.md`.

### Fixed

- `GET /api/v1/projects` clamps `limit` to 1-200 (default 50) and
  `offset` to 0 or more, and truncates fractional values, so out-of-range
  or non-numeric query values no longer reach the database query as is.
- Legacy `/api/generate` (`app/api/generate/route.ts`) no longer emits
  `dependsOn: ["None"]` for a dependency-free task. It regexes `## Depends
  On` out of `tasks/*.md` independently of `/api/v1/*`'s `readPreviewData`
  merge, and had no dedup or dangling-id filter, so
  agent-planforge's `- None` empty-list rendering leaked straight into the
  response. Now dedups and drops dangling/sentinel ids the same way
  `readPreviewData` does (both now share one `resolveDependsOn` helper in
  `lib/v1-shared.ts`), plus an explicit exact-match exclusion of the
  literal `"None"` sentinel so a task-file name with no numeric prefix
  can't reintroduce it via the id-matching fallback.

### Security

- API tokens (`pf_*`) are no longer stored or re-served in plaintext. The
  `ApiToken` table stores a keyed SHA-256 digest (`tokenHash`) plus a
  non-secret `tokenPrefix`; the raw token is shown once at creation.
  `GET /api/dashboard` returns only the prefix. A repeat call to
  `register-from-project-pilot` revokes the old token and issues a fresh
  one instead of returning the existing value.
- `GET /api/dashboard` no longer returns the raw GitHub PAT; it returns
  `githubPatConnected: boolean`, and the raw value is available only to
  the owner through `GET /api/dashboard/pat`.
- Dependency advisories cleared across the lockfile: next 15.5.25
  (GHSA-2xp9-vwfh-vxw4, GHSA-p293-qw3h-jr36), next-auth 4.24.15 (critical),
  sharp 0.35.4, js-yaml 4.3.2, vitest 4.1.11, nanoid 3.3.18,
  brace-expansion patched releases, postcss 8.5.23 (floor `^8.5.18`), plus the
  in-range fixes from `npm audit fix`.
- Bumped dompurify 3.4.11 to 3.4.16 (transitive, via swagger-ui-react,
  whose `^3.4.12` range already allows it) for GHSA-55q2-fjhq-7xh7 and
  GHSA-p98j-92pf-mc4p. Lockfile-only change.
- Bumped axios 1.18.1 to 1.20.0 (transitive, via @swagger-api/apidom-reference)
  for the advisories published 2026-09-30 against axios < 1.20.0 (for
  example GHSA-r4gj-5m52-g5wh). Lockfile-only change.
- `lib/planforge-output.ts`'s `resolveArtifactPath` now rejects a
  `planforge-index.json` entry that resolves outside the session's temp
  directory via a `../`-laden relative path, falling back to the same
  default path used when the entry is absent. (An absolute-looking entry,
  e.g. `/etc/passwd`, was already contained even before this change:
  `path.join` re-roots a subsequent absolute segment under the temp dir
  rather than treating it as absolute, so this guard specifically closes
  the `../` traversal class.) Covers all four artifact paths the resolver
  derives (`tasksDir`, `architecturePath`, `scaffoldkitInputPath`,
  `planOutputPath`) — several of which are read and mirrored verbatim into
  API responses (e.g. `architectureOverview`). The index is generated by
  the same session's planforge tarball today, so the blast radius was
  narrow. Containment is lexical, not realpath-based: a symlink placed
  inside the session directory that points outside it is still followed
  end-to-end, consistent with the rest of this module, which never
  realpaths its inputs.

### Changed

- **Breaking, migration required:** `ApiToken.token` is replaced by
  `tokenHash` and `tokenPrefix` in `prisma/schema.prisma`; the new
  container refuses to start until the data migration has run. See
  Migration below and the "Upgrading to 0.7.0" section of
  `docs/deployment.md`.
- **Breaking response removals:** `GET /api/dashboard` no longer returns
  `user.githubPat` (replaced by `githubPatConnected: boolean`) nor
  `tokens[].token` (replaced by `tokenPrefix`). A repeat
  `register-from-project-pilot` call now revokes the previous token and
  issues a new one instead of returning the existing value.
- Error responses from `POST /api/v1/projects`, `ai-assist`,
  `auth/register`, `auth/register-from-project-pilot` and `dashboard/*`
  now return `{ ok: false, error, details? }` instead of the bare
  `{ error, details? }` shape, matching the other routes. This adds a
  field; it breaks only clients that validate error bodies against a
  strict schema. A guard test enforces `ok: false` on every error
  response under `app/api/**`.
- The `/styleguide` footer and sample badge read the version from
  `package.json` at build time instead of a hard-coded string.
- CI: an npm audit workflow (`audit.yml`) gates the lockfile, `npm ci`
  runs with `--no-audit --no-fund`, and a coverage ratchet runs through
  `npm run test:coverage`.
- CI: `release.yml` now passes step values into `run:` scripts through `env:` and shell variables instead of interpolating `${{ }}` expressions into the script text. No behavior change for normal tags and versions.

### Migration

The API-token schema change cannot be applied by the container's own
`prisma db push` alone: it refuses while `ApiToken.token` still holds
rows, so the new container does not start. Run the two-phase backfill
(`scripts/backfill-api-token-hashes.js`, then `--contract`) around the
cutover, with the same `API_TOKEN_HASH_SECRET` (or `NEXTAUTH_SECRET`)
the new container uses; a different key makes every existing token
invalid. The exact, tested docker compose commands are in "Upgrading to
0.7.0" in `docs/deployment.md`.

## [0.6.0] - 2026-06-25

Forge gains a first-class web UI: a complete Next.js front-end — a landing page, authentication, dashboard, a guided project-create wizard with live preview, settings, and themed API docs — built on a new gold-accented design system. A transitive dompurify advisory and the 2026-06-16 CVE sweep are also cleared.

### Added

- **Forge design foundation and app chrome** (PRs #88, #89; tasks T-001/T-002): a new gold-accented design system and the shared application chrome (navigation, layout shell) that the rest of the UI builds on.
- **Forge web pages** (PRs #90, #91, #92, #96, #97; tasks T-003/T-004/T-005/T-007/T-008): a landing page, login, dashboard, settings, and a docs page with a themed SwaggerUI.
- **Guided project-create wizard** (PRs #93, #94, #95; tasks T-006a/b/c): a `ProjectForm` with a Magic-Fill gold accent, a live `PreviewPanel`, and a multi-step create wizard with Confirm/Error modals.
- **UI polish** (PR #98; task T-009): a gold `Button` variant and `prefers-reduced-motion` accessibility support.

### Security

- **dompurify bumped to ≥3.4.11** (PR #99): a transitive advisory in the dependency tree was cleared.
- **CVE sweep 2026-06-16** (PR #86): vite and js-yaml advisories cleared across the lockfile.

### Docs

- **README/docs reconciled with code** (PR #87): drift between the documentation and the implementation was fixed.

## [0.5.0] - 2026-06-01

### Added

- **Surface the wave-0 blueprint-fit gate at the front of the agent entry path.** When the post-scaffold review emits a blueprint-fit follow-up, the generated entry artifacts (`.ai/TASKS.md`, root `AGENTS.md`) now lead with `tasks/900`, so a fresh agent resolves the scaffold-vs-plan mismatch before starting wave-1 work (#81).

### Changed

- **Keep planforge generation-only artifacts out of the published deliverable.** The whole `planning/` directory and `exports/scaffoldkit-input.json` are excluded from the published repository, and a post-Phase-3 `planforge-index.json` that omits the `handoff` block is tolerated, so a published repo carries only what a consumer needs (#78, #79, #80).

### Fixed

- **Published machine artifacts no longer advertise excluded paths.** The shipped `planforge-index.json` is pruned of the excluded `planning/` and `exports/scaffoldkit-input.json` entries, and the post-scaffold review no longer snapshots the transient `.forge-meta.json`, so a tool that trusts the index for path discovery does not 404 (#84).
- **Honest scaffold verdict and label.** The post-scaffold `runtime-structure-present` check and the preview "Full scaffold" label both require a real source file (by extension), so an empty scaffold (a manifest plus empty directories) is reported as a planning baseline instead of being over-claimed as a full scaffold (#82, #83).

## [0.4.0] - 2026-06-01

### Added

- **Per-provider character budget for the intake-enrichment call.** A new `maxContextChars` capability (local 20000, hosted 50000) drives proportional truncation of large uploaded attachment bodies so the enrichment prompt no longer risks a silent context-window overflow on small-context local models; truncation keeps the injection sentinels intact and is surfaced non-silently via `orchestration.attachmentsTruncated`/`notice` and a warning (#75).

### Changed

- **Attachments are authoritative without overriding explicit intake choices.** The enrichment flow now treats attachment content as authoritative evidence, but stops it from silently overriding intake fields the user set explicitly (#74).
- Honor the `.planforge/docs` relocation in the output-layout review denylist so relocated docs are excluded from review as intended (#73).

### Security

- **Close IDOR, add auth, and stop a PAT leak on the legacy routes (HIGH audit).** Tightens authorization on the legacy routes, adds missing auth checks, and stops a personal access token from leaking in responses (#71).
- **Guard the legacy publish route against `sessionId` path traversal**, rejecting crafted identifiers before they reach the filesystem (#70).
- Bump `axios` to 1.16.1 to patch CVE-2026-44489 (#72).

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
