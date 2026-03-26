"use client";
export const dynamic = "force-dynamic";

import { useSession, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface ApiToken {
  id: string;
  name: string;
  token: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export default function DashboardPage() {
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

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    } else if (status === "authenticated") {
      loadDashboard();
    }
  }, [status, router]);

  const loadDashboard = async () => {
    try {
      const res = await fetch("/api/dashboard");
      const data = await res.json();
      if (data.ok) {
        setGithubPat(data.user.githubPat || "");
        setGithubConnectedViaOAuth(!!data.user.githubOwner && !data.user.githubPat?.startsWith("github_pat"));
        setTokens(data.tokens || []);
      }
    } catch (err) {
      console.error("Failed to load dashboard:", err);
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

      if (!res.ok) {
        setError(data.error || "Failed to save PAT");
      } else {
        setSuccess("GitHub PAT saved successfully!");
      }
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

      if (!res.ok) {
        setError(data.error || "Failed to create token");
      } else {
        setNewlyCreatedToken(data.token.token);
        setNewTokenName("");
        loadDashboard();
      }
    } catch (err: any) {
      setError(err.message || "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleRevokeToken = async (tokenId: string) => {
    if (!confirm("Are you sure you want to revoke this token?")) return;

    try {
      const res = await fetch(`/api/dashboard/tokens/${tokenId}`, {
        method: "DELETE",
      });

      if (res.ok) {
        setSuccess("Token revoked");
        loadDashboard();
      }
    } catch (err) {
      setError("Failed to revoke token");
    }
  };

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      </div>
    );
  }

  if (!session) return null;

  return (
    <main className="min-h-screen bg-gray-950 p-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Dashboard</h1>
            <p className="text-gray-400 mt-1">{session.user?.email}</p>
          </div>
          <button
            onClick={() => signOut({ callbackUrl: "/" })}
            className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 transition"
          >
            Sign Out
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-red-800 bg-red-950/50 p-4 text-red-300">
            {error}
          </div>
        )}

        {success && (
          <div className="rounded-lg border border-green-800 bg-green-950/30 p-4 text-green-300">
            {success}
          </div>
        )}

        {/* GitHub PAT Section */}
        <div className="rounded-xl border border-gray-700 bg-gray-900 p-6">
          <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">GitHub Connection</h2>
              {githubConnectedViaOAuth && (
                <span className="text-xs rounded-full border border-green-800 bg-green-950/50 px-3 py-1 text-green-300">✓ Connected via OAuth</span>
              )}
            </div>
          <p className="text-sm text-gray-400 mb-4">
            Your PAT is used to create repositories on your behalf when using the API.
          </p>
          <div className="space-y-4">
            <input
              type="password"
              value={githubPat}
              onChange={(e) => setGithubPat(e.target.value)}
              placeholder="ghp_..."
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-gray-100 font-mono text-sm placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handleSavePat}
              disabled={loading}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 transition disabled:opacity-50"
            >
              {loading ? "Saving..." : "Save PAT"}
            </button>
          </div>
        </div>

        {/* API Tokens Section */}
        <div className="rounded-xl border border-gray-700 bg-gray-900 p-6">
          <h2 className="text-xl font-semibold mb-4">API Tokens</h2>
          <p className="text-sm text-gray-400 mb-4">
            Create API tokens for your agents. Rate limit: 10 projects per day per token.
          </p>

          {/* Create Token */}
          <div className="flex gap-3 mb-6">
            <input
              type="text"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              placeholder="Token name (e.g., my-agent)"
              className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handleCreateToken}
              disabled={loading}
              className="rounded-lg bg-green-600 px-4 py-2 font-semibold text-white hover:bg-green-500 transition disabled:opacity-50"
            >
              Create Token
            </button>
          </div>

          {/* Token List */}
          {tokens.length === 0 ? (
            <p className="text-sm text-gray-500">No tokens yet. Create one above!</p>
          ) : (
            <div className="space-y-3">
              {tokens.map((token) => (
                <div
                  key={token.id}
                  className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-800/50 p-4"
                >
                  <div className="flex-1">
                    <div className="font-medium text-gray-200">{token.name}</div>
                    <div className="text-sm font-mono text-gray-400 mt-1">
                      {token.token}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      Created: {new Date(token.createdAt).toLocaleDateString()} •
                      Last used: {token.lastUsedAt ? new Date(token.lastUsedAt).toLocaleDateString() : "Never"}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRevokeToken(token.id)}
                    className="ml-4 rounded-lg border border-red-800 px-3 py-1 text-sm text-red-300 hover:bg-red-950/30 transition"
                  >
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* API Documentation */}
        <div className="rounded-xl border border-gray-700 bg-gray-900 p-6">
          <h2 className="text-xl font-semibold mb-4">API Usage</h2>
          <div className="space-y-4 text-sm">
            <div>
              <div className="font-semibold text-gray-200 mb-2">Endpoint:</div>
              <code className="block rounded bg-gray-800 px-3 py-2 font-mono text-green-400">
                POST https://project-forge.opentriologue.ai/api/v1/projects
              </code>
            </div>
            <div>
              <div className="font-semibold text-gray-200 mb-2">Headers:</div>
              <code className="block rounded bg-gray-800 px-3 py-2 font-mono text-blue-400">
                X-API-Key: pf_your_token_here
              </code>
            </div>
            <div>
              <div className="font-semibold text-gray-200 mb-2">Request Body:</div>
              <pre className="rounded bg-gray-800 px-3 py-2 font-mono text-gray-300 overflow-x-auto">
{`{
  "projectName": "my-project",
  "summary": "Project description",
  "features": ["feature 1", "feature 2"],
  "constraints": ["constraint 1"]
}`}
              </pre>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
