# ADR-0002: Decouple from agent-planforge + scaffoldkit via a service boundary

## Status

Accepted (implemented; see `lib/planforge-client.ts` and the `planforge` service in `docker-compose.yml`)

## Context

`project-forge` currently depends on two external tools by filesystem shell-out:

- **agent-planforge** — Node CLI, invoked via `child_process.spawn("node", [${PLANFORGE_PATH}/scripts/bootstrap-plan.js, ...])` in [`lib/planforge-runner.ts`](../../lib/planforge-runner.ts).
- **scaffoldkit** — Python CLI (Typer), invoked via `child_process.spawn("${SCAFFOLDKIT_PYTHON}", ["-m", "scaffoldkit.cli", "from-planforge", ...])` in [`app/api/v1/generate/route.ts`](../../app/api/v1/generate/route.ts).

Both tools must be installed on the same machine as project-forge. `PLANFORGE_PATH` defaults to `/root/.openclaw/workspace/git/agent-planforge`; `SCAFFOLDKIT_PYTHON` defaults to `/tmp/sk-venv/bin/python3`. The [README](../../README.md) explicitly documents the co-location assumption.

### Problems

1. **Deployment friction.** The container image / VPS deploy has to bundle three repos (project-forge, agent-planforge, scaffoldkit) plus a Python venv, kept in lockstep. A change to any of the three can silently break the rollout.
2. **Language split.** project-forge is Next.js/TypeScript. agent-planforge is vanilla Node. scaffoldkit is Python 3.11. Their common deployment medium today is "a VM with Node + Python installed" — which means **an npm-package-style unification is architecturally impossible**: you cannot `npm install` scaffoldkit.
3. **No version contract.** There is no semver or shape contract between the three. A rename of a flag or JSON-schema field in planforge/scaffoldkit silently breaks project-forge on the next deploy.
4. **No remote use.** project-forge cannot run anywhere the other two aren't physically present. That rules out hosted-UI-over-remote-scaffolder topologies, scaling the UI independently from the heavy generators, or letting an agent call the planner directly.
5. **Blocks the attachments feature.** The active project-forge task [`a9b53bfc-927d-41a5-b60e-1103084b722f`](https://agent-tasks.opentriologue.ai/tasks/a9b53bfc-927d-41a5-b60e-1103084b722f) wants file uploads (arc42, diagrams) to flow into plan generation. Today those files would land in a temp dir on the project-forge VM with no clean handoff mechanism — the companion agent-planforge task is explicitly marked blocked on this architectural decision.

### Goal of this ADR

Pick a target architecture and migration shape. **No implementation in this document.** Implementation lands in follow-up tickets.

## Options evaluated

### Option 1 — npm packages (REJECTED)

Publish planforge as `@opentriologue/planforge`, scaffoldkit as … something. project-forge imports both as npm deps, no shell-out.

- ✅ Semver by construction, single process, zero orchestration surface.
- ❌ **Architecturally infeasible for scaffoldkit.** scaffoldkit is Python (Typer + Jinja2 + Pydantic) and has no plausible path to becoming a Node library. We would either have to rewrite scaffoldkit in TypeScript (huge effort, throws away Jinja template library) or keep the Python shell-out, which defeats the point of picking this option in the first place.
- ❌ Even if we got past the language split, the single-process model couples the UI to heavy generator CPU; an LLM-assisted intake pass in a future planforge version would stall the UI request thread.

**Eliminated.** Keep going.

**Effort if we ignored the Python problem:** ~1 week to publish planforge as npm and wire project-forge as import. Zero infrastructure work. Moot because of the scaffoldkit constraint above.

### Option 2 — Two independent HTTP services

Each tool becomes its own HTTP service. planforge exposes a Node HTTP server; scaffoldkit exposes a Python HTTP server (FastAPI or Flask). project-forge calls both in sequence over the network.

- ✅ Each tool deployed and versioned independently.
- ✅ Language choice stays with the tool — planforge in Node, scaffoldkit in Python.
- ✅ Agents can call either service directly.
- ❌ **Two new services to operate** — two containers, two health checks, two auth boundaries, two deploy pipelines. That's a lot for a project with one active UI.
- ❌ project-forge still carries the orchestration logic ("call planforge, take its output, feed it to scaffoldkit, handle partial failures"). The complexity moved from shell-out plumbing to HTTP-client plumbing; the number of moving parts went up.
- ❌ The orchestration contract (plan → scaffoldkit-input.json → scaffold) lives in project-forge's API route, which means project-forge needs to know both tools' shapes. That's the wrong level for version skew.

**Viable but excessive for v1.**

**Effort:** ~2 weeks. Hono server + auth for planforge (~3d), FastAPI wrapper for scaffoldkit (~3d), project-forge HTTP client + orchestration (~2d), new deploy slot + Traefik labels for two services (~1d), extra ops dashboard wiring (~1d).

### Option 3 — Inversion: planforge orchestrates scaffoldkit

project-forge only depends on planforge. planforge calls scaffoldkit internally (still by shell-out, since Python). project-forge becomes a pure UI / auth / GitHub-push layer against planforge's API.

- ✅ Collapses two dependencies to one from the UI's perspective.
- ✅ The orchestration contract (plan → scaffold) lives in planforge, the tool that owns plan semantics. Correct level.
- ✅ Scaffoldkit becomes an implementation detail of planforge — project-forge doesn't need to know it exists.
- ❌ Shell-out doesn't go away, it just moves one hop upstream. planforge now needs Python + the scaffoldkit venv in its container.
- ❌ planforge becomes a bigger responsibility surface than today.

**Correct direction. Needs a service wrapper.**

**Effort:** ~1 week if done as "planforge calls scaffoldkit via shell-out internally, project-forge still shell-outs to planforge." But that's a half-step that still leaves project-forge co-located with planforge and the Python venv — doesn't actually ship the decoupling. Not worth doing without the HTTP wrapper, which is Option 4.

### Option 4 — Hybrid (RECOMMENDED)

**planforge becomes a Node HTTP service. It wraps scaffoldkit internally (shell-out in v1; promotable to HTTP in v2 without touching project-forge). project-forge talks to planforge's HTTP API only.**

Topology:

```
┌──────────────┐   HTTP    ┌────────────────────┐
│ project-forge│ ────────▶ │   planforge-svc    │
│  (Next.js)   │           │   (Node + HTTP)    │
└──────────────┘           │                    │
                           │  ┌──────────────┐  │
                           │  │ scaffoldkit  │  │ ◀── shell-out (v1),
                           │  │   (Python)   │  │     HTTP (v2 optional)
                           │  └──────────────┘  │
                           └────────────────────┘
```

- ✅ project-forge's container drops Python entirely, drops the scaffoldkit venv, drops `PLANFORGE_PATH` / `SCAFFOLDKIT_PYTHON` env vars. **Its container gets smaller and simpler.**
- ✅ One service contract to version: planforge's HTTP schema. Changes are visible and reviewable.
- ✅ The attachments feature [`a9b53bfc-927d-41a5-b60e-1103084b722f`](https://agent-tasks.opentriologue.ai/tasks/a9b53bfc-927d-41a5-b60e-1103084b722f) becomes straightforward: project-forge `POST /generate` can accept multipart and forward to planforge; planforge owns storage decisions.
- ✅ Agents can call planforge's HTTP surface directly (e.g. from a CI job) — which is what the MCP-outbound roadmap wants.
- ❌ planforge grows from "a CLI" to "a CLI + HTTP daemon". Operationally heavier than today.
- ❌ The scaffoldkit shell-out still exists; it's just hidden. If scaffoldkit's Python runtime breaks, planforge breaks. Not a new failure mode (it exists today), but it moves addresses.

**This is the minimum change that actually decouples project-forge.** Options 2 and 3 in isolation each leave one half of the problem (too many services / still co-located Python) on the table.

**Effort:** ~5–7 days total.
- ~3d: planforge Hono HTTP server + SSE streaming + service-token auth + `/healthz` + Dockerfile with Python stage for scaffoldkit venv
- ~1d: project-forge `lib/planforge-client.ts` replacing the two shell-outs in `app/api/v1/generate/route.ts`
- ~1d: deploy-panel / VPS compose slot for planforge, Traefik label, service-token distribution
- ~1d: parallel-path flag (`PLANFORGE_MODE=shell|http`) for one deploy cycle, integration smoke, rollout
- ~1d buffer for integration issues (SSE reconnect, subprocess backpressure, etc.)

## Maintainer cross-check

**This ADR assumes agent-planforge accepts the "I also orchestrate scaffoldkit" responsibility.** Today planforge only reads scaffoldkit's blueprint metadata ([`bootstrap-plan.js:1578-1670`](file:///home/lan/git/pandora/agent-planforge/scripts/bootstrap-plan.js)) — it does not invoke the generator. The decision moves the scaffoldkit subprocess call from project-forge into planforge.

If the agent-planforge maintainer rejects that expanded scope — e.g. on grounds of "planforge is a pure planner; execution belongs elsewhere" — **fall back to Option 2** (two independent HTTP services, project-forge orchestrates). Option 4 is strictly preferred only if planforge accepts the runner role. Get this buy-in before filing the implementation tickets.

## Decision

**Go with Option 4 (hybrid).** Specifically:

1. **planforge exposes an HTTP API.** Scope for v1: one endpoint — `POST /generate { input, options }` returning a streaming/SSE response that interleaves plan-generation progress and scaffold output (so project-forge can show a progress UI). A second endpoint `GET /healthz` for Docker/Traefik.
2. **planforge keeps its CLI.** `scripts/bootstrap-plan.js` stays as-is for anyone driving it directly. The HTTP handler is a thin wrapper that calls the same library code the CLI calls — no behaviour drift.
3. **planforge wraps scaffoldkit via `child_process.spawn`** (same pattern project-forge uses today, just relocated). scaffoldkit's Python venv moves into planforge's container.
4. **Auth: shared service token** via a single `PLANFORGE_SERVICE_TOKEN` env var read by both project-forge and planforge (Bearer header). Simpler than NextAuth-pass-through. The trust boundary today is "same VM"; after decoupling it's "same VPC" which a shared secret fits. Rotation in v2 via a token-store if needed.
5. **Hosting:** one additional container on the existing VPS, behind the existing Traefik. Label: `Host(`planforge.opentriologue.ai`)`. Not exposed publicly — bound to the internal Traefik entrypoint + IP-whitelisted to project-forge's container.
6. **MCP facade:** Not in v1. Wait until an agent actually needs to call planforge programmatically outside of project-forge. When that lands, a small stdio MCP package (mirroring the ops-mcp pattern at [`/packages/mcp/src/server.ts`](file:///home/lan/git/pandora/ops-mcp/packages/mcp/src/server.ts)) can wrap the HTTP client. Keeping HTTP-only for v1 avoids building a dual facade before we know the MCP shape.
7. **scaffoldkit does not grow an HTTP surface in v1.** It stays a CLI and a pure library. Promoting it to its own HTTP service later is a non-breaking change (planforge's internals swap shell-out for HTTP; project-forge sees nothing).

## Consequences

### Positive

- project-forge's container loses Python, the scaffoldkit venv, and both path env vars. Image shrinks, Dockerfile simplifies, cold-start gets faster.
- The generate flow becomes one HTTP call (`POST planforge/generate`) instead of two shell-outs with intermediate filesystem artifacts. Failure modes become fewer and more uniform.
- planforge can be deployed and rolled back independently. A planforge bug no longer forces a project-forge rebuild.
- The attachments feature unblocks: planforge owns the upload storage decision. project-forge forwards multipart and stops caring where the bytes live.
- Remote deploys become possible: you can run project-forge on Vercel and planforge on a beefier VPS, or have multiple project-forge instances share a single planforge.

### Negative

- One more container to deploy, monitor, and secure.
- One more thing to add a health check for on the ops dashboard.
- Shared secret rotation becomes a manual ritual until a token-store is added.
- Response streaming over HTTP is more complicated than reading subprocess stdout. SSE keeps the UX, but introduces a class of edge cases (reconnect, mid-stream errors) that shell-out didn't have.

### Risks

- **Scope creep.** The temptation to also refactor scaffoldkit or rewrite planforge at the same time must be resisted. v1 moves the boundary; nothing else changes.
- **Token leak.** A shared secret in env is a fine bootstrap but a bad long-term answer. The follow-up ticket for token-store has to happen before we expose planforge outside the internal network.
- **Performance.** Node subprocess spawn is roughly 20–50 ms; same-host HTTP adds ~1–5 ms once warm plus JSON parse, so the per-call overhead is a wash at worst. If planforge ever moves off the same VPS, latency stops being comparable — benchmark before a remote-hosting decision.
- **Streaming.** project-forge's UI today reads subprocess stdout and renders progress. The HTTP port needs equivalent streaming. **SSE is chosen over WebSocket** because `generate` is uni-directional server→client progress, no client→server messages mid-stream — WS's full-duplex is overhead with more edge cases (reconnect choreography, mid-stream frame errors). Reuse the existing subprocess-stdout → progress-event mapping so the rendering code in the UI doesn't change.
- **Crash mid-generate / retry semantics.** Today the shell-out is effectively atomic from the client's view: subprocess failure ⇒ re-POST. Once the boundary is HTTP + SSE, a mid-stream crash can leave the client with a partial event log and a half-written tempdir on the server. **Decision for v1:** planforge treats every `POST /generate` as a fresh run (no resumption), uses a unique tempdir per request, and cleans up on both success and every failure path. Clients retry by re-POSTing — exactly the current semantics — but the server must guarantee no orphan tempdirs.
- **Multi-tenancy / concurrent generations.** Today's shell-out scopes the work dir per caller session. A shared planforge service must isolate concurrent runs: each request gets a unique tempdir keyed by request-id, and the service-token scope must bind the request back to a single caller identity so two users can't observe each other's output. No cross-request state.
- **Secret handling.** `scaffoldkit-input.json` can carry user-specified values (including ones the user later wants to treat as secrets). The HTTP boundary must not log request bodies. Add an explicit rule in planforge's logging config: request bodies and response bodies are never logged; only request IDs, durations, and status codes. The service token itself goes into a redacted header in logs.
- **Rollback flag realism.** The `PLANFORGE_MODE=shell|http` dual-path idea sounds safe but doubles the surface: both paths need tests, both can drift, and the shell path forces project-forge to keep carrying the Python venv during the sunset. **Decision:** keep the flag only during the deploy-window smoke (≤1 week), test both paths end-to-end in CI during that window, then delete the shell branch. If any bug surfaces after rollout, revert via compose tag instead of the env flag — simpler contract.

## Migration sketch

1. **In `agent-planforge`:** add a thin HTTP server (Hono, since it's already the org's default; matches agent-tasks and agent-relay). Expose `POST /generate` and `GET /healthz`. The handler for `/generate` imports the same library the CLI uses. No feature change — the CLI is still the definition of behaviour.
2. **Package scaffoldkit venv into planforge's container.** Dockerfile gets a Python stage that installs scaffoldkit into `/opt/sk-venv`, copied into the final Node image. **CI release pipeline** gains a Python install step — planforge's current npm-only CI matrix is unchanged; the Python dependency only appears in the Docker image build job.
3. **In `project-forge`:** introduce a `lib/planforge-client.ts` that calls `POST ${PLANFORGE_URL}/generate`. Replace the two shell-outs in `app/api/v1/generate/route.ts` with one HTTP call. Delete `lib/planforge-runner.ts` once the HTTP path is proven.
4. **Dockerfile:** drop the Python venv, `PLANFORGE_PATH`, `SCAFFOLDKIT_PYTHON` from the project-forge image.
5. **Deploy:** add a `planforge` service to the VPS docker-compose with Traefik labels. Generate a `PLANFORGE_SERVICE_TOKEN`, drop it into both containers' env.
6. **Sunset period:** keep the shell-out path available behind a `PLANFORGE_MODE=shell|http` flag for one deploy cycle so a panic rollback is a flag flip instead of a code revert.

## Open questions (resolved)

- **REST, MCP, or both from day one?** REST only in v1. MCP later if a real consumer appears.
- **Auth model?** Shared service token in env. Migration to a token-store is a follow-up, pre-public-exposure.
- **Hosting?** Same VPS as today, separate container. Traefik-fronted on an internal hostname.
- **Does scaffoldkit need to remain directly callable from project-forge?** No. Full inversion is safe — scaffoldkit is a stateless renderer with no project-forge-specific concerns.

## Follow-up tickets

**These will be filed in agent-tasks immediately after this ADR merges** — they are tracked as the next action on spike `fb21d97e`, not left in limbo:

1. **agent-planforge: HTTP service surface (`POST /generate`, `GET /healthz`, service-token auth)** — HIGH
2. **agent-planforge: package scaffoldkit venv into the container image** — MEDIUM (blocks #1 deploy)
3. **project-forge: `lib/planforge-client.ts` + replace shell-out in `app/api/v1/generate/route.ts`** — HIGH (blocked by #1)
4. **deploy-panel: add planforge service to the VPS compose; generate + distribute `PLANFORGE_SERVICE_TOKEN`** — MEDIUM (blocked by #1)
5. **project-forge: drop Python / scaffoldkit venv from Dockerfile; remove `PLANFORGE_PATH` + `SCAFFOLDKIT_PYTHON` env vars** — LOW (cleanup, after #3)
6. **project-forge: update the attachments spike (`a9b53bfc-927d-41a5-b60e-1103084b722f`) to assume the new boundary**
7. **agent-planforge: update the ingest-pipeline task (`dc069556-077d-4b9c-926d-278a438adb8c`) to assume the new boundary and unblock**
8. **(optional, v2) agent-planforge: `packages/mcp` stdio facade that wraps the HTTP client — mirror the ops-mcp shape**
9. **(optional, v2) planforge: token-store + rotation instead of a single shared secret**

## References

- Current shell-out call sites: [`project-forge/lib/planforge-runner.ts`](../../lib/planforge-runner.ts), [`project-forge/app/api/v1/generate/route.ts`](../../app/api/v1/generate/route.ts).
- Parent task (attachments feature, blocked by this ADR): agent-tasks `a9b53bfc-927d-41a5-b60e-1103084b722f`.
- Companion task (planforge ingest, blocked by this ADR): agent-tasks `dc069556-077d-4b9c-926d-278a438adb8c`.
- This spike: agent-tasks `fb21d97e-2a49-43d8-afbf-9782c31de66d`.
- Pattern reference for stdio MCP facade over a REST service: [`ops-mcp/packages/mcp/src/server.ts`](file:///home/lan/git/pandora/ops-mcp/packages/mcp/src/server.ts). Note: ops-mcp is MCP-only (calls a remote REST gateway); there is no existing REST+MCP dual-facade pattern in the codebase today.
- ADR-0001 (language choice) is unrelated but is the only prior ADR in this repo; follow its Markdown-only, `## Status / ## Context / ## Decision / ## Consequences` format.
