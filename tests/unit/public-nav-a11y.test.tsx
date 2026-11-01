import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
}));

import { PublicNav } from "@/components/layout/PublicNav";

// The public pages render this nav before their own <main> (the skip-link
// target), never inside it; a wrapper that put the nav inside <main> would make
// the link a child of its own target and the defect would stay invisible.
function PublicPage() {
  return (
    <>
      <PublicNav />
      <main id="main-content" tabIndex={-1}>
        <p>page body</p>
      </main>
    </>
  );
}

describe("PublicNav skip link", () => {
  it("renders a skip link whose href matches the id of the page main landmark", () => {
    render(<PublicPage />);
    const link = screen.getByRole("link", { name: "Skip to main content" });
    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
    expect(link.getAttribute("href")).toBe(`#${main.id}`);
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("keeps the skip link outside the target it points at", () => {
    render(<PublicPage />);
    const link = screen.getByRole("link", { name: "Skip to main content" });
    const main = screen.getByRole("main");
    // A link inside its own target cannot bypass anything: focus would land on
    // the target and the next Tab would come back to the link.
    expect(main.contains(link)).toBe(false);
    expect(screen.getByRole("navigation").contains(link)).toBe(false);
  });

  it("puts the skip link before the navigation links in the focus order", () => {
    const { container } = render(<PublicPage />);
    // `<main tabindex="-1">` is the focus target, not a tab stop, so only links
    // and buttons are in the tab order here
    const focusable = Array.from(container.querySelectorAll("a[href], button"));
    const link = screen.getByRole("link", { name: "Skip to main content" });
    expect(focusable[0]).toBe(link);
    expect(focusable.indexOf(container.querySelector('a[href="/"]')!)).toBe(1);
  });

  it("keeps the skip link hidden until it is focused", () => {
    render(<PublicPage />);
    const className = screen
      .getByRole("link", { name: "Skip to main content" })
      .getAttribute("class")!;
    expect(className).toContain("sr-only");
    expect(className).toContain("focus:not-sr-only");
  });
});
