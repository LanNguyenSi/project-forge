# project-forge ⚒️

**From project idea to GitHub repository — fully automated.**

project-forge is a web platform that scaffolds a complete, ready-to-clone repository from a plain-text project description. You describe what you want to build — [agent-planforge](https://github.com/LanNguyenSi/agent-planforge) creates a structured plan, [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit) generates the file structure, and project-forge pushes everything directly to GitHub.

**Live:** [project-forge.opentriologue.ai](https://project-forge.opentriologue.ai)

---

## What's New (March 2026)

The current version was rebuilt from scratch. The previous version could render forms — but could not execute anything. What is now in place:

| Feature | Description |
|---------|-------------|
| **Planforge integration** | Server invokes agent-planforge, parses the generated plan, and stores tasks in the database |
| **Scaffoldkit pipeline** | Generates a complete file structure from the plan and exposes it as a preview |
| **GitHub repo creation** | Create repo + initial commit directly via the GitHub Git Data API — no local git required |
| **Preview UI** | 3 tabs: Tasks / Architecture / Files (split-view with file contents) |
| **Re-generation** | Inline panel to override summary, features, and constraints and re-run the scaffold |
| **Confirmation gate** | Clear "what will happen" screen with a checkbox before any GitHub action |
| **PostgreSQL backend** | New schema: Project, Task, AgentAction — replaces the previous SQLite setup (see [ADR 001](adrs/001-sqlite-to-postgresql.md)) |

---

## The Workflow

```
1. Describe your project
   Enter name, summary, features, constraints, and stack

2. Generate a plan
   agent-planforge produces a step-by-step plan
   → Tasks are stored as records in the database

3. Generate the scaffold
   scaffoldkit generates the file structure in a temp directory
   → File tree and file contents are loaded as a preview

4. Review the preview
   Tab "Tasks":        all generated tasks with status and wave
   Tab "Architecture": architecture description from the plan
   Tab "Files":        file tree on the left, file contents on the right

5. Optional: Re-generate
   "Adjust & Re-generate" opens an override panel
   Empty fields fall back to the project defaults

6. Confirm
   Clear overview of what will happen on GitHub
   Editable repo name (auto-sanitized)
   Checkbox gate: "I understand this cannot be undone"

7. Create the repository
   GitHub repo is created via the GitHub App
   Initial commit is pushed via the Git Data API
   Temp directory is cleaned up
   Success screen: repo link, commit SHA, file count
```

---

## Prerequisites

project-forge requires two external tools on the same server:

### 1. [agent-planforge](https://github.com/LanNguyenSi/agent-planforge)

```bash
git clone https://github.com/LanNguyenSi/agent-planforge.git ~/git/agent-planforge
cd ~/git/agent-planforge
npm install
```

Default path: `~/git/agent-planforge`

### 2. [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit)

```bash
npm install -g scaffoldkit
```

### 3. GitHub App

project-forge uses a GitHub App for repository creation. Configure in `.env`:

```
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY_PATH=...
GITHUB_APP_INSTALLATION_ID=...
```

---

## Quick Start

```bash
git clone https://github.com/LanNguyenSi/project-forge.git
cd project-forge
cp .env.example .env
# Fill in GitHub App credentials, Anthropic API key, and DATABASE_URL

docker compose up -d postgres
npx prisma migrate deploy
npm run dev
```

---

## Tests

```bash
npm test
# Expected: 45 passed (45), ~2s
```

---

## Tech Stack

- **Framework:** Next.js 16 + TypeScript + Tailwind CSS
- **Database:** PostgreSQL 16 via Prisma ORM
- **Planning:** [agent-planforge](https://github.com/LanNguyenSi/agent-planforge)
- **Scaffolding:** [scaffoldkit](https://github.com/LanNguyenSi/scaffoldkit)
- **GitHub:** GitHub App + Git Data API (no local git)
- **AI:** Anthropic Claude (via planforge)

---

## Known Limitations

- Blob creation uses `Promise.all` — may hit GitHub rate limits on large projects
- Repos are always created as public
- Folder icons in the file tree preview are not yet distinct from file icons
- Tasks are generated but not yet automatically assigned to agents

---

## Architecture Decisions

- [ADR 001: Migrate from SQLite to PostgreSQL](adrs/001-sqlite-to-postgresql.md)

---

## License

MIT
