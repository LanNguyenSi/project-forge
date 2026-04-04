# AI Context: project-forge

> Read this file before making any changes to the codebase.
> It describes the project's structure, conventions, and rules for AI agents.

## Project Overview

**project-forge** is a full-stack web application for creating new software projects using the agent toolchain (agent-planforge, scaffoldkit). Users fill in a form, the server runs planforge and scaffoldkit in a temp directory, shows a preview of the generated structure (tasks, architecture, file tree), allows review and re-generation, then creates a GitHub repo and pushes on confirmation.

- **Language:** TypeScript (strict mode)
- **Framework:** Next.js 15 (App Router)
- **UI:** React 18, Tailwind CSS
- **Database:** SQLite via Prisma
- **Auth:** next-auth (GitHub OAuth + email/password, JWT sessions)
- **Testing:** Vitest + Testing Library
- **Deployment:** Docker (Node.js 20-slim + Python 3 for scaffoldkit)

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
│   │   ├── v1/projects/route.ts  # Public REST API (token-auth)
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
│   └── modals/                   # Confirmation & error dialogs
│
├── lib/                          # Core business logic
│   ├── types.ts                  # Shared TypeScript interfaces
│   ├── db.ts                     # Prisma client, rate limiting, API tokens
│   ├── auth.ts                   # NextAuth configuration
│   ├── ai-provider.ts            # AI provider abstraction (Local/Groq/OpenAI)
│   ├── planforge-orchestrator.ts # Intake mapping & AI enrichment
│   ├── planforge-runner.ts       # Shell invocation of agent-planforge
│   ├── planforge-output.ts       # Artifact parsing and path resolution
│   └── post-scaffold-review.ts   # Scaffold fit assessment
│
├── types/next-auth.d.ts          # NextAuth type extensions
├── tests/integration/            # Integration & unit tests
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
- Error responses follow the shape `{ error: string; details?: string }`

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

- **agent-planforge** (Node.js CLI): invoked via `child_process.spawn()` in `lib/planforge-runner.ts`
- **scaffoldkit** (Python CLI): invoked similarly, requires Python 3.11+
- Paths configured via `PLANFORGE_PATH` and `SCAFFOLDKIT_PATH` env vars

### Styling

- Tailwind CSS with dark-first design (bg-gray-950, text-gray-100, etc.)
- No light mode — the app is dark-only
- Swagger UI has custom dark-mode overrides in `globals.css`

### Testing

- Test runner: Vitest with happy-dom
- Tests in `tests/integration/`
- Run: `npm test` or `npm run test:watch`

## What NOT to Do

- Do not add dependencies without checking if an existing one covers the use case
- Do not expose internal error details (file paths, stderr) in API responses to clients
- Do not use `Math.random()` for security-sensitive values — use `crypto.randomBytes()`
- Do not hardcode filesystem paths — use environment variables
- Do not commit secrets, tokens, or `.env` files
- Do not introduce light-mode styles — the app is dark-only
- Do not skip TypeScript strict checks or use `any` without justification
