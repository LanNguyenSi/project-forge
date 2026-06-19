"use client";
export const dynamic = "force-dynamic";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { PageShell } from "@/components/ui/PageShell";
import { Button, Card, Badge } from "@/components/ui/primitives";

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [githubConnected, setGithubConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    else if (status === "authenticated") {
      fetch("/api/dashboard")
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            setGithubConnected(
              !!(data.user.githubPat || data.user.githubOwner),
            );
          }
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    }
  }, [status, router]);

  if (status === "loading" || !loaded) {
    return (
      <AppShell>
        <div className="flex min-h-[60vh] items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-ember border-t-transparent" />
        </div>
      </AppShell>
    );
  }

  if (!session) return null;

  return (
    <AppShell>
      <PageShell title="Dashboard">
        <div className="space-y-8">

          {/* ── Hero Card (adaptive) ──────────────────── */}
          {!githubConnected ? (
            /* State: GitHub NOT connected → guide to connect */
            <Card tone="accent" padding="lg">
              <div className="flex items-center gap-2 text-xs text-ember font-medium mb-4">
                <span className="flex items-center gap-1.5 rounded-full bg-ember/20 px-2.5 py-1">Step 1 of 2</span>
                Connect GitHub
              </div>
              <h2 className="font-display text-xl sm:text-2xl font-bold text-forge-mist mb-2">
                Connect GitHub to get started
              </h2>
              <p className="text-forge-ash text-sm mb-6 max-w-lg">
                project-forge needs access to your GitHub account to create repositories.
                Connect via OAuth for the fastest setup, or add a Personal Access Token in Settings.
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  size="lg"
                  onClick={() => router.push("/api/auth/signin?provider=github")}
                >
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                    <path fillRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" clipRule="evenodd" />
                  </svg>
                  Connect with GitHub
                </Button>
                <Button variant="secondary" size="lg" onClick={() => router.push("/settings")}>
                  Add PAT in Settings
                </Button>
              </div>
            </Card>
          ) : (
            /* State: GitHub connected → create project CTA */
            <Card tone="accent" padding="lg">
              <div className="flex items-center gap-2 mb-4">
                <Badge variant="success">GitHub connected</Badge>
              </div>
              <h2 className="font-display text-xl sm:text-2xl font-bold text-forge-mist mb-2">
                Create your first project
              </h2>
              <p className="text-forge-ash text-sm mb-6 max-w-lg">
                Describe your project, review the AI-generated plan, and publish to GitHub. All in under a minute.
              </p>
              <Button size="lg" onClick={() => router.push("/create")}>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Create a Project
              </Button>
            </Card>
          )}

          {/* ── How it works ─────────────────────────── */}
          <div>
            <h3 className="font-display text-lg font-semibold text-forge-mist mb-4">How it works</h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                {
                  step: "1",
                  title: "Connect GitHub",
                  desc: "Sign in with GitHub OAuth or add a Personal Access Token in Settings.",
                  icon: (
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path fillRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" clipRule="evenodd" />
                    </svg>
                  ),
                },
                {
                  step: "2",
                  title: "Describe your project",
                  desc: "Fill in the form manually, or let AI generate a project spec from a single sentence.",
                  icon: (
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                    </svg>
                  ),
                },
                {
                  step: "3",
                  title: "Review & publish",
                  desc: "Check tasks, architecture, and file tree. One click creates the GitHub repo.",
                  icon: (
                    <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
                    </svg>
                  ),
                },
              ].map((s) => (
                <Card key={s.step} tone="muted" padding="sm">
                  <div className="flex items-start gap-3">
                    <div className="h-10 w-10 rounded-card bg-ember/10 flex items-center justify-center text-ember shrink-0">
                      {s.icon}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-bold text-ember">Step {s.step}</span>
                        <span className="text-sm font-semibold text-forge-mist">{s.title}</span>
                      </div>
                      <p className="text-xs text-forge-ash leading-relaxed">{s.desc}</p>
                    </div>
                  </div>
                </Card>
              ))}
            </div>

            {/* Agent alternative */}
            <div className="mt-4 rounded-card bg-forge-steel/40 border border-forge-steel px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <svg className="w-5 h-5 text-forge-ash shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17.25 6.75L22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3l-4.5 16.5" />
                </svg>
                <p className="text-sm text-forge-ash">
                  Or generate an <Link href="/settings" className="text-ember hover:text-ember-soft transition">API token</Link> and let your local agent create projects via the <Link href="/docs" className="text-ember hover:text-ember-soft transition">REST API</Link>.
                </p>
              </div>
            </div>
          </div>

        </div>
      </PageShell>
    </AppShell>
  );
}
