"use client";
export const dynamic = "force-dynamic";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { PageShell } from "@/components/ui/PageShell";
import { ProjectForm } from "@/components/ProjectForm";
import { PreviewPanel } from "@/components/PreviewPanel";
import { ConfirmModal } from "@/components/ConfirmModal";
import { ErrorModal } from "@/components/ErrorModal";
import { Card, Button } from "@/components/ui/primitives";
import type { GenerationPreview, ProjectInput } from "@/lib/types";

type State = "form" | "loading" | "preview" | "confirming" | "publishing" | "done";

interface UiError {
  title: string;
  message: string;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy to clipboard"
      className="ml-2 text-forge-ash hover:text-forge-mist transition shrink-0"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? (
        <svg className="w-4 h-4 text-success" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
        </svg>
      )}
    </button>
  );
}

export default function CreatePage() {
  const { status } = useSession();
  const router = useRouter();
  const [state, setState] = useState<State>("form");
  const [preview, setPreview] = useState<GenerationPreview | null>(null);
  const [lastInput, setLastInput] = useState<ProjectInput | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
    else if (status === "authenticated") {
      fetch("/api/dashboard")
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) {
            setGithubConnected(!!(data.user.githubPatConnected || data.user.githubOwner));
          } else {
            setGithubConnected(false);
          }
        })
        .catch(() => setGithubConnected(false));
    }
  }, [status, router]);

  const handleGenerate = async (input: ProjectInput) => {
    setState("loading");
    setError(null);
    setLastInput(input);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Generation failed");
      setPreview(data.preview);
      setState("preview");
    } catch (err) {
      setError({
        title: "Project generation failed",
        message: err instanceof Error ? err.message : "Generation failed",
      });
      setState("form");
    }
  };

  const handlePublish = async () => {
    if (!preview) return;
    setState("publishing");
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: preview.sessionId, projectName: preview.projectName }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Publish failed");
      setRepoUrl(data.result.repoUrl);
      setState("done");
    } catch (err) {
      setError({
        title: "Repository creation failed",
        message: err instanceof Error ? err.message : "Publish failed",
      });
      setState("preview");
    }
  };

  if (status === "loading") return null;

  const needsGithub = githubConnected === false;

  return (
    <AppShell>
      <PageShell
        title="New Project"
        subtitle="Describe your project. planforge + scaffoldkit will do the rest."
      >
        {(state === "form" || state === "loading") && (
          <div className="relative">
            {/* GitHub gate overlay */}
            {needsGithub && (
              <Card tone="warning" padding="md" className="mb-6">
                <div className="flex items-start gap-3">
                  <div className="h-10 w-10 rounded-btn bg-warning/20 flex items-center justify-center text-warning shrink-0">
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h3 className="font-semibold text-gold mb-1">GitHub connection required</h3>
                    <p className="text-sm text-forge-ash mb-4">
                      Connect your GitHub account to create repositories. Choose OAuth for the fastest setup.
                    </p>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <Button
                        size="sm"
                        onClick={() => router.push("/api/auth/signin?provider=github")}
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <path fillRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.603-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.463-1.11-1.463-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.831.092-.646.35-1.086.636-1.336-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.114 2.504.336 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z" clipRule="evenodd" />
                        </svg>
                        Connect with GitHub
                      </Button>
                      <Button variant="secondary" size="sm" onClick={() => router.push("/settings")}>
                        Add PAT in Settings
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            )}

            {/* Form — visible but disabled when GitHub not connected */}
            <div
              className={needsGithub ? "opacity-40 pointer-events-none select-none" : ""}
              {...(needsGithub ? { inert: true, "aria-hidden": true } : {})}
            >
              <Card padding="lg">
                <ProjectForm onSubmit={handleGenerate} isLoading={state === "loading"} initialValues={lastInput ?? undefined} />
              </Card>
            </div>
          </div>
        )}

        {(state === "preview" || state === "confirming") && preview && (
          <PreviewPanel
            preview={preview}
            onConfirm={() => setState("confirming")}
            onBack={() => { setState("form"); setPreview(null); }}
            isPublishing={false}
          />
        )}

        {state === "confirming" && preview && (
          <ConfirmModal
            projectName={preview.projectName}
            taskCount={preview.taskCount}
            waveCount={preview.waveCount}
            onConfirm={handlePublish}
            onCancel={() => setState("preview")}
          />
        )}

        {state === "publishing" && (
          <Card padding="lg" className="text-center">
            <div className="py-8">
              <div className="h-10 w-10 animate-spin rounded-full border-2 border-ember border-t-transparent mx-auto mb-4" />
              <p className="text-forge-mist font-medium">Creating repository...</p>
              <p className="text-forge-ash text-sm mt-1">This may take a moment.</p>
            </div>
          </Card>
        )}

        {state === "done" && repoUrl && (
          <Card tone="success" padding="lg" className="text-center">
            <div className="h-12 w-12 rounded-full bg-success/20 flex items-center justify-center mx-auto mb-4">
              <svg className="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
              </svg>
            </div>
            <h2 className="font-display text-2xl font-semibold text-forge-mist mb-2">Project Created!</h2>
            <div className="flex items-center rounded-card bg-forge-iron px-4 py-3 mb-6">
              <code className="text-sm text-forge-mist font-mono flex-1 overflow-x-auto">
                git clone {repoUrl}
              </code>
              <CopyButton text={`git clone ${repoUrl}`} />
            </div>
            <div className="flex gap-3">
              <Button variant="secondary" block onClick={() => window.open(repoUrl, "_blank")}>
                View on GitHub -&gt;
              </Button>
              <Button block onClick={() => { setState("form"); setPreview(null); setRepoUrl(null); setError(null); }}>
                Create another
              </Button>
            </div>
          </Card>
        )}

        {error && (
          <ErrorModal
            title={error.title}
            message={error.message}
            onClose={() => setError(null)}
          />
        )}
      </PageShell>
    </AppShell>
  );
}
