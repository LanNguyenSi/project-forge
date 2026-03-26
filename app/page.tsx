"use client";

import { useState } from "react";
import { ProjectForm } from "@/components/ProjectForm";
import type { GenerationPreview, ProjectInput } from "@/lib/types";

type AppState = "form" | "loading" | "preview" | "publishing" | "done";

export default function Home() {
  const [state, setState] = useState<AppState>("form");
  const [preview, setPreview] = useState<GenerationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);

  const handleGenerate = async (input: ProjectInput) => {
    setState("loading");
    setError(null);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Generation failed");
      }
      setPreview(data.preview);
      setState("preview");
    } catch (err) {
      setError((err as Error).message);
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
        body: JSON.stringify({ sessionId: preview.sessionId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error ?? "Publish failed");
      setRepoUrl(data.result.repoUrl);
      setState("done");
    } catch (err) {
      setError((err as Error).message);
      setState("preview");
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <div className="max-w-2xl w-full">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold mb-2">project-forge</h1>
          <p className="text-gray-400">
            Create AI-toolchain projects with planforge + scaffoldkit
          </p>
        </div>

        {error && (
          <div className="mb-6 rounded-lg border border-red-800 bg-red-950/50 p-4 text-red-300 text-sm">
            {error}
          </div>
        )}

        {(state === "form" || state === "loading") && (
          <div className="rounded-xl border border-gray-700 bg-gray-900 p-8">
            <ProjectForm
              onSubmit={handleGenerate}
              isLoading={state === "loading"}
            />
          </div>
        )}

        {state === "preview" && preview && (
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-700 bg-gray-900 p-6">
              <h2 className="text-xl font-semibold mb-1">{preview.projectName}</h2>
              <p className="text-gray-400 text-sm mb-4">
                {preview.taskCount} tasks across {preview.waveCount} waves
              </p>
              <div className="space-y-1">
                {preview.tasks.map((task) => (
                  <div key={task.id} className="flex items-center gap-3 text-sm">
                    <span className="text-gray-500 font-mono w-6">{task.id}</span>
                    <span className="text-xs text-gray-600 w-16">{task.wave}</span>
                    <span className="text-gray-300">{task.title}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setState("form")}
                className="flex-1 rounded-lg border border-gray-700 px-4 py-2 text-gray-300 hover:bg-gray-800 transition"
              >
                ← Back & Adjust
              </button>
              <button
                onClick={handlePublish}
                className="flex-1 rounded-lg bg-green-600 px-4 py-2 font-semibold text-white hover:bg-green-500 transition"
              >
                Create GitHub Repo →
              </button>
            </div>
          </div>
        )}

        {state === "publishing" && (
          <div className="text-center text-gray-400">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-500 border-t-transparent mx-auto mb-4" />
            Creating GitHub repository...
          </div>
        )}

        {state === "done" && repoUrl && (
          <div className="rounded-xl border border-green-800 bg-green-950/30 p-8 text-center">
            <div className="text-4xl mb-4">✅</div>
            <h2 className="text-xl font-semibold mb-2">Project Created!</h2>
            <p className="text-gray-400 mb-4">
              Your project is ready. Clone it and start building:
            </p>
            <code className="block rounded-lg bg-gray-900 px-4 py-3 text-sm text-green-400 mb-4">
              git clone {repoUrl.replace("https://", "git@").replace("/", ":")}
            </code>
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
              className="text-blue-400 hover:underline text-sm"
            >
              View on GitHub →
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
