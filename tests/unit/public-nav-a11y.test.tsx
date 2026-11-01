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

describe("PublicNav skip link", () => {
  it("renders a skip link whose href matches the id of the page main landmark", () => {
    // The public pages (landing, login, public docs) wrap their own <main>
    // around this nav; that element carries the skip-link target.
    render(
      <main id="main-content" tabIndex={-1}>
        <PublicNav />
      </main>,
    );
    const link = screen.getByRole("link", { name: "Skip to main content" });
    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
    expect(link.getAttribute("href")).toBe(`#${main.id}`);
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("puts the skip link before the navigation links in the focus order", () => {
    const { container } = render(
      <main id="main-content" tabIndex={-1}>
        <PublicNav />
      </main>,
    );
    // `<main tabindex="-1">` is the focus target, not a tab stop, so only links
    // and buttons are in the tab order here
    const focusable = Array.from(container.querySelectorAll("a[href], button"));
    const link = screen.getByRole("link", { name: "Skip to main content" });
    expect(focusable[0]).toBe(link);
    expect(focusable.indexOf(container.querySelector('a[href="/"]')!)).toBe(1);
  });

  it("keeps the skip link out of the navigation landmark and hidden until focused", () => {
    render(
      <main id="main-content" tabIndex={-1}>
        <PublicNav />
      </main>,
    );
    const link = screen.getByRole("link", { name: "Skip to main content" });
    expect(screen.getByRole("navigation").contains(link)).toBe(false);
    const className = link.getAttribute("class")!;
    expect(className).toContain("sr-only");
    expect(className).toContain("focus:not-sr-only");
  });
});
