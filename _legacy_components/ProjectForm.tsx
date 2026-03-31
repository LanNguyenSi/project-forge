"use client";

import { useState, useEffect } from "react";
import type { ProjectInput } from "@/lib/types";
import { Button, Input, Textarea, Label, Alert } from "@/components/ui/primitives";

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
  const [magicEnabled, setMagicEnabled] = useState(false);

  useEffect(() => {
    fetch("/api/ai-assist")
      .then((res) => res.json())
      .then((data) => setMagicEnabled(data.enabled))
      .catch(() => setMagicEnabled(false));
  }, []);

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
      const aiData = data.data as ProjectInput;
      setName(aiData.projectName || "");
      setSummary(aiData.summary || "");
      setFeaturesText(aiData.features?.join("\n") || "");
      setConstraintsText(aiData.constraints?.join("\n") || "");
      setTargetUsersText(aiData.targetUsers?.join("\n") || "");
      setMagicPrompt("");
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
      {magicEnabled && (
        <div className="rounded-md bg-purple-950/20 p-4">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
            </svg>
            <h3 className="font-semibold text-purple-300 text-sm">AI Magic Fill</h3>
          </div>
          <p className="text-xs text-gray-400 mb-3">
            Describe your project idea in one sentence. AI will fill the form for you.
          </p>
          <div className="flex gap-2">
            <Input
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
              className="flex-1 text-sm focus:border-purple-500 focus:ring-purple-500"
            />
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={handleMagicFill}
              disabled={!magicPrompt.trim() || isLoading}
              loading={magicLoading}
              className="bg-purple-600 hover:bg-purple-500"
            >
              Fill Form
            </Button>
          </div>
        </div>
      )}

      {formError && (
        <Alert variant="error" onClose={() => setFormError(null)}>{formError}</Alert>
      )}

      <div>
        <Label required>Project Name</Label>
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-awesome-project"
          required
        />
      </div>

      <div>
        <Label required>Summary</Label>
        <Textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="A brief description of what this project does and why it exists..."
          required
          rows={3}
        />
      </div>

      <div>
        <Label required hint="(one per line)">Core Features</Label>
        <Textarea
          value={featuresText}
          onChange={(e) => setFeaturesText(e.target.value)}
          placeholder={"user authentication\ndashboard with analytics\nREST API"}
          rows={4}
        />
      </div>

      <div>
        <Label hint="(one per line)">Constraints</Label>
        <Textarea
          value={constraintsText}
          onChange={(e) => setConstraintsText(e.target.value)}
          placeholder={"TypeScript only\nmust be deployable with Docker\nno external auth providers"}
          rows={3}
        />
      </div>

      <div>
        <Label required hint="(one per line)">Target Users</Label>
        <Textarea
          value={targetUsersText}
          onChange={(e) => setTargetUsersText(e.target.value)}
          placeholder={"developers\ninternal team"}
          rows={2}
        />
      </div>

      <Button
        type="submit"
        block
        size="lg"
        disabled={!name.trim() || !summary.trim()}
        loading={isLoading}
      >
        {isLoading ? "Generating..." : "Generate Project Plan"}
      </Button>
    </form>
  );
}
