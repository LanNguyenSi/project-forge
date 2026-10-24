"use client";

import {
  MutableRefObject,
  ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";

interface DialogShellProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  initialFocusRef?: MutableRefObject<HTMLElement | null>;
  /**
   * "center" (default) is the centred modal card. "drawer" is a full-height
   * left panel for the mobile navigation: same dialog semantics, Escape,
   * focus trap and focus return, but no card padding, no centring, and it
   * is hidden from the md breakpoint up where the desktop sidebar takes over.
   */
  variant?: "center" | "drawer";
  /** id of the dialog element, for an opener's aria-controls. */
  id?: string;
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

export function DialogShell({
  title,
  children,
  onClose,
  initialFocusRef,
  variant = "center",
  id,
}: DialogShellProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const dialog = dialogRef.current;
    const fallbackTarget =
      dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? dialog;
    const focusTarget = initialFocusRef?.current ?? fallbackTarget;

    focusTarget?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !dialogRef.current) {
        return;
      }

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((element) => !element.hasAttribute("disabled"));

      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (!active || active === first || !dialogRef.current.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }

      if (!active || active === last || !dialogRef.current.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [initialFocusRef, onClose]);

  const isDrawer = variant === "drawer";

  return (
    <div
      className={
        isDrawer
          ? "md:hidden fixed inset-0 z-50 bg-forge-void/60 backdrop-blur-xs"
          : "fixed inset-0 z-50 flex items-center justify-center bg-forge-void/70 p-4 backdrop-blur-xs"
      }
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={
          isDrawer
            ? "h-full w-64 bg-forge-iron border-r border-forge-steel flex flex-col focus:outline-hidden"
            : "w-full max-w-md rounded-card bg-forge-iron border border-forge-steel p-8 shadow-2xl focus:outline-hidden"
        }
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="sr-only">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
