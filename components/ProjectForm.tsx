"use client";

import { useState, useEffect } from "react";
import type { ProjectInput, Attachment } from "@/lib/types";
import { Button, Input, Textarea, Label, Alert } from "@/components/ui/primitives";

/**
 * Matches planforge's 50_000-char total-inlineText cap (v0.1b). We enforce
 * it client-side too so oversized uploads fail instantly in the UI instead
 * of making the round-trip just to be rejected. v0.1c only supports a
 * single file, so per-file === total.
 */
const MAX_ATTACHMENT_CHARS = 50_000;

/**
 * v0.1c text-tier only. `.adoc` is asciidoc — the CLI prompt templates
 * read the augmented summary as plain text so any of these extensions is
 * "good enough" to pass through unmodified. Binary tiers (pdf/png/svg/
 * drawio/puml) land in v0.2.
 */
const ACCEPTED_EXTENSIONS = [".md", ".txt", ".adoc"] as const;

const MIME_BY_EXTENSION: Record<string, string> = {
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".adoc": "text/asciidoc",
};

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
  // Which tab of the unified seed panel is active. Default: Prompt —
  // most users arrive with an idea, not a document. The File tab lets
  // existing-project onboarders drop an arc42 / charter / RFC and get
  // the form pre-filled without prose retyping.
  const [seedMode, setSeedMode] = useState<"prompt" | "file">("prompt");

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

  // Attachments state — v0.1c keeps it minimal: one optional text-tier
  // file. `null` means "no attachment selected" and no `attachments`
  // field is included in the submit payload (preserves pre-v0.1 wire
  // shape for the no-attachment case).
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    setAttachmentError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the <input> so selecting the same file twice (e.g. after a
    // removal) still fires onChange.
    e.target.value = "";

    const lowerName = file.name.toLowerCase();
    const ext = ACCEPTED_EXTENSIONS.find((x) => lowerName.endsWith(x));
    if (!ext) {
      setAttachmentError(
        `Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(", ")}`,
      );
      return;
    }

    try {
      const text = await file.text();
      if (text.length > MAX_ATTACHMENT_CHARS) {
        setAttachmentError(
          `File is ${text.length.toLocaleString()} chars; limit is ${MAX_ATTACHMENT_CHARS.toLocaleString()}. Split or shorten it.`,
        );
        return;
      }
      setAttachment({
        name: file.name,
        mimeType: MIME_BY_EXTENSION[ext],
        tier: "text",
        inlineText: text,
      });
    } catch (err) {
      setAttachmentError(
        `Could not read file: ${err instanceof Error ? err.message : "unknown error"}`,
      );
    }
  };

  const handleRemoveAttachment = () => {
    setAttachment(null);
    setAttachmentError(null);
  };

  // One handler dispatches on seedMode. In file mode the attachment
  // stays set so it rides along in the eventual submit payload (v0.1d
  // enrichment + v0.2a persist both still run on the raw document).
  const handleMagicFill = async () => {
    const body =
      seedMode === "file"
        ? (() => {
            if (!attachment || !attachment.inlineText) return null;
            return {
              mode: "file" as const,
              fileContent: attachment.inlineText,
              fileName: attachment.name,
            };
          })()
        : magicPrompt.trim()
          ? { mode: "prompt" as const, prompt: magicPrompt }
          : null;
    if (!body) return;

    setMagicLoading(true);
    setFormError(null);
    try {
      const res = await fetch("/api/ai-assist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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
      // Only clear the prompt on prompt-mode success. The attachment
      // stays on purpose (see comment above).
      if (seedMode === "prompt") setMagicPrompt("");
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : "Failed to connect to AI service");
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
      // Only include `attachments` when the user actually selected a file;
      // the route and planforge both special-case absence to preserve the
      // pre-v0.1 wire shape.
      ...(attachment ? { attachments: [attachment] } : {}),
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Unified Magic-Fill Seed (Prompt | File) */}
      {magicEnabled && (
        <div className="rounded-md bg-purple-950/20 p-4">
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
            </svg>
            <h3 className="font-semibold text-purple-300 text-sm">AI Magic Fill</h3>
          </div>
          <p className="text-xs text-gray-400 mb-3">
            Seed the form with a one-line prompt, or upload a document (arc42, RFC, charter) to extract the intake.
          </p>

          {/* Tab switcher. Two equal-width buttons; the active one gets
              the purple-accent border. Keyboard: ArrowLeft/Right cycles
              when focus is on the tablist. */}
          <div
            role="tablist"
            aria-label="Seed source"
            className="flex gap-1 mb-3 rounded-md border border-purple-900/40 bg-purple-950/40 p-1 text-xs"
          >
            {(["prompt", "file"] as const).map((mode) => {
              const active = seedMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`seed-panel-${mode}`}
                  onClick={() => setSeedMode(mode)}
                  onKeyDown={(e) => {
                    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                      e.preventDefault();
                      setSeedMode(mode === "prompt" ? "file" : "prompt");
                    }
                  }}
                  disabled={magicLoading || isLoading}
                  className={
                    "flex-1 rounded px-3 py-1.5 font-medium transition " +
                    (active
                      ? "bg-purple-600/30 text-purple-100 ring-1 ring-purple-500/60"
                      : "text-purple-300 hover:bg-purple-900/40")
                  }
                >
                  {mode === "prompt" ? "Prompt" : "File"}
                </button>
              );
            })}
          </div>

          {seedMode === "prompt" ? (
            <div id="seed-panel-prompt" role="tabpanel" className="flex gap-2">
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
          ) : (
            <div id="seed-panel-file" role="tabpanel" className="space-y-2">
              {attachment ? (
                <div className="flex items-center justify-between rounded-md bg-gray-900/60 border border-gray-800 px-3 py-2 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <svg
                      className="w-4 h-4 text-gray-400 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={1.5}
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                      />
                    </svg>
                    <span className="truncate font-mono text-gray-300" title={attachment.name}>
                      {attachment.name}
                    </span>
                    <span className="text-xs text-gray-500 shrink-0">
                      {(attachment.inlineText?.length ?? 0).toLocaleString()} chars
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleRemoveAttachment}
                    disabled={magicLoading || isLoading}
                    aria-label={`Remove attachment ${attachment.name}`}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <Input
                  type="file"
                  accept={ACCEPTED_EXTENSIONS.join(",")}
                  onChange={handleFileSelect}
                  disabled={magicLoading || isLoading}
                />
              )}
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-gray-500">
                  Accepted: {ACCEPTED_EXTENSIONS.join(", ")} — 50k char limit. The document rides along to the planner after form extraction.
                </p>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={handleMagicFill}
                  disabled={!attachment || isLoading}
                  loading={magicLoading}
                  className="bg-purple-600 hover:bg-purple-500 shrink-0"
                >
                  Fill Form
                </Button>
              </div>
              {attachmentError && (
                <p className="text-xs text-red-400" role="alert">
                  {attachmentError}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Standing chip: even after the File tab successfully populates
          the form, users stay on whichever tab they're switching between.
          This persistent chip reminds them the attachment will still
          ride along on submit (v0.1d enrichment + v0.2a persist), so
          they don't think "I already filled the form, the doc is gone". */}
      {magicEnabled && attachment && seedMode === "prompt" && (
        <div className="flex items-center justify-between rounded-md bg-gray-900/40 border border-gray-800 px-3 py-2 text-xs">
          <span className="text-gray-400">
            Attached for planner: <span className="font-mono text-gray-300">{attachment.name}</span>{" "}
            <span className="text-gray-500">
              ({(attachment.inlineText?.length ?? 0).toLocaleString()} chars)
            </span>
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleRemoveAttachment}
            disabled={isLoading}
            aria-label={`Remove attachment ${attachment.name}`}
          >
            Remove
          </Button>
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
