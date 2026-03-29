import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'
import fs from 'fs'
import path from 'path'

// Cached token to avoid regenerating on every request
let cachedToken: { token: string; expiresAt: Date } | null = null

function getPrivateKey(): string {
  const keyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH
  if (!keyPath) {
    throw new Error('GITHUB_APP_PRIVATE_KEY_PATH environment variable is not set')
  }
  const resolvedPath = path.isAbsolute(keyPath)
    ? keyPath
    : path.join(process.cwd(), keyPath)
  return fs.readFileSync(resolvedPath, 'utf-8')
}

function getAppConfig() {
  const appId = process.env.GITHUB_APP_ID
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID
  if (!appId || !installationId) {
    throw new Error('GITHUB_APP_ID and GITHUB_APP_INSTALLATION_ID must be set')
  }
  return {
    appId: parseInt(appId),
    installationId: parseInt(installationId),
  }
}

/**
 * Generate a GitHub App installation token.
 * Caches the token until 5 minutes before expiry.
 */
export async function getInstallationToken(): Promise<{
  token: string
  expiresAt: string
}> {
  // Return cached token if still valid (with 5-minute buffer)
  if (cachedToken && cachedToken.expiresAt > new Date(Date.now() + 5 * 60 * 1000)) {
    return {
      token: cachedToken.token,
      expiresAt: cachedToken.expiresAt.toISOString(),
    }
  }

  const { appId, installationId } = getAppConfig()
  const privateKey = getPrivateKey()

  const auth = createAppAuth({
    appId,
    privateKey,
    installationId,
  })

  const result = await auth({ type: 'installation' })

  cachedToken = {
    token: result.token,
    expiresAt: new Date(result.expiresAt),
  }

  return {
    token: result.token,
    expiresAt: result.expiresAt,
  }
}

/**
 * Get an Octokit instance authenticated as the GitHub App installation.
 */
export async function getOctokit(): Promise<Octokit> {
  const { token } = await getInstallationToken()
  return new Octokit({
    auth: token,
    userAgent: 'project-forge/1.0',
  })
}

/**
 * Create a GitHub repository as the bot.
 */
export async function createRepo(params: {
  name: string
  description: string
  private?: boolean
}): Promise<{
  fullName: string
  htmlUrl: string
  cloneUrl: string
  defaultBranch: string
}> {
  const octokit = await getOctokit()
  const owner = process.env.GITHUB_REPO_OWNER
  if (!owner) {
    throw new Error('GITHUB_REPO_OWNER environment variable is not set')
  }

  const repoData = await octokit.repos.createInOrg({
    org: owner,
    name: params.name,
    description: params.description,
    private: params.private ?? false,
    auto_init: true,
    gitignore_template: 'Node',
    license_template: 'mit',
  }).catch(async () => {
    return octokit.repos.createForAuthenticatedUser({
      name: params.name,
      description: params.description,
      private: params.private ?? false,
      auto_init: true,
      gitignore_template: 'Node',
      license_template: 'mit',
    })
  })

  return {
    fullName: repoData.data.full_name,
    htmlUrl: repoData.data.html_url,
    cloneUrl: repoData.data.clone_url,
    defaultBranch: repoData.data.default_branch,
  }
}

/**
 * Verify a GitHub webhook signature using HMAC-SHA256.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string
): Promise<boolean> {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    console.warn('GITHUB_WEBHOOK_SECRET not set — skipping signature verification')
    return true
  }

  if (!signature.startsWith('sha256=')) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
  const expectedSig = 'sha256=' + Buffer.from(sig).toString('hex')

  if (expectedSig.length !== signature.length) return false
  let diff = 0
  for (let i = 0; i < expectedSig.length; i++) {
    diff |= expectedSig.charCodeAt(i) ^ signature.charCodeAt(i)
  }
  return diff === 0
}
