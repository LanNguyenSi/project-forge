"use client";

import { useId } from "react";

interface ForgeMarkProps {
  className?: string;
}

/**
 * Minimal Forge brand mark — an ember-to-gold flame/spark glyph.
 * Used in PublicNav and AppShell.
 */
export function ForgeMark({ className = "h-5 w-5" }: ForgeMarkProps) {
  const uid = useId();
  // useId returns strings like ":r0:", clean to a valid SVG id (must start with letter)
  const gradId = `fm${uid.replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={gradId}
          x1="10"
          y1="18"
          x2="11"
          y2="1"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#F5641E" />
          <stop offset="100%" stopColor="#FFB02E" />
        </linearGradient>
      </defs>
      {/* Outer flame — ember to gold */}
      <path
        d="M10 1.5C7.5 7 5 8 6.5 12.5C7.5 15.5 10 16.5 10 16.5C10 16.5 12.5 15.5 13.5 12.5C15 8 12.5 7 10 1.5Z"
        fill={`url(#${gradId})`}
      />
      {/* Inner highlight — hot core */}
      <path
        d="M10 12C9.4 10.5 9.2 9 10 8C10.8 9 10.6 10.5 10 12Z"
        fill="#FFB02E"
        fillOpacity="0.45"
      />
    </svg>
  );
}
