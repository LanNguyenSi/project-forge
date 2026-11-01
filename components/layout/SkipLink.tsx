"use client";

// WCAG 2.4.1 bypass link, shared by the two layouts so the label, the target id
// and the styles cannot drift apart: `AppShell` renders it before the mobile top
// bar and the sidebar navigation, `PublicNav` renders it before the public top
// nav. Every page that renders one of those layouts carries `MAIN_CONTENT_ID`
// and `tabIndex={-1}` on the `<main>` that follows the nav, so the link sits
// outside its own target and activating it lands past the navigation.
export const MAIN_CONTENT_ID = "main-content";

// Hidden until focused (sr-only), then a light chip with an ember ring so it
// stays readable on the dark scheme at any z-position on the page.
const SKIP_LINK_CLASS =
  "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] " +
  "focus:rounded-btn focus:bg-forge-mist focus:px-4 focus:py-2 focus:text-sm focus:font-semibold " +
  "focus:text-forge-void focus:outline-hidden focus:ring-2 focus:ring-ember focus:ring-offset-2 focus:ring-offset-forge-void";

export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className={SKIP_LINK_CLASS}
      // Moving focus by hand, because the fragment target is not portable: on
      // `/docs` the browser sets the hash and leaves the focus on the link, so
      // the next Tab lands in the navigation the link just skipped over. The
      // default action is not prevented, so the hash and the scroll position
      // still follow the link.
      onClick={() => document.getElementById(MAIN_CONTENT_ID)?.focus()}
    >
      Skip to main content
    </a>
  );
}
