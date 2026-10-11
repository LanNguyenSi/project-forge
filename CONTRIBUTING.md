# Contributing to project-forge

Thanks for your interest. project-forge is a web UI for creating AI-toolchain projects with planforge + scaffoldkit. Live: [project-forge.opentriologue.ai](https://project-forge.opentriologue.ai).

## Issues

- Bug reports: include repro steps, expected vs. actual, the affected surface (Next.js UI, API route, scaffoldkit integration, planforge integration, Prisma).
- Feature requests: describe the use case before the proposed shape.

## Pull Requests

1. Fork, branch off `main` (e.g. `feat/<scope>`, `fix/<scope>`).
2. Keep changes scoped where possible.
3. Run the local checks:

   ```bash
   npm install
   npx prisma generate
   npm run typecheck
   npm run lint
   npm run build
   npm test
   ```

4. For Prisma schema changes, run `npx prisma db push` to sync the local SQLite database. This project uses `db push`, not migration files; there is no `prisma/migrations` directory to check in.
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/project-forge.git
cd project-forge
cp .env.example .env # set NEXTAUTH_SECRET, NEXTAUTH_URL, PLANFORGE_URL, PLANFORGE_SERVICE_TOKEN
npm install
npx prisma generate
npx prisma db push   # creates the local SQLite database
npm run dev
```

The database is local SQLite (file path from `DATABASE_URL` in `.env`); no separate database server is needed. Or run `make dev` to scaffold `.env`, install deps, generate the Prisma client, create the SQLite DB, and start the dev server in one step; it does not set `PLANFORGE_URL` or `PLANFORGE_SERVICE_TOKEN`. Generating a project needs a running agent-planforge service, see [Development and Contributing](README.md#development-and-contributing) in the README.

## Style

Match the surrounding code. Prefer small, reviewable diffs.
