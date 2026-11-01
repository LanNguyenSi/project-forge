"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { ForgeMark } from "@/components/layout/ForgeMark";

// WCAG 2.4.1 bypass link for the public pages: `<main>` of the page that
// renders this nav carries the id, and the link is the first focusable element.
// AppShell renders the same link for the dashboard pages; keep the id, label
// and classes in sync between the two files.
const MAIN_CONTENT_ID = "main-content";
// Hidden until focused (sr-only), then a light chip with an ember ring so it
// stays readable on the dark page at any z-position.
const SKIP_LINK_CLASS =
  "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] " +
  "focus:rounded-btn focus:bg-forge-mist focus:px-4 focus:py-2 focus:text-sm focus:font-semibold " +
  "focus:text-forge-void focus:outline-hidden focus:ring-2 focus:ring-ember focus:ring-offset-2 focus:ring-offset-forge-void";

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
  const onLoginPage = usePathname() === "/login";

  return (
    <>
      {/* Outside the <nav> so the link is not announced inside the navigation
          landmark it helps the user skip */}
      <a href={`#${MAIN_CONTENT_ID}`} className={SKIP_LINK_CLASS}>
        Skip to main content
      </a>
      <nav className="sticky top-0 z-30 border-b border-forge-steel bg-forge-void/95 backdrop-blur-xs px-6 py-4">
        <div className="flex items-center justify-between max-w-7xl mx-auto">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 group">
            <ForgeMark className="h-6 w-6" />
            <span className="font-display font-semibold text-lg text-forge-mist tracking-tight group-hover:text-gold transition-colors">
              project-forge
            </span>
          </Link>

          {/* Right-side links */}
          <div className="flex items-center gap-5 text-sm">
            <Link
              href="/docs"
              className="inline-flex min-h-9 items-center text-forge-ash hover:text-forge-mist transition-colors"
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
              !onLoginPage && (
                <>
                  <Link
                    href="/login"
                    className="inline-flex min-h-9 items-center text-forge-ash hover:text-forge-mist transition-colors"
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
              )
            )}
          </div>
        </div>
      </nav>
    </>
  );
}
