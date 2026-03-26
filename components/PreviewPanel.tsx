"use client";

import { useState } from "react";
import type { GenerationPreview, FileTreeNode } from "@/lib/types";

interface PreviewPanelProps {
  preview: GenerationPreview;
  onConfirm: () => void;
  onBack: () => void;
  isPublishing?: boolean;
}

export function PreviewPanel({
  preview,
  onConfirm,
  onBack,
  isPublishing = false,
}: PreviewPanelProps) {
  const [activeTab, setActiveTab] = useState<"tasks" | "architecture" | "files">("tasks");

  const waveGroups = preview.tasks.reduce<Record<string, typeof preview.tasks>>(
    (acc, task) => {
      const wave = task.wave ?? "wave-1";
      if (!acc[wave]) acc[wave] = [];
      acc[wave].push(task);
      return acc;
    },
    {}
  );

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-700 bg-gray-900">
        <div className="border-b border-gray-700 p-6">
          <h2 className="text-xl font-semibold">{preview.projectName}</h2>
          <p className="text-gray-400 text-sm mt-1">
            {preview.taskCount} tasks · {preview.waveCount} waves
          </p>
        </div>

        <div className="flex border-b border-gray-700">
          {(["tasks", "architecture", "files"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-3 text-sm font-medium capitalize transition ${
                activeTab === tab
                  ? "border-b-2 border-blue-500 text-blue-400"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="p-6 max-h-96 overflow-y-auto">
          {activeTab === "tasks" && (
            <div className="space-y-4">
              {Object.entries(waveGroups).sort().map(([wave, tasks]) => (
                <div key={wave}>
                  <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                    {wave.replace("-", " ")}
                  </h3>
                  <div className="space-y-1">
                    {tasks.map((task) => (
                      <div
                        key={task.id}
                        className="flex items-start gap-3 rounded-lg px-3 py-2 hover:bg-gray-800 transition"
                      >
                        <span className="font-mono text-xs text-gray-500 w-8 mt-0.5 shrink-0">
                          {task.id}
                        </span>
                        <div>
                          <p className="text-sm text-gray-200">{task.title}</p>
                          {task.summary && (
                            <p className="text-xs text-gray-500 mt-0.5">{task.summary}</p>
                          )}
                        </div>
                        <span className="ml-auto text-xs text-gray-600 shrink-0">{task.category}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === "architecture" && (
            <pre className="text-sm text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
              {preview.architectureOverview || "(No architecture overview generated)"}
            </pre>
          )}

          {activeTab === "files" && (
            <FileTree nodes={preview.fileTree} />
          )}
        </div>
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          disabled={isPublishing}
          className="flex-1 rounded-lg border border-gray-700 px-4 py-3 text-gray-300 hover:bg-gray-800 transition disabled:opacity-50"
        >
          ← Back & Adjust
        </button>
        <button
          onClick={onConfirm}
          disabled={isPublishing}
          className="flex-1 rounded-lg bg-green-600 px-4 py-3 font-semibold text-white hover:bg-green-500 transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPublishing ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Creating repo...
            </span>
          ) : (
            "Create GitHub Repo →"
          )}
        </button>
      </div>
    </div>
  );
}

function FileTree({ nodes, depth = 0 }: { nodes: FileTreeNode[]; depth?: number }) {
  return (
    <div className={depth > 0 ? "ml-4 border-l border-gray-800 pl-3" : ""}>
      {nodes.map((node) => (
        <div key={node.path}>
          <div className="flex items-center gap-1.5 py-0.5 text-sm">
            <span className="text-gray-500 text-xs">
              {node.type === "directory" ? "📁" : "📄"}
            </span>
            <span className={node.type === "directory" ? "text-blue-300" : "text-gray-300"}>
              {node.name}
            </span>
          </div>
          {node.children && node.children.length > 0 && (
            <FileTree nodes={node.children} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  );
}
