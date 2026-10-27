## Summary

<!-- One or two sentences. What changed? -->

## Motivation

<!-- Why this change? Link the issue if applicable. -->

## Test plan

- [ ] `npx prisma generate`
- [ ] `npm run typecheck`
- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] `npm test`
- [ ] For Prisma schema changes: a migration created with `npx prisma migrate dev --name <change>` is committed under `prisma/migrations/` (`npm run db:check-migrations` passes); any data change that needs a manual deploy step is described (see docs/deployment.md, Database migrations)
- [ ] Manual smoke check: <!-- command or scenario -->

## Notes for reviewer

<!-- Anything non-obvious: tradeoffs, follow-ups, open questions. -->
