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
| `PLANFORGE_URL` | URL of the planforge HTTP service (set to `http://planforge:8223` by `docker-compose.yml`). Not in `.env.example`; for local development add it to `.env`, for example `http://localhost:8223`. |
| `PLANFORGE_SERVICE_TOKEN` | Shared bearer token for the planforge HTTP service. Generate with `openssl rand -hex 32`. Same value in both `app` and `planforge` containers. |

> Publishing a repo uses each **user's own** GitHub credential (the OAuth token
> from GitHub sign-in or a classic PAT saved in Settings, see
> [GitHub publishing](api.md#github-publishing)), not a platform-wide token.
> There is no server-level `GITHUB_TOKEN` or `GITHUB_OWNER` env var. For OAuth
> sign-in, set the optional `GITHUB_ID` / `GITHUB_SECRET` below.

With `docker-compose.yml`, `PLANFORGE_URL` and `FORGE_TEMP_DIR` are fixed in
the service's `environment:` block, which takes precedence over `.env`; change
them in `docker-compose.override.yml` (the `forge_tmp` volume is mounted at
`/tmp/project-forge`).

## Optional

AI provider: the first configured provider wins, in this order: local (needs
both `LOCAL_AI_BASE_URL` and `LOCAL_AI_MODEL`), Groq (`GROQ_API_KEY`), OpenAI
(`OPENAI_API_KEY`). A configured provider enables magic fill, AI intake
enrichment, and the AI part of the post-scaffold review; without one, intake
mapping and the scaffold review stay deterministic.

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | Enables the AI features with OpenAI (`gpt-4o-mini`); used when neither a local provider nor Groq is configured |
| `GROQ_API_KEY` | Enables the AI features with Groq; used when no local provider is configured |
| `GROQ_MODEL` | Groq model id (defaults to `openai/gpt-oss-120b`). Set it when Groq retires the default. Reasoning handling (low effort, extra token budget) applies only to `openai/gpt-oss-*`; other Groq reasoning models are not supported. |
| `LOCAL_AI_BASE_URL` | Base URL of a local OpenAI-compatible endpoint; takes effect only together with `LOCAL_AI_MODEL` |
| `LOCAL_AI_MODEL` | Model name for the local AI endpoint |
| `LOCAL_AI_API_KEY` | Optional API key for the local AI endpoint |
| `GITHUB_ID` | GitHub OAuth app Client ID. Set the OAuth app's authorization callback URL to `<NEXTAUTH_URL>/api/auth/callback/github`; sign-in requests the scopes `repo`, `workflow`, and `user:email`. |
| `GITHUB_SECRET` | GitHub OAuth app Client Secret |
| `ALLOWED_GITHUB_LOGINS` | Comma-separated allowlist of GitHub logins permitted to register via the project-pilot broker. Unset/empty = accept any. |
| `FORGE_TEMP_DIR` | Directory for temporary build artifacts (defaults to `/tmp/project-forge`) |
| `API_TOKEN_HASH_SECRET` | HMAC-SHA256 key for hashing API tokens (`pf_*`) at rest. Defaults to `NEXTAUTH_SECRET` when unset. Changing whichever key is in effect invalidates all previously issued API tokens (see `scripts/backfill-api-token-hashes.js`). |
