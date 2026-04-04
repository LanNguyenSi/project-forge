# CLAUDE.md

## What is this project?

project-forge is a Next.js web platform that scaffolds complete GitHub repositories from plain-text project descriptions. It integrates agent-planforge (plan generation), scaffoldkit (file scaffolding), and the GitHub Git Data API (repo creation without local git).

Live: https://project-forge.opentriologue.ai

## Tech Stack

- **Runtime:** Node.js 20, TypeScript 5.4 (strict mode)
- **Framework:** Next.js 15 (App Router, React 18, server components)
- **Styling:** Tailwind CSS 3.4
- **Database:** PostgreSQL 16 via Prisma 5.22
- **Auth:** NextAuth 4 (GitHub OAuth)
- **GitHub:** @octokit/auth-app + @octokit/rest (GitHub App API)
- **Testing:** Vitest 4 + happy-dom + Testing Library
- **Deployment:** Docker (multi-stage) + Traefik reverse proxy

## Commands

```bash
make dev              # Full local setup: .env + deps + DB + dev server
npm run dev           # Start Next.js dev server only
npm test              # Run tests (vitest run) — expects 45 passing
npm run test:watch    # Watch mode
npm run typecheck     # tsc --noEmit
npm run lint          # eslint src/
npm run build         # Production build
npx prisma migrate deploy   # Run DB migrations
npx prisma db push          # Push schema to local DB (dev)
npx prisma generate         # Regenerate Prisma client
make deploy           # Production: git pull + docker compose up --build
```

## Project Structure

```
src/
  app/                  # Next.js App Router
    api/                # REST API routes
      projects/         # CRUD + plan/scaffold/create-repo endpoints
      github/           # GitHub token endpoint
      webhooks/         # GitHub webhook handler
    projects/           # UI pages (new, preview, confirm, success)
  lib/                  # Shared utilities
    types.ts            # TypeScript interfaces and API contracts
    prisma.ts           # Prisma singleton
    github-app.ts       # GitHub App auth + API helpers
    sse.ts              # Server-Sent Events broadcasting
    ops-mcp.ts          # ops-mcp state store client
  components/           # React components
  hooks/                # React hooks (e.g. useProjectEvents for SSE)
prisma/
  schema.prisma         # Database schema (Project, Task, AgentAction)
tests/
  integration/          # Critical path + error handling tests
  contract/             # API response shape + state machine tests
```

## Key Architecture Decisions

- **Modular monolith:** Single Next.js deployable, clear domain separation
- **No local git:** Repos created entirely via GitHub Git Data API (blobs/trees/commits)
- **Subprocess isolation:** planforge and scaffoldkit run as child processes with timeouts
- **SSE for real-time:** In-memory subscriber tracking, no polling
- **PostgreSQL:** Migrated from SQLite (see ADR 001)

## Database

Schema has 3 models: `Project`, `Task`, `AgentAction`. See `prisma/schema.prisma`.

Status flows:
- Project: PENDING -> PLANNING -> IMPLEMENTING -> REVIEWING -> DONE (or FAILED)
- Task: PENDING -> IN_PROGRESS -> IN_REVIEW -> APPROVED -> MERGED (or FAILED)

## External Dependencies

Two CLI tools must be available on the same machine:
- **agent-planforge** (Node.js) — default path: `~/git/agent-planforge`
- **scaffoldkit** (Python) — default path: `~/git/scaffoldkit`

## Environment

See `.env.example`. Key variables:
- `DATABASE_URL` — PostgreSQL connection string
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_APP_INSTALLATION_ID` — GitHub App
- `GITHUB_TOKEN`, `GITHUB_OWNER` — fallback for repo creation
- `NEXTAUTH_SECRET`, `NEXTAUTH_URL` — session management
- `PLANFORGE_PATH`, `SCAFFOLDKIT_PATH` — paths to external tools

## Conventions

- Path alias: `@/` maps to `./src/`
- API routes return `{ error: string }` on failure with appropriate HTTP status
- Agent-only endpoints require `x-agent-id` header (allowed IDs in `AGENT_IDS` env var)
- Tests are in `tests/` (not `__tests__`), organized by integration/ and contract/
- No legacy files remain in the repo (cleaned up April 2026)
