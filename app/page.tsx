"use client";

import { useState } from "react";
import { ProjectForm } from "@/components/ProjectForm";
import { PreviewPanel } from "@/components/PreviewPanel";
import type { GenerationPreview, ProjectInput } from "@/lib/types";

type AppState = "form" | "loading" | "preview" | "publishing" | "done";

export default function Home() {
  const [state, setState] = useState<AppState>("form");
  const [preview, setPreview] = useState<GenerationPreview | null>(null);
  const [lastInput, setLastInput] = useState<ProjectInput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoUrl, setRepoUrl] = useState<string | null>(null);

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
        body: JSON.stringify({
          sessionId: preview.sessionId,
          projectName: preview.projectName,
        }),
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

  const handleBack = () => {
    setState("form");
    setPreview(null);
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

        {state !== "done" && (
          <div className="flex items-center justify-center gap-4 mb-8 text-sm">
            {(["form", "preview", "done"] as const).map((step, i) => (
              <div key={step} className="flex items-center gap-2">
                <div
                  className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold ${
                    state === step
                      ? "bg-blue-600 text-white"
                      : state === "loading" && step === "form"
                      ? "bg-blue-600 text-white"
                      : state === "publishing" && step === "preview"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-700 text-gray-400"
                  }`}
                >
                  {i + 1}
                </div>
                <span className={state === step ? "text-gray-200" : "text-gray-500"}>
                  {step === "form" ? "Describe" : step === "preview" ? "Review" : "Done"}
                </span>
                {i < 2 && <span className="text-gray-700">→</span>}
              </div>
            ))}
          </div>
        )}

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
              initialValues={lastInput ?? undefined}
            />
          </div>
        )}

        {(state === "preview" || state === "publishing") && preview && (
          <PreviewPanel
            preview={preview}
            onConfirm={handlePublish}
            onBack={handleBack}
            isPublishing={state === "publishing"}
          />
        )}

        {state === "done" && repoUrl && (
          <div className="rounded-xl border border-green-800 bg-green-950/30 p-8 text-center">
            <div className="text-5xl mb-4">✅</div>
            <h2 className="text-2xl font-semibold mb-2">Project Created!</h2>
            <p className="text-gray-400 mb-6">
              Your project is ready. Clone it and hand off to your agent:
            </p>
            <code className="block rounded-lg bg-gray-900 px-4 py-3 text-sm text-green-400 mb-6">
              git clone {repoUrl}
            </code>
            <div className="flex gap-3">
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                className="flex-1 rounded-lg border border-gray-700 px-4 py-2 text-gray-300 hover:bg-gray-800 transition text-center text-sm"
              >
                View on GitHub →
              </a>
              <button
                onClick={() => { setState("form"); setPreview(null); setRepoUrl(null); }}
                className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-white hover:bg-blue-500 transition text-sm"
              >
                Create another
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
