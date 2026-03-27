"use client";

import { useRef } from "react";
import { DialogShell } from "@/components/DialogShell";
import { Button } from "@/components/ui/primitives";

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
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <DialogShell
      title="Create GitHub Repository?"
      onClose={onCancel}
      initialFocusRef={cancelButtonRef}
    >
      <>
        <div className="text-center mb-6">
          <div className="h-12 w-12 rounded-md bg-green-600/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-white">Create GitHub Repository?</h2>
          <p className="text-gray-400 text-sm mt-2">
            This will create a public repository and push the scaffold.
          </p>
        </div>

        <div className="rounded-md bg-gray-800 p-4 mb-6 space-y-2.5 text-sm">
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
          <Button ref={cancelButtonRef} variant="secondary" block onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="success" block onClick={onConfirm}>
            Create Repository
          </Button>
        </div>
      </>
    </DialogShell>
  );
}
