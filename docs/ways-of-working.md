# Ways of Working: project-forge

project-forge is a Next.js 15 web application plus a token-authenticated REST
API. These conventions are written for that surface (routes, React components,
Prisma) and not for a command-line tool.

## Definition of Done

A feature or bug fix is done when:

- [ ] Typecheck passes (`npm run typecheck` / `npx tsc --noEmit`)
- [ ] Lint passes with no new warnings (`npm run lint`)
- [ ] The app builds (`npm run build`)
- [ ] Tests are written and passing (`npm test`, Vitest)
- [ ] API responses keep the documented shape (`{ ok, error, details? }` for
      errors); breaking shape changes are called out
- [ ] No secrets (PATs, tokens, file paths, stderr) leak into responses or logs
- [ ] Docs are updated if a public interface changed (README API section,
      `public/openapi.json`, `docs/architecture.md`, `AI_CONTEXT.md`)
- [ ] Change has been reviewed by at least one other contributor

## API Conventions

These rules govern the HTTP surface. All contributors must follow them.

### Responses and status codes

- Always return `NextResponse.json()` with an explicit status code.
- Success: `{ ok: true, ... }`. Failure: `{ ok: false, error: string, details?: string }`.
- Use the right status: `400` invalid input, `401` missing/invalid auth, `404`
  not found / expired session, `409` conflict (already published / deleted),
  `429` rate limit, `500` unexpected.

### Authentication

- Public API (`app/api/v1/*`) authenticates with the `X-API-Key` header carrying
  a dashboard-issued `pf_*` token; validate via `validateApiToken`.
- Web UI routes use NextAuth session auth.

### Never leak secrets

- Do not put file paths, raw stderr, or GitHub PATs in responses or logs.
- Sanitize PAT-shaped strings before logging (see `app/api/v1/publish/route.ts`).

### Rate limiting

- The publish path and `POST /api/v1/projects` consume the per-user daily quota
  (`checkRateLimit`); `generate`, `preview`, and list/delete do not. Keep that
  split intact when adding endpoints.

## Components and Styling

- Page-level layout uses `<AppShell>` (sidebar) and `<PageShell>` (title /
  subtitle).
- Pages that need session or interactivity are client components (`"use client"`).
- Tailwind, dark-first (`bg-gray-950`, `text-gray-100`, ...). No light mode.

## Database

- Prisma over SQLite (`prisma/schema.prisma`, `provider = "sqlite"`).
- After a schema change: `npx prisma generate`, then `npx prisma db push` to
  sync the local SQLite database. This project uses `db push`, not migration
  files; there is no `prisma/migrations` directory.

## Versioning

This project follows [Semantic Versioning](https://semver.org/) for the app and
its REST API:

- **MAJOR**: breaking change to the API (removed/renamed endpoint or field,
  changed auth, changed response shape in a removing way)
- **MINOR**: new endpoint, new optional field, new optional env var (backward
  compatible)
- **PATCH**: bug fix, documentation fix, internal refactor with no interface
  change

### What Counts as a Breaking Change

- Removing or renaming an endpoint, request field, or response field
- Changing the meaning of a status code
- Making a previously optional request field required

### What Does NOT Count as a Breaking Change

- Adding a new endpoint or optional request field
- Adding new fields to a response
- Improving error messages

## Release Process

1. Bump `version` in `package.json`
2. Update `CHANGELOG.md`
3. Commit: `chore(release): vX.Y.Z`
4. Tag and push the tag; CI runs the build/test pipeline

## Branching Strategy

Trunk-based development with short-lived feature branches.

### Branch Naming

```
feat/<short-description>
fix/<short-description>
chore/<description>
docs/<description>
```

### Workflow

1. Branch from `main`
2. Make small, focused commits
3. Open a Pull Request (draft if in progress)
4. Pass CI checks (typecheck, lint, build, tests)
5. Get at least one review approval
6. Squash-merge into `main`
7. Delete the branch

## Pull Request Conventions

### PR Title

Use conventional commit format:

```
feat(api): add POST /api/v1/projects one-shot create
fix(publish): sanitize PAT before logging
docs(architecture): document the planforge boundary
chore(deps): bump next to latest patch
```

### PR Description

Include:

- **What**: what changed
- **Why**: motivation or ticket reference
- **Testing**: how you verified it (test names, manual steps)
- **API impact**: any change to endpoints, request/response shape, or env vars

## Testing Expectations

Runner: **Vitest** with `happy-dom`.

- Integration and unit tests live under `tests/` (`tests/integration/`,
  `tests/unit/`).
- Tests exercise route handlers and `lib/` modules directly; mock the network
  (the planforge service, GitHub API) rather than calling out.
- Tests must not depend on ambient environment variables unless they set them
  explicitly.
- Cover both the success path and the auth/validation/error paths for new
  endpoints.

## Architecture Decision Records (ADRs)

Write an ADR in `docs/adrs/` when:

- Choosing a library or external dependency
- Changing the shape of the public API or the planforge boundary
- Establishing a new pattern not covered by existing docs

### ADR Format

```markdown
# ADR-NNNN: Title

## Status
Proposed | Accepted | Deprecated | Superseded by ADR-XXXX

## Context
What is the situation? What constraints or requirements exist?

## Decision
What did we decide to do?

## Consequences
What are the trade-offs? What becomes easier or harder?
```

## Documentation Expectations

- **README**: always reflects actual setup, env vars, and the API surface
- **`public/openapi.json`**: updated whenever an endpoint or its shape changes
- **`docs/architecture.md`**: updated when subsystem structure or data flow changes
- **ADRs**: written before merging significant decisions, not after
- **AI_CONTEXT.md**: updated when adding new patterns

## AI Collaboration Guidelines

This project is configured for AI-assisted development. Read `AI_CONTEXT.md`
before working on the codebase.

### For AI Agents

- Read `AI_CONTEXT.md` before starting any task
- Follow the route-handler and `lib/` module patterns already in the repo
- Do not leak secrets in responses or logs
- Do not introduce light-mode styles (the app is dark-only)
- Do not add dependencies without checking for an existing one; record
  significant choices in an ADR

### For Developers Working with AI

- Point the agent to the specific route handler / `lib` module and test file
- Provide the expected request/response shape as part of the specification
- Review auth, status codes, and secret handling carefully
- Run `npm run typecheck`, `npm run lint`, `npm run build`, and `npm test` after
  AI-generated changes

## Communication

- Prefer async: comments on PRs and issues over meetings
- Document decisions in ADRs, not chat logs
- Changelog entries are written from the user's perspective, not the developer's
