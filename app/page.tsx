"use client";

import { useState } from "react";
import { ProjectForm } from "@/components/ProjectForm";
import { PreviewPanel } from "@/components/PreviewPanel";
import { ConfirmModal } from "@/components/ConfirmModal";
import type { GenerationPreview, ProjectInput } from "@/lib/types";

type AppState = "form" | "loading" | "preview" | "confirming" | "publishing" | "done";

function StepIndicator({ state }: { state: AppState }) {
  const steps = [
    { id: "form", label: "Describe", active: state === "form" || state === "loading" },
    { id: "preview", label: "Review", active: state === "preview" || state === "confirming" },
    { id: "done", label: "Done", active: state === "publishing" || state === "done" },
  ];
  return (
    <div className="flex items-center justify-center gap-4 mb-8 text-sm">
      {steps.map((step, i) => (
        <div key={step.id} className="flex items-center gap-2">
          <div
            className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
              step.active ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-400"
            }`}
          >
            {i + 1}
          </div>
          <span className={step.active ? "text-gray-200" : "text-gray-500"}>{step.label}</span>
          {i < 2 && <span className="text-gray-700">→</span>}
        </div>
      ))}
    </div>
  );
}

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
      setError(err instanceof Error ? err.message : "Generation failed. Please try again.");
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
      setError(err instanceof Error ? err.message : "Failed to create repository. Please try again.");
      setState("preview");
    }
  };

  const handleBack = () => {
    setState("form");
    setPreview(null);
    setError(null);
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

        {state !== "done" && <StepIndicator state={state} />}

        {error && (
          <div className="mb-6 rounded-lg border border-red-800 bg-red-950/50 p-4 flex items-start gap-3">
            <span className="text-red-400 shrink-0 mt-0.5">⚠️</span>
            <div>
              <p className="text-red-300 text-sm font-medium">Something went wrong</p>
              <p className="text-red-400 text-xs mt-1">{error}</p>
            </div>
            <button
              onClick={() => setError(null)}
              className="ml-auto text-red-500 hover:text-red-300 transition text-lg leading-none"
            >
              ×
            </button>
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

        {(state === "preview" || state === "confirming") && preview && (
          <PreviewPanel
            preview={preview}
            onConfirm={() => setState("confirming")}
            onBack={handleBack}
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

        {state === "publishing" && preview && (
          <div className="rounded-xl border border-gray-700 bg-gray-900 p-12 text-center">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-blue-500 border-t-transparent mx-auto mb-4" />
            <p className="text-gray-300 font-medium">Creating repository...</p>
            <p className="text-gray-500 text-sm mt-1">{preview.projectName}</p>
          </div>
        )}

        {state === "done" && repoUrl && (
          <div className="rounded-xl border border-green-800 bg-green-950/30 p-8 text-center">
            <div className="text-5xl mb-4">✅</div>
            <h2 className="text-2xl font-semibold mb-2">Project Created!</h2>
            <p className="text-gray-400 mb-6">
              Your project is ready. Clone it and hand off to your agent:
            </p>
            <code className="block rounded-lg bg-gray-900 px-4 py-3 text-sm text-green-400 mb-6 font-mono">
              git clone {repoUrl}
            </code>
            <div className="flex gap-3">
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                className="flex-1 rounded-lg border border-gray-700 px-4 py-2.5 text-gray-300 hover:bg-gray-800 transition text-center text-sm"
              >
                View on GitHub →
              </a>
              <button
                onClick={() => {
                  setState("form");
                  setPreview(null);
                  setRepoUrl(null);
                  setError(null);
                  setLastInput(null);
                }}
                className="flex-1 rounded-lg bg-blue-600 px-4 py-2.5 text-white hover:bg-blue-500 transition text-sm font-medium"
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
