"use client";
export const dynamic = "force-dynamic";

import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ProjectForm } from "@/components/ProjectForm";
import { PreviewPanel } from "@/components/PreviewPanel";
import { ConfirmModal } from "@/components/ConfirmModal";
import type { GenerationPreview, ProjectInput } from "@/lib/types";

type State = "form" | "loading" | "preview" | "confirming" | "publishing" | "done";

export default function CreatePage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [state, setState] = useState<State>("form");
  const [preview, setPreview] = useState<GenerationPreview | null>(null);
  const [lastInput, setLastInput] = useState<ProjectInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (status === "unauthenticated") router.push("/login");
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
      setError(err instanceof Error ? err.message : "Generation failed");
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
      setError(err instanceof Error ? err.message : "Publish failed");
      setState("preview");
    }
  };

  if (status === "loading") return null;

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100">
      <nav className="border-b border-gray-800 px-6 py-4 flex items-center gap-4 max-w-3xl mx-auto">
        <Link href="/dashboard" className="text-gray-400 hover:text-gray-200 transition text-sm">
          ← Dashboard
        </Link>
        <span className="text-gray-600">/</span>
        <span className="text-sm font-medium">New Project</span>
      </nav>

      <div className="max-w-2xl mx-auto px-6 py-12">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold mb-2">⚒️ New Project</h1>
          <p className="text-gray-400">
            Describe your project — planforge + scaffoldkit will do the rest.
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-800 bg-red-950/50 p-4 flex items-start gap-3">
            <span className="text-red-400 shrink-0">⚠️</span>
            <div className="flex-1">
              <p className="text-red-300 text-sm font-medium">Something went wrong</p>
              <p className="text-red-400 text-xs mt-1">{error}</p>
            </div>
            <button onClick={() => setError(null)} className="text-red-500 hover:text-red-300 text-lg leading-none">×</button>
          </div>
        )}

        {(state === "form" || state === "loading") && (
          <div className="rounded-xl border border-gray-700 bg-gray-900 p-8">
            <ProjectForm onSubmit={handleGenerate} isLoading={state === "loading"} initialValues={lastInput ?? undefined} />
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
          <div className="rounded-xl border border-gray-700 bg-gray-900 p-12 text-center">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-blue-500 border-t-transparent mx-auto mb-4" />
            <p className="text-gray-300 font-medium">Creating repository...</p>
          </div>
        )}

        {state === "done" && repoUrl && (
          <div className="rounded-xl border border-green-800 bg-green-950/30 p-8 text-center">
            <div className="text-5xl mb-4">✅</div>
            <h2 className="text-2xl font-semibold mb-2">Project Created!</h2>
            <code className="block rounded-lg bg-gray-900 px-4 py-3 text-sm text-green-400 mb-6 font-mono">
              git clone {repoUrl}
            </code>
            <div className="flex gap-3">
              <a href={repoUrl} target="_blank" rel="noreferrer"
                className="flex-1 rounded-lg border border-gray-700 px-4 py-2.5 text-gray-300 hover:bg-gray-800 transition text-center text-sm">
                View on GitHub →
              </a>
              <Link href="/create"
                className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-white hover:bg-blue-500 transition text-sm font-medium text-center">
                Create another
              </Link>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
