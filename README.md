# project-forge ⚒️

A web platform for creating AI-toolchain projects. Describe your project — [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) and [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit) do the rest.

**Live:** [project-forge.opentriologue.ai](https://project-forge.opentriologue.ai)

## What It Does

1. **Describe** — Fill in a form (or use the ✨ AI magic fill)
2. **Review** — Browse generated tasks, architecture overview, and file tree
3. **Confirm** — Create a GitHub repo with the scaffold pushed
4. **Build** — Clone and hand off to your agent

Also available as a REST API for agents: `POST /api/v1/projects`

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
| `GITHUB_ID` | GitHub OAuth app Client ID |
| `GITHUB_SECRET` | GitHub OAuth app Client Secret |

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

### `POST /api/v1/projects`

Create a project programmatically. Requires an API token generated in the dashboard.

```bash
curl -X POST https://project-forge.opentriologue.ai/api/v1/projects \
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

Rate limit: 10 projects/day per API token.

Full API documentation: [project-forge.opentriologue.ai/docs](https://project-forge.opentriologue.ai/docs)

## Tech Stack

- **Frontend:** Next.js 14 + TypeScript + Tailwind CSS
- **Auth:** next-auth (email/password + GitHub OAuth)
- **Database:** SQLite via Prisma (API tokens, users)
- **Planning:** [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) (Node.js)
- **Scaffolding:** [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit) (Python 3.11+)
- **AI Fill:** Groq (llama-3.3-70b) / OpenAI (gpt-4o-mini)
- **Deploy:** Docker + Traefik

## Development

```bash
npm install
npm run dev
```

## License

MIT
