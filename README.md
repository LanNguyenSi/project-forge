# project-forge ⚒️

A web platform for creating AI-toolchain projects. Describe your project — [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) and [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit) do the rest.

**Live:** [project-forge.opentriologue.ai](https://project-forge.opentriologue.ai)

`project-forge` resolves generated planforge artifacts via `planforge-index.json` when available and falls back to legacy root paths for older planforge installations.

## What It Does

1. **Describe** — Fill in a form (or use the ✨ AI magic fill)
2. **Review** — Browse generated tasks, architecture overview, and file tree
3. **Confirm** — Create a GitHub repo with the scaffold pushed
4. **Build** — Clone and hand off to your agent

AI is optional. Without it, `project-forge` uses deterministic intake mapping plus `agent-planforge` heuristics. If a local or hosted AI provider is configured, `project-forge` also uses it server-side to enrich intake and review scaffold fit after `scaffoldkit` runs.

Also available as a REST API for agents — see the [API section](#api) below.

## Prerequisites

project-forge requires two external tools to be installed on the same machine as the server:

### 1. [agent-planforge](https://github.com/LanNguyenSi/agent-planforge)

```bash
git clone https://github.com/LanNguyenSi/agent-planforge.git
cd agent-planforge
npm install
```

Set env: `PLANFORGE_PATH=/path/to/agent-planforge`

### 2. [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit)

```bash
git clone https://github.com/LanNguyenSi/scaffoldkit.git
```

Set env: `SCAFFOLDKIT_PATH=/path/to/scaffoldkit`

> **Note:** Python 3 is installed automatically inside the Docker container. You only need the scaffoldkit source directory.

## Quick Start (Docker)

```bash
git clone https://github.com/LanNguyenSi/project-forge.git
cd project-forge
cp .env.example .env
# Fill in required values (see below)
make deploy
```

### Required Environment Variables

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | GitHub PAT with `repo` scope (for the platform itself) |
| `GITHUB_OWNER` | GitHub username for repo creation |
| `NEXTAUTH_SECRET` | Random secret (`openssl rand -hex 32`) |
| `NEXTAUTH_URL` | Public URL (e.g. `https://project-forge.example.com`) |
| `DATABASE_URL` | SQLite path (e.g. `file:/data/project-forge.db`) |
| `PLANFORGE_PATH` | Absolute path to agent-planforge repo |
| `SCAFFOLDKIT_PATH` | Absolute path to scaffoldkit source directory |

### Optional

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | Enables AI magic fill (OpenAI GPT-4o-mini) |
| `GROQ_API_KEY` | Enables AI magic fill (Groq, preferred — free) |
| `LOCAL_AI_BASE_URL` | Enables a local OpenAI-compatible model endpoint for AI magic fill and server-side intake enrichment |
| `LOCAL_AI_MODEL` | Model name for the local AI endpoint |
| `LOCAL_AI_API_KEY` | Optional API key for the local AI endpoint |
| `GITHUB_ID` | GitHub OAuth app Client ID |
| `GITHUB_SECRET` | GitHub OAuth app Client Secret |
| `FORGE_TEMP_DIR` | Directory for temporary build artifacts (defaults to OS temp dir) |
| `SCAFFOLDKIT_PYTHON` | Path to Python 3 binary used by scaffoldkit (defaults to `python3`) |

### Docker Compose Volumes

The Docker container needs read access to the tool directories:

```yaml
# docker-compose.override.yml
services:
  app:
    environment:
      PLANFORGE_PATH: /tools/agent-planforge
    volumes:
      - /path/to/agent-planforge:/tools/agent-planforge:ro
      - /path/to/scaffoldkit:/tools/scaffoldkit:ro
```

See `docker-compose.override.example.yml` for a full example.

## API

All endpoints require an API token generated in the dashboard, passed via the `X-API-Key` header.

Rate limit: 10 requests/day per API token.

### `GET /api/v1/projects`

List all projects for the authenticated user.

```bash
curl https://project-forge.opentriologue.ai/api/v1/projects \
  -H "X-API-Key: pf_your_token_here"
```

### `DELETE /api/v1/projects`

Delete a project by ID.

```bash
curl -X DELETE https://project-forge.opentriologue.ai/api/v1/projects \
  -H "X-API-Key: pf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{ "projectId": "clx..." }'
```

### `POST /api/v1/generate`

Generate a project scaffold without publishing it. Returns a preview ID for inspection.

```bash
curl -X POST https://project-forge.opentriologue.ai/api/v1/generate \
  -H "X-API-Key: pf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "projectName": "my-cli-tool",
    "summary": "A CLI that syncs agent memory via Git",
    "features": ["push memory files", "pull and merge", "conflict resolution"],
    "constraints": ["TypeScript only", "no external databases"],
    "targetUsers": ["developers", "AI agents"]
  }'
```

### `GET /api/v1/preview`

Fetch the generated preview (file tree, tasks, architecture) for a given preview ID.

```bash
curl "https://project-forge.opentriologue.ai/api/v1/preview?previewId=prev_abc123" \
  -H "X-API-Key: pf_your_token_here"
```

### `POST /api/v1/publish`

Finalize a previewed project and create the GitHub repository.

```bash
curl -X POST https://project-forge.opentriologue.ai/api/v1/publish \
  -H "X-API-Key: pf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{ "previewId": "prev_abc123" }'
```

**Response:**
```json
{
  "ok": true,
  "result": {
    "repoUrl": "https://github.com/your-username/my-cli-tool",
    "cloneUrl": "https://github.com/your-username/my-cli-tool.git",
    "projectName": "my-cli-tool"
  }
}
```

Full API documentation: [project-forge.opentriologue.ai/docs](https://project-forge.opentriologue.ai/docs)

## Tech Stack

- **Frontend:** Next.js 14 + TypeScript + Tailwind CSS
- **Auth:** next-auth (email/password + GitHub OAuth)
- **Database:** SQLite via Prisma (API tokens, users)
- **Planning:** [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) (Node.js)
- **Scaffolding:** [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit) (Python 3.11+)
- **AI:** Local OpenAI-compatible endpoint, Groq (llama-3.3-70b-versatile), or OpenAI (gpt-4o-mini)
- **Deploy:** Docker + Traefik

## Development

```bash
npm install
npm run dev
```

## License

MIT
