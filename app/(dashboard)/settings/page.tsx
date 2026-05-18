"use client";
export const dynamic = "force-dynamic";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DialogShell } from "@/components/DialogShell";
import { AppShell } from "@/components/layout/AppShell";
import { PageShell } from "@/components/ui/PageShell";
import { Button, Input, Card, CardHeader, Badge, Alert } from "@/components/ui/primitives";

interface ApiToken {
  id: string;
  name: string;
  token: string;
  lastUsedAt: string | null;
  createdAt: string;
}

interface TokenToRevoke {
  id: string;
  name: string;
}

export default function SettingsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [githubPat, setGithubPat] = useState("");
  const [githubConnectedViaOAuth, setGithubConnectedViaOAuth] = useState(false);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [newTokenName, setNewTokenName] = useState("");
  const [newlyCreatedToken, setNewlyCreatedToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [tokenToRevoke, setTokenToRevoke] = useState<TokenToRevoke | null>(null);
  const [revokingTokenId, setRevokingTokenId] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    else if (status === "authenticated") loadData();
  }, [status, router]);

  const loadData = async () => {
    try {
      const res = await fetch("/api/dashboard");
      const data = await res.json();
      if (data.ok) {
        setGithubPat(data.user.githubPat || "");
        setGithubConnectedViaOAuth(
          !!(data.user.githubPat?.startsWith("gho_") || data.user.githubOwner),
        );
        setTokens(data.tokens || []);
      }
    } catch (err) {
      console.error("Failed to load settings:", err);
    }
  };

  const handleSavePat = async () => {
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard/pat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubPat }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || "Failed to save PAT");
      else setSuccess("GitHub PAT saved! You can now create projects.");
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateToken = async () => {
    if (!newTokenName.trim()) {
      setError("Token name is required");
      return;
    }
    setError("");
    setSuccess("");
    setLoading(true);
    try {
      const res = await fetch("/api/dashboard/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newTokenName }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error || "Failed to create token");
      else {
        setNewlyCreatedToken(data.token.token);
        setNewTokenName("");
        loadData();
      }
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleRevokeToken = async () => {
    if (!tokenToRevoke) return;
    const currentToken = tokenToRevoke;
    setError("");
    setSuccess("");
    setRevokingTokenId(currentToken.id);
    try {
      const res = await fetch(`/api/dashboard/tokens/${currentToken.id}`, { method: "DELETE" });
      if (res.ok) {
        setSuccess("Token revoked");
        setTokenToRevoke(null);
        loadData();
      } else {
        setTokenToRevoke(null);
        setError("Failed to revoke token");
      }
    } catch {
      setTokenToRevoke(null);
      setError("Failed to revoke token");
    } finally {
      setRevokingTokenId(null);
    }
  };

  if (status === "loading") {
    return (
      <AppShell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
        </div>
      </AppShell>
    );
  }

  if (!session) return null;

  return (
    <AppShell>
      <PageShell title="Settings" subtitle="Manage your account, GitHub connection, and API tokens.">
        <div className="space-y-6">
          {error && <Alert variant="error" onClose={() => setError("")}>{error}</Alert>}
          {success && <Alert variant="success" onClose={() => setSuccess("")}>{success}</Alert>}

          {/* ── GitHub Connection ─────────────────────── */}
          <Card>
            <CardHeader
              title="GitHub Connection"
              action={
                githubConnectedViaOAuth
                  ? <Badge variant="success">Connected via OAuth</Badge>
                  : githubPat
                    ? <Badge variant="success">Connected via PAT</Badge>
                    : <Badge variant="warning">Not connected</Badge>
              }
            />

            {githubConnectedViaOAuth ? (
              <div className="space-y-4">
                <div className="rounded-md bg-green-950/20 p-4">
                  <div className="flex items-center gap-2 text-green-300 mb-1">
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    <span className="font-medium text-sm">GitHub Account Connected</span>
                  </div>
                  <p className="text-sm text-gray-400">
                    Repositories will be created in your connected GitHub account.
                  </p>
                </div>
                <Button variant="danger" size="sm" onClick={() => signOut({ callbackUrl: "/login" })}>
                  Disconnect GitHub (Sign Out)
                </Button>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-sm text-gray-400">
                  project-forge needs access to your GitHub account to create repositories.
                </p>

                <Card tone="accent" padding="sm">
                  <h3 className="font-semibold text-blue-300 text-sm">Option 1: GitHub OAuth (Recommended)</h3>
                  <p className="text-xs text-gray-400 mt-1 mb-3">Secure, automatic, no manual setup</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => router.push("/api/auth/signin?provider=github")}
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path fillRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" clipRule="evenodd" />
                    </svg>
                    Connect GitHub Account
                  </Button>
                </Card>

                <Card tone="muted" padding="sm">
                  <h3 className="font-semibold text-gray-300 text-sm">Option 2: Personal Access Token</h3>
                  <p className="text-xs text-gray-400 mt-1 mb-3">For advanced users, CI/CD, or corporate restrictions</p>
                  <Input
                    type="password"
                    value={githubPat}
                    onChange={(e) => setGithubPat(e.target.value)}
                    placeholder="github_pat_..."
                    className="font-mono text-sm mb-3"
                  />
                  <Button size="sm" onClick={handleSavePat} loading={loading}>
                    Save PAT
                  </Button>
                </Card>
              </div>
            )}
          </Card>

          {/* ── API Tokens ────────────────────────────── */}
          <Card>
            <CardHeader
              title="API Tokens"
              subtitle="Create tokens for your agents to use the REST API. Rate limit: 10 projects/day per token."
            />

            <div className="flex gap-3 mb-6">
              <Input
                type="text"
                value={newTokenName}
                onChange={(e) => setNewTokenName(e.target.value)}
                placeholder="Token name (e.g., my-agent)"
                className="flex-1"
              />
              <Button variant="success" onClick={handleCreateToken} loading={loading}>
                Create Token
              </Button>
            </div>

            {newlyCreatedToken && (
              <Alert variant="success" onClose={() => setNewlyCreatedToken(null)} className="mb-4">
                <p className="font-medium mb-1">Token created! Copy it now, it won&apos;t be shown again.</p>
                <code className="block bg-gray-800 rounded px-3 py-2 font-mono text-sm text-green-400 mt-2 break-all">
                  {newlyCreatedToken}
                </code>
              </Alert>
            )}

            {tokens.length === 0 ? (
              <p className="text-sm text-gray-500 py-4 text-center">No tokens yet. Create one above.</p>
            ) : (
              <div className="space-y-3">
                {tokens.map((token) => (
                  <div key={token.id} className="flex items-center justify-between rounded-md bg-gray-800/40 p-4">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-200">{token.name}</div>
                      <div className="text-sm font-mono text-gray-400 mt-1 truncate">{token.token}</div>
                      <div className="text-xs text-gray-500 mt-1">
                        Created: {new Date(token.createdAt).toLocaleDateString()} &middot;{" "}
                        Last used: {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleDateString() : "Never"}
                      </div>
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => setTokenToRevoke({ id: token.id, name: token.name })}
                      className="ml-4 shrink-0"
                    >
                      Revoke
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* ── API Quick Reference ───────────────────── */}
          <Card>
            <CardHeader title="API Quick Reference" action={
              <Button variant="ghost" size="sm" onClick={() => router.push("/docs")}>
                Full API Docs -&gt;
              </Button>
            } />
            <div className="space-y-4 text-sm">
              <div>
                <div className="font-semibold text-gray-200 mb-2">Endpoint</div>
                <code className="block rounded-md bg-gray-800 px-4 py-2.5 font-mono text-green-400">
                  POST https://project-forge.opentriologue.ai/api/v1/projects
                </code>
              </div>
              <div>
                <div className="font-semibold text-gray-200 mb-2">Headers</div>
                <code className="block rounded-md bg-gray-800 px-4 py-2.5 font-mono text-blue-400">
                  X-API-Key: pf_your_token_here
                </code>
              </div>
              <div>
                <div className="font-semibold text-gray-200 mb-2">Request Body</div>
                <pre className="rounded-md bg-gray-800 px-4 py-2.5 font-mono text-gray-300 overflow-x-auto">
{`{
  "projectName": "my-project",
  "summary": "Project description",
  "features": ["feature 1", "feature 2"],
  "constraints": ["constraint 1"]
}`}
                </pre>
              </div>
            </div>
          </Card>

          {/* ── Account ───────────────────────────────── */}
          <Card>
            <CardHeader title="Account" />
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-300">{session.user?.email}</p>
                <p className="text-xs text-gray-500 mt-0.5">Signed in via {githubConnectedViaOAuth ? "GitHub OAuth" : "email"}</p>
              </div>
              <Button variant="danger" size="sm" onClick={() => signOut({ callbackUrl: "/" })}>
                Sign Out
              </Button>
            </div>
          </Card>
        </div>

        {tokenToRevoke && (
          <RevokeTokenModal
            tokenName={tokenToRevoke.name}
            loading={revokingTokenId === tokenToRevoke.id}
            onConfirm={handleRevokeToken}
            onCancel={() => {
              if (!revokingTokenId) {
                setTokenToRevoke(null);
              }
            }}
          />
        )}
      </PageShell>
    </AppShell>
  );
}

function RevokeTokenModal({
  tokenName,
  loading = false,
  onConfirm,
  onCancel,
}: {
  tokenName: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <DialogShell
      title="Revoke API token?"
      onClose={onCancel}
      initialFocusRef={cancelButtonRef}
    >
      <div className="text-center mb-6">
        <div className="h-12 w-12 rounded-md bg-red-600/20 flex items-center justify-center mx-auto mb-4">
          <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636L5.636 18.364M5.636 5.636l12.728 12.728" />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-white">Revoke API token?</h2>
        <p className="text-gray-400 text-sm mt-2">
          <span className="text-gray-200 font-medium">{tokenName}</span> will stop working immediately.
        </p>
      </div>

      <div className="flex gap-3">
        <Button ref={cancelButtonRef} variant="secondary" block onClick={onCancel} disabled={loading}>
          Cancel
        </Button>
        <Button variant="danger" block onClick={onConfirm} loading={loading}>
          Revoke token
        </Button>
      </div>
    </DialogShell>
  );
}
