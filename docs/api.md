# API Reference: project-forge

All endpoints require an API token generated in the dashboard, passed via the
`X-API-Key` header.

Rate limit: 10 project publishes per user per day. Only `publish` and the
one-shot `POST /api/v1/projects` count against it; `generate`, `preview`, and
the project list/delete endpoints are unmetered. The quota is counted per
user, across all of that user's tokens.

The [project-forge.opentriologue.ai/docs](https://project-forge.opentriologue.ai/docs)
Swagger UI documents the same six v1 operations interactively.

## `GET /api/v1/projects`

List all projects for the authenticated user.

```bash
curl https://project-forge.opentriologue.ai/api/v1/projects \
  -H "X-API-Key: pf_your_token_here"
```

## `DELETE /api/v1/projects`

Soft-delete a project by its `id` (the `id` field returned by
`GET /api/v1/projects`), passed as a query parameter.

```bash
curl -X DELETE "https://project-forge.opentriologue.ai/api/v1/projects?id=clx..." \
  -H "X-API-Key: pf_your_token_here"
```

## `POST /api/v1/generate`

Generate a project scaffold without publishing it. Returns a `sessionId` (a
UUID) used by `preview` and `publish`. A session expires one hour after it is
generated.

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

**Response:**
```json
{
  "ok": true,
  "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "preview": { "...": "file tree, tasks, architecture overview" }
}
```

## `GET /api/v1/preview`

Fetch the generated preview (file tree, tasks, architecture) for a given
`sessionId` (the value returned by `generate`). Each task carries `dependsOn`
(ids of other tasks in the same response, sourced from the planforge plan)
when the plan declares dependencies.

```bash
curl "https://project-forge.opentriologue.ai/api/v1/preview?sessionId=f47ac10b-58cc-4372-a567-0e02b2c3d479" \
  -H "X-API-Key: pf_your_token_here"
```

## `POST /api/v1/publish`

Finalize a previewed project and create the GitHub repository. Requires a
GitHub PAT configured in your dashboard, and counts against your daily
publish quota.

```bash
curl -X POST https://project-forge.opentriologue.ai/api/v1/publish \
  -H "X-API-Key: pf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{ "sessionId": "f47ac10b-58cc-4372-a567-0e02b2c3d479" }'
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

## `POST /api/v1/projects`

One-shot create: generate, scaffold, create the GitHub repository, and push
in a single call, skipping the separate preview step. Requires a GitHub PAT
configured in your dashboard, and counts against your daily publish quota.
The request body is the same shape as `generate`.

```bash
curl -X POST https://project-forge.opentriologue.ai/api/v1/projects \
  -H "X-API-Key: pf_your_token_here" \
  -H "Content-Type: application/json" \
  -d '{
    "projectName": "my-cli-tool",
    "summary": "A CLI that syncs agent memory via Git",
    "features": ["push memory files", "pull and merge"]
  }'
```

Returns the same `{ ok, result: { repoUrl, cloneUrl, projectName } }` shape
as `publish`.
