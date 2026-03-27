"use client";

import { useRef } from "react";
import { DialogShell } from "@/components/DialogShell";
import { Button } from "@/components/ui/primitives";

interface ErrorModalProps {
  title?: string;
  message: string;
  onClose: () => void;
}

export function ErrorModal({
  title = "Something went wrong",
  message,
  onClose,
}: ErrorModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  return (
    <DialogShell
      title={title}
      onClose={onClose}
      initialFocusRef={closeButtonRef}
    >
      <>
        <div className="text-center mb-6">
          <div className="h-12 w-12 rounded-md bg-red-600/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9.303 3.376c.866 1.5-.217 3.374-1.948 3.374H4.645c-1.73 0-2.813-1.874-1.948-3.374L10.051 3.378c.866-1.5 3.032-1.5 3.898 0l7.354 12.748zM12 15.75h.007v.008H12v-.008z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-white">{title}</h2>
          <p className="text-gray-400 text-sm mt-3">
            {message}
          </p>
        </div>

        <Button ref={closeButtonRef} block onClick={onClose}>
          Close
        </Button>
      </>
    </DialogShell>
  );
}
