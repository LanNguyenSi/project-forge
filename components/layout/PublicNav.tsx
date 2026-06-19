"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { ForgeMark } from "@/components/layout/ForgeMark";

/**
 * Shared top-nav for all public pages (landing, login, public docs).
 *
 * Session-aware:
 *  - Unauthenticated: shows "Login" text link + "Get Started" primary button
 *  - Authenticated:   shows "Dashboard" primary button (user is likely redirecting away anyway)
 */
export function PublicNav() {
  const { status } = useSession();
  const isAuthed = status === "authenticated";

  return (
    <nav className="sticky top-0 z-30 border-b border-forge-steel bg-forge-void/95 backdrop-blur-sm px-6 py-4">
      <div className="flex items-center justify-between max-w-7xl mx-auto">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2.5 group">
          <ForgeMark className="h-6 w-6" />
          <span className="font-display font-semibold text-lg text-forge-mist tracking-tight group-hover:text-white transition-colors">
            project-forge
          </span>
        </Link>

        {/* Right-side links */}
        <div className="flex items-center gap-5 text-sm">
          <Link
            href="/docs"
            className="text-forge-ash hover:text-forge-mist transition-colors"
          >
            Docs
          </Link>

          {isAuthed ? (
            <Link
              href="/dashboard"
              className="rounded-btn bg-ember px-4 py-2 text-forge-void font-medium hover:bg-ember-soft transition-colors"
            >
              Dashboard
            </Link>
          ) : (
            <>
              <Link
                href="/login"
                className="text-forge-ash hover:text-forge-mist transition-colors"
              >
                Login
              </Link>
              <Link
                href="/login"
                className="rounded-btn bg-ember px-4 py-2 text-forge-void font-medium hover:bg-ember-soft transition-colors"
              >
                Get Started
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
