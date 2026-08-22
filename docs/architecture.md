# Architecture: project-forge

## Overview

project-forge is a full-stack web application built with **Next.js 15** (App
Router) and **TypeScript**. Users describe a project in a form, the server asks
the **agent-planforge HTTP service** to plan and scaffold it (planforge runs
both the planforge CLI and scaffoldkit in its own container, see
[ADR-0002](adrs/0002-tool-decoupling-service-boundary.md)), the result is
extracted into a temporary directory, previewed, and on confirmation pushed to a
new GitHub repository.

The same capabilities are exposed as a token-authenticated REST API under
`app/api/v1/` so agents can drive generation programmatically.

## Principles

1. **Code is the source of truth**: behaviour lives in the route handlers and
   `lib/` modules; docs track the code, not the other way round.
2. **Thin UI, server-side orchestration**: pages collect input and render
   previews; planning, scaffolding, and GitHub push happen in server route
   handlers.
3. **One external boundary**: project-forge talks to a single dependency, the
   planforge HTTP service. scaffoldkit is an implementation detail behind it and
   is never invoked from this app.
4. **No secrets in responses or logs**: internal error detail (file paths,
   stderr, PATs) is sanitized before it reaches clients or logs.
5. **Dark-only UI**: Tailwind, dark-first, no light mode.

## System Structure

```
project-forge/
├── app/                          # Next.js App Router
│   ├── (dashboard)/              # Auth-protected pages
│   │   ├── create/page.tsx       # Project creation form
│   │   ├── dashboard/page.tsx    # User dashboard
│   │   ├── login/page.tsx        # Login
│   │   └── settings/page.tsx     # User settings / API tokens
│   ├── api/                      # Route handlers
│   │   ├── v1/                   # Public REST API (X-API-Key auth)
│   │   │   ├── generate/route.ts # Plan + scaffold, return a sessionId
│   │   │   ├── preview/route.ts  # Read a previously generated session
│   │   │   ├── publish/route.ts  # Create GitHub repo from a session
│   │   │   └── projects/route.ts # GET list / DELETE / POST one-shot create
│   │   ├── auth/                 # NextAuth + project-pilot registration broker
│   │   ├── generate/route.ts     # Web UI generation (session auth)
│   │   ├── publish/route.ts      # Web UI publish (session auth)
│   │   ├── ai-assist/route.ts    # AI form enrichment ("magic fill")
│   │   └── dashboard/route.ts    # User/token management
│   ├── docs/page.tsx             # Swagger UI over public/openapi.json
│   ├── layout.tsx                # Root layout
│   └── globals.css               # Global styles + Swagger dark overrides
│
├── components/                   # React components (ProjectForm, PreviewPanel, modals, AppShell)
├── lib/                          # Server-side business logic (see below)
├── prisma/schema.prisma          # SQLite schema (users, API tokens, usage log)
├── middleware.ts                 # Auth + API-key gating
├── public/openapi.json           # OpenAPI spec served at /docs
└── tests/                        # Vitest integration + unit tests
```

## Key Subsystems

### 1. Routing and API surface

Route handlers under `app/api/` export HTTP-method functions (`GET`, `POST`,
`DELETE`) and return `NextResponse.json()` with explicit status codes.

- **Public REST API** lives under `app/api/v1/` and authenticates with an
  `X-API-Key` header carrying a dashboard-issued `pf_*` token
  (`validateApiToken` in `lib/db.ts`).
- **Web UI routes** (`app/api/generate`, `app/api/publish`, `app/api/dashboard`,
  `app/api/ai-assist`) use NextAuth session auth.
- `middleware.ts` gates the protected surfaces.

Error responses follow the shape `{ ok: false, error: string, details?: string }`.

### 2. Generate / preview / publish flow

The v1 API is session-oriented and the steps share a single `sessionId` (a
UUID):

1. `POST /api/v1/generate` builds a planforge input
   (`lib/planforge-orchestrator.ts`), calls the planforge service over HTTP
   (`lib/planforge-client.ts`), extracts the returned tarball into
   `${FORGE_TEMP_DIR}/<sessionId>`, runs a post-scaffold review
   (`lib/post-scaffold-review.ts`), and returns `{ ok, sessionId, preview }`.
2. `GET /api/v1/preview?sessionId=<uuid>` re-reads the same temp dir and returns
   the preview (`lib/v1-shared.ts`).
3. `POST /api/v1/publish` (body `{ sessionId }`) creates a GitHub repo via the
   user's own PAT and pushes the scaffold.

Sessions expire one hour after generation (`SESSION_TTL_MS` in
`lib/v1-shared.ts`); the temp dir is the only state. `POST /api/v1/projects` is a
one-shot variant that does generate plus publish in a single call without a
preview step.

### 3. The planforge boundary

`lib/planforge-client.ts` is the only outbound integration. It POSTs to
`${PLANFORGE_URL}/api/generate` with a `Bearer ${PLANFORGE_SERVICE_TOKEN}`
header, consumes an SSE stream, and untars the base64 gzipped result into the
request temp dir. The planforge container runs scaffoldkit internally; this app
ships no Python and no scaffoldkit venv (see the Dockerfile and ADR-0002).

### 4. Config loading

Configuration is environment-variable based (no config file). Values are read
directly from `process.env` at the point of use, for example `PLANFORGE_URL`,
`PLANFORGE_SERVICE_TOKEN`, `FORGE_TEMP_DIR`, `DATABASE_URL`, `NEXTAUTH_SECRET`,
the optional AI-provider keys, and the optional `ALLOWED_GITHUB_LOGINS`
allowlist. See the README "Environment Variables" tables for the full list and
which are required.

### 5. Persistence

Prisma over **SQLite** (`prisma/schema.prisma`, `provider = "sqlite"`). The
client is a cached singleton in `lib/db.ts`. The schema syncs via
`npx prisma db push` (there is no `prisma/migrations` directory). Core models:
`User`, `ApiToken`, and `UsageLog` (one row per published project, also the
basis for rate limiting).

### 6. Rate limiting

`checkRateLimit(userId)` in `lib/db.ts` counts `UsageLog` rows for the user in
the trailing 24 hours against `RATE_LIMIT_PER_DAY` (10). It is consumed only by
the publish path (`app/api/v1/publish`) and the one-shot
`POST /api/v1/projects`; `generate`, `preview`, and the list/delete endpoints
are unmetered.

### 7. Secret handling

The publish path sanitizes any embedded GitHub PAT (`x-access-token:...@` remote
URLs and bare `gho_/ghp_/ghu_/ghs_/github_pat_` token shapes) before the message
reaches logs or responses. AI provider keys and the planforge service token are
read from env only.

## CI/CD Architecture

The pipeline runs on GitHub Actions (`.github/workflows/ci.yml`) on Node 20:

1. `npm ci --legacy-peer-deps`
2. `npx prisma generate`
3. `npx tsc --noEmit --skipLibCheck` (typecheck)
4. `npm run lint` (ESLint)
5. `npm run build` (`next build`; this step also injects mock `GITHUB_TOKEN`/`GITHUB_OWNER` env vars)
6. `npm run test:coverage` (`vitest run --coverage`)

## Testing Strategy

Test runner: **Vitest** with `happy-dom`. Integration and unit tests live under
`tests/` (`tests/integration/`, `tests/unit/`) and exercise the route handlers
and `lib/` modules directly. Run with `npm test` or `npm run test:watch`.

## Decisions

See the [ADR log](adrs/) for architectural decisions and their rationale.
