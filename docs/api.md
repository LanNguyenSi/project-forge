# API Reference: project-forge

All `/api/v1` endpoints require a `pf_` API token, issued in the dashboard or
by [broker registration](#broker-registration), passed via the `X-API-Key`
header. Broker registration itself takes a GitHub access token instead.

Rate limit: 10 publishes per user in any rolling 24-hour window, counted
across all of the user's tokens. Only `POST /api/v1/publish` and the one-shot
`POST /api/v1/projects` count; entries removed with `DELETE` still count.
The slot is taken when the request starts, so parallel requests cannot
exceed the limit, and it is given back when the request fails (a `4xx` or
`5xx` answer): only a repository that was published counts.
`generate`, `preview`, and the project list and delete endpoints are
unmetered. Repositories published from the web UI are not counted and are not
returned by `GET /api/v1/projects`.

Request bodies are size-capped: 64 KiB for `publish` and broker
registration; 601,712 bytes for `generate` and the one-shot create (which
covers an attachment of up to 50,000 characters, one file, the same limits
the web UI enforces) and 361,712 bytes for the web UI's own AI-assist
endpoint. An oversized body answers `413`, also a chunked body
without a `Content-Length` header; `POST /api/generate`
and `POST /api/v1/generate` also answer `413` for attachments over the
per-file, total or count limit before anything is written.

The [project-forge.opentriologue.ai/docs](https://project-forge.opentriologue.ai/docs)
Swagger UI documents the same six v1 operations interactively.

## GitHub publishing

Publishing (`POST /api/v1/publish`, the one-shot `POST /api/v1/projects`, and
the web UI) creates a public repository named after `projectName` under the
GitHub account of the user's stored GitHub credential and pushes the scaffold
to `main`. There is no option for a private repository.

The stored credential is the last one saved by one of these:

- GitHub sign-in: the OAuth token, requested with the scopes `repo`,
  `workflow`, and `user:email`. The account is matched by the GitHub account id
  (stored as `githubId`), never by the email alone. The email counts only
  when GitHub lists it as verified for that account; otherwise the account
  gets the placeholder `github-<id>@noreply`. When GitHub reported no email,
  the verified primary address from the account's address list is used, or the
  placeholder if there is none. If GitHub cannot be asked (an error or
  timeout), the sign-in fails without writing anything and can be retried. A sign-in whose verified email
  belongs to an email/password account that has no linked GitHub id gets a
  separate account under the placeholder `github-<id>@noreply`, and the
  password account is not touched (no token, no revocation). Only an account
  linked to another GitHub id is refused, and writes no token. A sign-in that claims an older
  GitHub-only account (one that has no `githubId` and no password yet) also
  revokes that account's API tokens and signs out its sessions from before the
  claim, so those tokens have to be issued again.
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

`POST /api/auth/register-from-project-pilot` creates or updates a user for an
identity broker such as project-pilot and returns a project-forge API token. It takes no `X-API-Key`; the caller passes a GitHub access token, which
project-forge verifies against GitHub's `GET /user`.

Request body: `{ githubAccessToken, githubLogin? }`. Response:
`{ apiToken, userId, githubLogin }` (no `ok` field). Each call revokes the
caller's previous project-pilot token and returns a new one. The GitHub token
is stored as the user's publish credential, except when the stored credential
is already a personal access token (any value other than a `gho_` OAuth
token).

Email collisions: registration does not verify the email, so a password
account may hold an address its typist does not own. When the GitHub email
belongs to a password account that has no linked GitHub id, the call does not
fail and does not touch that account: the GitHub identity gets its own user
under the placeholder email `github-<id>@noreply`, which holds the GitHub token
and the returned API token, and later calls find that user by the GitHub id.
This is the same rule as the web GitHub sign-in. An account that already has
another GitHub id is not diverted. The 409 above remains only for a
password-less row without a GitHub id on the email, and for any row already on
the placeholder while a password account holds the email (see the table); the
web GitHub sign-in claims a password-less row once GitHub verifies the email.

Verified email: a user row is keyed only on an address GitHub lists as
verified for the account (`GET /user/emails`, which needs the `user:email`
scope; the web GitHub sign-in uses the same rule). A new row gets the public
profile email when GitHub lists it as verified, else the account's verified
primary address, else the placeholder `github-<id>@noreply`; the unverified
public address is never used to look up, claim or create a row. An existing
user keeps its email unless the public email is verified and no other row
holds it. When GitHub cannot be asked for the address list, the call answers
503 `upstream_unavailable` and writes nothing. A unique violation on create is
settled as follows: if the same GitHub id was created in between (a concurrent
web sign-in), the call continues on that user and returns its token; if
another GitHub identity holds the email, it answers 409
`account_exists_link_required`.

Errors use the shape `{ ok: false, error: <code>, message }`:

| Status | Cause |
|---|---|
| 400 | Invalid JSON, missing `githubAccessToken`, or a non-string `githubLogin` |
| 413 | Request body over the 64 KiB cap |
| 401 | GitHub token verification failed, or `githubLogin` differs from the verified login |
| 403 | The login is not in `ALLOWED_GITHUB_LOGINS` (when that variable is set) |
| 409 | A row that has no linked GitHub id and no password (one created by an older GitHub sign-in on the web UI; web sign-ins now record the id) holds the GitHub email, or a password account without a GitHub id holds the email and any row is already on the placeholder `github-<id>@noreply` (see below), or another GitHub identity holds the verified email. A password account holding the email alone no longer causes it |
| 503 | `upstream_unavailable`: GitHub could not be reached, or could not list the account's emails (nothing is written) |
| 500 | Unexpected error during verification |
