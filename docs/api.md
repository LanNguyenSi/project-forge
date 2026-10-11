# API Reference: project-forge

All `/api/v1` endpoints require an API token generated in the dashboard,
passed via the `X-API-Key` header. [Broker registration](#broker-registration)
takes a GitHub access token instead.

Rate limit: 10 publishes per user in any rolling 24-hour window, counted
across all of the user's tokens. Only `POST /api/v1/publish` and the one-shot
`POST /api/v1/projects` count; entries removed with `DELETE` still count.
`generate`, `preview`, and the project list and delete endpoints are
unmetered. Repositories published from the web UI are not counted and are not
returned by `GET /api/v1/projects`.

The [project-forge.opentriologue.ai/docs](https://project-forge.opentriologue.ai/docs)
Swagger UI documents the same six v1 operations interactively.

## GitHub publishing

Publishing (`POST /api/v1/publish`, the one-shot `POST /api/v1/projects`, and
the web UI) creates a public repository named after `projectName` under the
GitHub account of the user's stored GitHub credential and pushes the scaffold
to `main`. There is no option for a private repository.

The stored credential is the last one saved by one of these:

- GitHub sign-in: the OAuth token, requested with the scopes `repo`,
  `workflow`, and `user:email`.
- Settings: a classic personal access token (prefix `ghp_`). The Settings form
  rejects other token formats, including fine-grained tokens (`github_pat_`).
- [Broker registration](#broker-registration): the GitHub access token it was
  called with. It does not replace a stored personal access token.

A PAT needs the `repo` scope, and the `workflow` scope when the scaffold
contains GitHub Actions workflow files. Documents uploaded in the web UI are
written to `docs/context/` in the scaffold and are pushed with it.

## `GET /api/v1/projects`

List the projects the authenticated user published through the API
(`publish` or the one-shot create). Query parameters: `limit` (1-200, default
50), `offset` (default 0), and `includeDeleted=true` to include deleted
entries. Response:
`{ ok, projects: [{ id, repoUrl, projectName, createdAt }], total, limit, offset }`.

```bash
curl https://project-forge.opentriologue.ai/api/v1/projects \
  -H "X-API-Key: pf_your_token_here"
```

## `DELETE /api/v1/projects`

Mark a project entry as deleted by its `id` (the `id` field returned by
`GET /api/v1/projects`), passed as a query parameter. The entry disappears
from the list unless `includeDeleted=true`; the GitHub repository is not
touched. Returns 404 for an unknown id and 409 if the entry is already
deleted.

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
stored GitHub credential (see [GitHub publishing](#github-publishing)), and
counts against your publish quota.

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
in a single call, skipping the separate preview step. Requires a stored
GitHub credential (see [GitHub publishing](#github-publishing)), and counts
against your publish quota.
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

## Broker registration

`POST /api/auth/register-from-project-pilot` registers or signs in a user for
an identity broker such as project-pilot and returns a project-forge API
token. It takes no `X-API-Key`; the caller passes a GitHub access token, which
project-forge verifies against GitHub's `GET /user`.

Request body: `{ githubAccessToken, githubLogin? }`. Response:
`{ apiToken, userId, githubLogin }` (no `ok` field). Each call revokes the
caller's previous project-pilot token and returns a new one. The GitHub token
is stored as the user's publish credential, except when the stored credential
is already a personal access token (any value other than a `gho_` OAuth
token).

Errors use the shape `{ ok: false, error: <code>, message }`:

| Status | Cause |
|---|---|
| 400 | Invalid JSON, missing `githubAccessToken`, or a non-string `githubLogin` |
| 401 | GitHub token verification failed, or `githubLogin` differs from the verified login |
| 403 | The login is not in `ALLOWED_GITHUB_LOGINS` (when that variable is set) |
| 409 | An account with the same email already exists and has no linked GitHub id (an email/password account, or one created by GitHub sign-in on the web UI) |
| 503 | GitHub could not be reached |
| 500 | Unexpected error during verification |
