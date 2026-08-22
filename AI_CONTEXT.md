# AI Context: project-forge

> Read this file before making any changes to the codebase.
> It describes the project's structure, conventions, and rules for AI agents.

## Project Overview

**project-forge** is a full-stack web application for creating new software projects using the agent toolchain. Users fill in a form, the server POSTs to the agent-planforge HTTP service (which runs both planforge and scaffoldkit in-container and returns a tarball), extracts the result into a temp directory, shows a preview of the generated structure, allows review and re-generation, then creates a GitHub repo and pushes on confirmation.

- **Language:** TypeScript (strict mode)
- **Framework:** Next.js 15 (App Router)
- **UI:** React 18, Tailwind CSS
- **Database:** SQLite via Prisma
- **Auth:** next-auth (GitHub OAuth + email/password, JWT sessions)
- **Testing:** Vitest + Testing Library
- **Deployment:** Docker (Node.js 20-slim; no Python / scaffoldkit in the project-forge image — those live inside the planforge container per ADR-0002)

## Repository Structure

```
project-forge/
├── app/                          # Next.js App Router
│   ├── (dashboard)/              # Auth-protected pages
│   │   ├── create/page.tsx       # Project creation form
│   │   ├── dashboard/page.tsx    # User dashboard
│   │   ├── login/page.tsx        # Login page
│   │   └── settings/page.tsx     # User settings / API tokens
│   ├── api/                      # API routes
│   │   ├── v1/                   # Public REST API (X-API-Key auth)
│   │   │   ├── generate/route.ts # Plan + scaffold, returns a sessionId
│   │   │   ├── preview/route.ts  # Read a previously generated session
│   │   │   ├── publish/route.ts  # Create GitHub repo from a session
│   │   │   └── projects/route.ts # GET list / DELETE / POST one-shot create
│   │   ├── auth/                 # NextAuth + registration
│   │   ├── generate/route.ts     # Web UI generation (preview)
│   │   ├── publish/route.ts      # GitHub repo creation & push
│   │   ├── ai-assist/route.ts    # AI form enrichment
│   │   └── dashboard/            # User/token management
│   ├── docs/page.tsx             # Swagger UI API docs
│   ├── layout.tsx                # Root layout
│   └── globals.css               # Global styles + Swagger dark overrides
│
├── components/                   # React components
│   ├── ui/                       # Primitives (Button, Card, Input, etc.)
│   ├── layout/AppShell.tsx       # Navigation & sidebar
│   ├── ProjectForm.tsx           # Main project intake form
│   ├── PreviewPanel.tsx          # Generated scaffold preview
│   ├── ConfirmModal.tsx          # Confirmation dialog
│   ├── ErrorModal.tsx            # Error dialog
│   └── DialogShell.tsx           # Shared modal shell
│
├── lib/                          # Core business logic
│   ├── types.ts                  # Shared TypeScript interfaces
│   ├── db.ts                     # Prisma client, rate limiting, API tokens
│   ├── auth.ts                   # NextAuth configuration
│   ├── ai-provider.ts            # AI provider abstraction (Local/Groq/OpenAI)
│   ├── planforge-orchestrator.ts # Intake mapping & AI enrichment
│   ├── planforge-client.ts       # HTTP client for the planforge service (SSE + tarball extract)
│   ├── planforge-output.ts       # Artifact parsing and path resolution
│   ├── post-scaffold-review.ts   # Scaffold fit assessment
│   └── v1-shared.ts              # Public v1 session helpers (generate/preview/publish, 1h TTL)
│
├── types/next-auth.d.ts          # NextAuth type extensions
├── tests/                        # Integration (tests/integration/) & unit (tests/unit/) tests
├── prisma/schema.prisma          # Database schema
├── middleware.ts                  # Auth + API key validation
├── Dockerfile                    # Multi-stage build
├── docker-compose.yml            # Container orchestration
└── AI_CONTEXT.md                 # This file
```

## Key Conventions

### API Routes

- Public API lives under `app/api/v1/` and uses `X-API-Key` header auth
- Internal routes (used by the web UI) live under `app/api/` and use session auth
- All routes return `NextResponse.json()` with appropriate status codes
- Error responses follow the shape `{ ok: false, error: string, details?: string }` (per docs/ways-of-working.md:29)

### Components

- UI primitives in `components/ui/primitives/` — re-exported via `index.ts`
- Page-level layout uses `<AppShell>` (sidebar) + `<PageShell>` (title/subtitle)
- All pages are client components using `"use client"` where session or interactivity is needed

### Database

- Prisma schema in `prisma/schema.prisma`
- Client singleton in `lib/db.ts` (cached in `globalThis` for dev hot-reload)
- Run `npx prisma generate` after schema changes
- Run `npx prisma db push` to sync schema to SQLite

### External Tools

- **agent-planforge HTTP service**: `POST ${PLANFORGE_URL}/api/generate` with `Bearer ${PLANFORGE_SERVICE_TOKEN}`. The service runs both the planforge CLI and scaffoldkit in its own container and streams back an SSE `done` event with a base64 gzipped tarball that the client untars into the request tempdir. See `lib/planforge-client.ts`. scaffoldkit is NOT invoked from project-forge — it lives entirely inside the planforge container (ADR-0002).

### Styling

- Tailwind CSS with dark-first design (bg-gray-950, text-gray-100, etc.)
- No light mode — the app is dark-only
- Swagger UI has custom dark-mode overrides in `globals.css`

### Testing

- Test runner: Vitest with happy-dom
- Tests in `tests/integration/` and `tests/unit/`
- Run: `npm test` or `npm run test:watch`

## What NOT to Do

- Do not add dependencies without checking if an existing one covers the use case
- Do not expose internal error details (file paths, stderr) in API responses to clients
- Do not use `Math.random()` for security-sensitive values — use `crypto.randomBytes()`
- Do not hardcode filesystem paths — use environment variables
- Do not commit secrets, tokens, or `.env` files
- Do not introduce light-mode styles — the app is dark-only
- Do not skip TypeScript strict checks or use `any` without justification
