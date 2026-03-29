import { NextRequest, NextResponse } from 'next/server'
import { getInstallationToken } from '@/lib/github-app'

const ALLOWED_AGENTS = (process.env.AGENT_IDS ?? 'ice,lava').split(',').map(s => s.trim())

export async function POST(request: NextRequest) {
  const agentId = request.headers.get('x-agent-id')
  if (!agentId || !ALLOWED_AGENTS.includes(agentId)) {
    return NextResponse.json(
      { error: 'Unauthorized — invalid or missing X-Agent-Id header' },
      { status: 401 }
    )
  }

  try {
    const { token, expiresAt } = await getInstallationToken()
    return NextResponse.json({ token, expiresAt })
  } catch (error) {
    console.error('[github/token] Error generating token:', error)
    return NextResponse.json(
      { error: 'Failed to generate GitHub App token' },
      { status: 500 }
    )
  }
}
