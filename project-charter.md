# Project Charter: project-forge

## Summary

A web UI for creating new software projects using the full agent toolchain (agent-planforge, scaffoldkit, agent-engineering-playbook). Users fill in a form, the server runs planforge and scaffoldkit in a temp directory, shows a preview of the generated structure (tasks, architecture, file tree), allows review and re-generation, then creates a GitHub repo and pushes on confirmation.

## Target Users

- developers using AI agent workflows
- Lan and the Ice/Lava team

## Core Features

- project creation form (name, summary, features, constraints)
- server-side planforge execution in temp directory
- server-side scaffoldkit from-planforge execution
- preview UI showing generated tasks, architecture overview, and file tree
- re-generation without leaving the page (adjust input and re-run)
- user confirmation step before any GitHub action
- automatic GitHub repository creation via API
- initial commit and push of scaffolded project
- temp directory cleanup after push
- success screen with git clone command

## Constraints

- Next.js frontend, same stack as agent-ops-dashboard
- TypeScript throughout
- Tailwind CSS for styling
- server-side Node.js subprocess for planforge (already on server)
- server-side Python 3.11 subprocess for scaffoldkit (installed via venv)
- GitHub token from environment variable
- no database required — stateless server with temp directories
- temp directories cleaned up after push or on failure

## Non-Functional Requirements

- temp directory isolation per request (UUID-named)
- generation should complete in under 30 seconds
- clear error messages if planforge or scaffoldkit fail
- preview must show actual generated file content on demand

## Delivery Context

- Planner profile: product
- Intake completeness: complete
- Phase: phase_1
- Path: core
- Data sensitivity: low

## Applicable Playbooks

- /root/.openclaw/workspace/git/agent-planforge/playbooks/planning-and-scoping.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/01-project-setup.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/02-architecture.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/03-team-roles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/04-design-principles.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/05-development-workflow.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/06-testing-strategy.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/07-quality-assurance.md
- /root/.openclaw/workspace/git/agent-engineering-playbook/playbooks/08-documentation.md

## Missing Information

- None

## Follow-Up Questions

- None

## Open Questions

- None
