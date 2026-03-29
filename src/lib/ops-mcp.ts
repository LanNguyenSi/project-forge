/**
 * Client for the ops-mcp state store.
 * Used for agent coordination (task locking, queue management).
 */

const OPS_MCP_URL = process.env.OPS_MCP_URL ?? 'http://localhost:8080'

class OpsMcpClient {
  private baseUrl: string

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  async get(key: string): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/state/${encodeURIComponent(key)}`, {
      headers: { 'Content-Type': 'application/json' },
    })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`ops-mcp GET failed: ${res.status}`)
    const data = await res.json()
    return data.value ?? null
  }

  async set(key: string, value: string, ttl?: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/state/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value, ...(ttl ? { ttl } : {}) }),
    })
    if (!res.ok) throw new Error(`ops-mcp SET failed: ${res.status}`)
  }

  async cas(key: string, expected: string | null, newValue: string): Promise<boolean> {
    const res = await fetch(`${this.baseUrl}/state/${encodeURIComponent(key)}/cas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expected, value: newValue }),
    })
    if (res.status === 409) return false
    if (!res.ok) throw new Error(`ops-mcp CAS failed: ${res.status}`)
    return true
  }

  async del(key: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/state/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    })
    if (!res.ok && res.status !== 404) throw new Error(`ops-mcp DEL failed: ${res.status}`)
  }

  async keys(pattern: string): Promise<string[]> {
    const res = await fetch(
      `${this.baseUrl}/state?pattern=${encodeURIComponent(pattern)}`,
      { headers: { 'Content-Type': 'application/json' } }
    )
    if (!res.ok) throw new Error(`ops-mcp KEYS failed: ${res.status}`)
    const data = await res.json()
    return data.keys ?? []
  }
}

const globalForMcp = globalThis as unknown as { mcp: OpsMcpClient | undefined }
export const mcp = globalForMcp.mcp ?? new OpsMcpClient(OPS_MCP_URL)
if (process.env.NODE_ENV !== 'production') globalForMcp.mcp = mcp

export default mcp
