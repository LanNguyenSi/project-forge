# Configuration: project-forge

Environment variables read by the `app` container. Copy `.env.example` to
`.env` and fill in the required values before running `make deploy` or
`docker compose up`. For Docker deploys, also follow the
`docker-compose.override.yml` step in [deployment.md](deployment.md), which
sets the persistent `DATABASE_URL`.

## Required

| Variable | Description |
|---|---|
| `NEXTAUTH_SECRET` | Random secret (`openssl rand -hex 32`) |
| `NEXTAUTH_URL` | Public URL (e.g. `https://project-forge.example.com`) |
| `DATABASE_URL` | SQLite path (e.g. `file:/data/project-forge.db`) |
| `PLANFORGE_URL` | URL of the planforge HTTP service (defaults to `http://planforge:8223` in compose). |
| `PLANFORGE_SERVICE_TOKEN` | Shared bearer token for the planforge HTTP service. Generate with `openssl rand -hex 32`. Same value in both `app` and `planforge` containers. |

> Publishing a repo uses each **user's own** GitHub Personal Access Token (PAT),
> added in the dashboard, not a platform-wide token. There is no server-level
> `GITHUB_TOKEN` or `GITHUB_OWNER` env var. For OAuth sign-in, set the optional
> `GITHUB_ID` / `GITHUB_SECRET` below.

## Optional

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | Enables AI magic fill (OpenAI, `gpt-4o-mini`) |
| `GROQ_API_KEY` | Enables AI magic fill (Groq, preferred, free tier available) |
| `GROQ_MODEL` | Groq model id (defaults to `openai/gpt-oss-120b`). Set it when Groq retires the default. |
| `LOCAL_AI_BASE_URL` | Enables a local OpenAI-compatible model endpoint for AI magic fill and server-side intake enrichment |
| `LOCAL_AI_MODEL` | Model name for the local AI endpoint |
| `LOCAL_AI_API_KEY` | Optional API key for the local AI endpoint |
| `GITHUB_ID` | GitHub OAuth app Client ID |
| `GITHUB_SECRET` | GitHub OAuth app Client Secret |
| `ALLOWED_GITHUB_LOGINS` | Comma-separated allowlist of GitHub logins permitted to register via the project-pilot broker. Unset/empty = accept any. |
| `FORGE_TEMP_DIR` | Directory for temporary build artifacts (defaults to `/tmp/project-forge`) |
| `API_TOKEN_HASH_SECRET` | HMAC-SHA256 key for hashing API tokens (`pf_*`) at rest. Defaults to `NEXTAUTH_SECRET` when unset. Changing whichever key is in effect invalidates all previously issued API tokens (see `scripts/backfill-api-token-hashes.js`). |
