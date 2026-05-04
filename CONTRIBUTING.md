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
   npm run build
   npm test
   ```

4. For Prisma schema changes, generate a migration and check it in alongside the schema edit.
5. Open the PR with a clear summary, motivation, and test plan.

## Dev Setup

```bash
git clone https://github.com/LanNguyenSi/project-forge.git
cd project-forge
npm install
docker compose up -d   # Postgres
npx prisma migrate dev
npm run dev
```

## Style

Match the surrounding code. Prefer small, reviewable diffs.
