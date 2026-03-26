"use client";

import { useState } from "react";
import type { GenerationPreview, FileTreeNode } from "@/lib/types";
import { Button, Card, Badge } from "@/components/ui/primitives";

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
      <Card padding="none">
        {/* Header */}
        <div className="border-b border-gray-800 p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">{preview.projectName}</h2>
            <div className="flex items-center gap-2">
              <Badge>{preview.taskCount} tasks</Badge>
              <Badge>{preview.waveCount} waves</Badge>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-800">
          {(["tasks", "architecture", "files"] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-3 text-sm font-medium capitalize transition-colors ${
                activeTab === tab
                  ? "border-b-2 border-blue-500 text-blue-400"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Content */}
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
                        className="flex items-start gap-3 rounded px-3 py-2 hover:bg-gray-800/50 transition"
                      >
                        <span className="font-mono text-xs text-gray-500 w-8 mt-0.5 shrink-0">
                          {task.id}
                        </span>
                        <div className="flex-1 min-w-0">
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
      </Card>

      <div className="flex gap-3">
        <Button variant="secondary" size="lg" block disabled={isPublishing} onClick={onBack}>
          &lt;- Back &amp; Adjust
        </Button>
        <Button variant="success" size="lg" block disabled={isPublishing} loading={isPublishing} onClick={onConfirm}>
          {isPublishing ? "Creating repo..." : "Create GitHub Repo"}
        </Button>
      </div>
    </div>
  );
}

function FileTree({ nodes, depth = 0 }: { nodes: FileTreeNode[]; depth?: number }) {
  return (
    <div className={depth > 0 ? "ml-4 border-l border-gray-800 pl-3" : ""}>
      {nodes.map((node) => (
        <div key={node.path}>
          <div className="flex items-center gap-2 py-0.5 text-sm">
            <svg className={`w-4 h-4 shrink-0 ${node.type === "directory" ? "text-blue-400" : "text-gray-500"}`} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              {node.type === "directory" ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              )}
            </svg>
            <span className={node.type === "directory" ? "text-blue-300 font-medium" : "text-gray-300"}>
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
