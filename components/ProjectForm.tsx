"use client";

import { useState } from "react";
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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      projectName: name.trim(),
      summary: summary.trim(),
      features: featuresText.split("\n").map((f) => f.trim()).filter(Boolean),
      constraints: constraintsText.split("\n").map((c) => c.trim()).filter(Boolean),
      targetUsers: targetUsersText.split("\n").map((u) => u.trim()).filter(Boolean),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
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
          Core Features
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
          Target Users
          <span className="text-gray-500 text-xs ml-2">(one per line, optional)</span>
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
