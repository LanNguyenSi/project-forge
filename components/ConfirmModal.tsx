"use client";

import { useEffect } from "react";

interface ConfirmModalProps {
  projectName: string;
  taskCount: number;
  waveCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  projectName,
  taskCount,
  waveCount,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-gray-700 bg-gray-900 p-8 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center mb-6">
          <div className="text-4xl mb-3">🚀</div>
          <h2 className="text-xl font-semibold text-white">Create GitHub Repository?</h2>
          <p className="text-gray-400 text-sm mt-2">
            This will create a public repository and push the scaffold. This cannot be undone.
          </p>
        </div>

        <div className="rounded-xl border border-gray-700 bg-gray-800 p-4 mb-6 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-400">Repository</span>
            <span className="text-gray-100 font-mono">{projectName}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Tasks</span>
            <span className="text-gray-100">{taskCount} tasks</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Waves</span>
            <span className="text-gray-100">{waveCount} waves</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Visibility</span>
            <span className="text-green-400">Public</span>
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 rounded-lg border border-gray-700 px-4 py-2.5 text-gray-300 hover:bg-gray-800 transition"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 font-semibold text-white hover:bg-green-500 transition"
          >
            Create Repository
          </button>
        </div>
      </div>
    </div>
  );
}
