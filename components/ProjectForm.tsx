"use client";

import { useState, useEffect } from "react";
import type { ProjectInput } from "@/lib/types";

interface ProjectFormProps {
  onSubmit: (input: ProjectInput) => void;
  isLoading?: boolean;
  initialValues?: ProjectInput;
}

export function ProjectForm({ onSubmit, isLoading = false, initialValues }: ProjectFormProps) {
  const [name, setName] = useState(initialValues?.projectName ?? "");
  const [summary, setSummary] = useState(initialValues?.summary ?? "");
  const [featuresText, setFeaturesText] = useState(initialValues?.features?.join("\n") ?? "");
  const [constraintsText, setConstraintsText] = useState(initialValues?.constraints?.join("\n") ?? "");
  const [targetUsersText, setTargetUsersText] = useState(initialValues?.targetUsers?.join("\n") ?? "");
  const [magicPrompt, setMagicPrompt] = useState("");
  const [magicLoading, setMagicLoading] = useState(false);

  // Update form state when initialValues changes (for re-generation flow)
  useEffect(() => {
    if (initialValues) {
      setName(initialValues.projectName ?? "");
      setSummary(initialValues.summary ?? "");
      setFeaturesText(initialValues.features?.join("\n") ?? "");
      setConstraintsText(initialValues.constraints?.join("\n") ?? "");
      setTargetUsersText(initialValues.targetUsers?.join("\n") ?? "");
    }
  }, [initialValues]);

  const [formError, setFormError] = useState<string | null>(null);

  const handleMagicFill = async () => {
    if (!magicPrompt.trim()) return;

    setMagicLoading(true);
    setFormError(null);

    try {
      const res = await fetch("/api/ai-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: magicPrompt }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        setFormError(data.error || "AI assist failed");
        setMagicLoading(false);
        return;
      }

      // Fill form with AI-generated data
      const aiData = data.data as ProjectInput;
      setName(aiData.projectName || "");
      setSummary(aiData.summary || "");
      setFeaturesText(aiData.features?.join("\n") || "");
      setConstraintsText(aiData.constraints?.join("\n") || "");
      setTargetUsersText(aiData.targetUsers?.join("\n") || "");
      setMagicPrompt(""); // Clear prompt
    } catch (error: any) {
      setFormError(error.message || "Failed to connect to AI service");
    } finally {
      setMagicLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const features = featuresText.split("\n").map((f) => f.trim()).filter(Boolean);
    const targetUsers = targetUsersText.split("\n").map((u) => u.trim()).filter(Boolean);
    if (features.length === 0) {
      setFormError("Please add at least one core feature.");
      return;
    }
    if (targetUsers.length === 0) {
      setFormError("Please add at least one target user.");
      return;
    }
    onSubmit({
      projectName: name.trim(),
      summary: summary.trim(),
      features,
      constraints: constraintsText.split("\n").map((c) => c.trim()).filter(Boolean),
      targetUsers,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* AI Magic Fill */}
      <div className="rounded-lg border border-purple-800 bg-purple-950/20 p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-lg">✨</span>
          <h3 className="font-semibold text-purple-300">AI Magic Fill</h3>
        </div>
        <p className="text-xs text-gray-400 mb-3">
          Describe your project idea in natural language, and AI will fill the form for you.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={magicPrompt}
            onChange={(e) => setMagicPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleMagicFill();
              }
            }}
            placeholder="E.g., 'A todo app with React and TypeScript that syncs across devices'"
            disabled={magicLoading || isLoading}
            className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-sm text-gray-100 placeholder-gray-500 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500 disabled:opacity-50"
          />
          <button
            type="button"
            onClick={handleMagicFill}
            disabled={!magicPrompt.trim() || magicLoading || isLoading}
            className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white hover:bg-purple-500 transition disabled:cursor-not-allowed disabled:opacity-50 flex items-center gap-2"
          >
            {magicLoading ? (
              <>
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Generating...
              </>
            ) : (
              <>
                <span>✨</span>
                Fill Form
              </>
            )}
          </button>
        </div>
      </div>

      {formError && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-300">
          {formError}
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Project Name <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-awesome-project"
          required
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Summary <span className="text-red-400">*</span>
        </label>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="A brief description of what this project does and why it exists..."
          required
          rows={3}
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Core Features <span className="text-red-400">*</span>
          <span className="text-gray-500 text-xs ml-2">(one per line)</span>
        </label>
        <textarea
          value={featuresText}
          onChange={(e) => setFeaturesText(e.target.value)}
          placeholder="user authentication&#10;dashboard with analytics&#10;REST API"
          rows={4}
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Constraints
          <span className="text-gray-500 text-xs ml-2">(one per line)</span>
        </label>
        <textarea
          value={constraintsText}
          onChange={(e) => setConstraintsText(e.target.value)}
          placeholder="TypeScript only&#10;must be deployable with Docker&#10;no external auth providers"
          rows={3}
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-1">
          Target Users <span className="text-red-400">*</span>
          <span className="text-gray-500 text-xs ml-2">(one per line)</span>
        </label>
        <textarea
          value={targetUsersText}
          onChange={(e) => setTargetUsersText(e.target.value)}
          placeholder="developers&#10;internal team"
          rows={2}
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-gray-100 placeholder-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <button
        type="submit"
        disabled={isLoading || !name.trim() || !summary.trim()}
        className="w-full rounded-lg bg-blue-600 px-6 py-3 font-semibold text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isLoading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
            Generating...
          </span>
        ) : (
          "Generate Project Plan →"
        )}
      </button>
    </form>
  );
}
