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
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { email: "a-long-address-for-testing@example.test" } },
    status: "authenticated",
  }),
  signOut: vi.fn(),
}));

import { AppShell } from "@/components/layout/AppShell";

// Focus order is DOM order, so "first focusable element" is checked against the
// focusable elements the shell renders (links, buttons, [tabindex]).
function focusableIn(container: HTMLElement) {
  return Array.from(container.querySelectorAll("a[href], button, input, [tabindex]"));
}

describe("AppShell skip link", () => {
  it("renders a skip link whose href matches the id of the main landmark", () => {
    render(
      <AppShell>
        <p>page body</p>
      </AppShell>,
    );
    const link = screen.getByRole("link", { name: "Skip to main content" });
    const main = screen.getByRole("main");
    expect(main.id).toBe("main-content");
    expect(link.getAttribute("href")).toBe(`#${main.id}`);
    // main is not tabbable, so the browser only moves focus to it when it is
    // programmatically focusable
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("puts the skip link before the sidebar navigation in the focus order", () => {
    const { container } = render(
      <AppShell>
        <p>page body</p>
      </AppShell>,
    );
    const focusable = focusableIn(container);
    const link = screen.getByRole("link", { name: "Skip to main content" });
    expect(focusable[0]).toBe(link);
    // the sidebar navigation it is meant to jump over
    const dashboardLink = container.querySelector('a[href="/dashboard"]')!;
    expect(focusable.indexOf(dashboardLink)).toBeGreaterThan(0);
  });

  it("hides the skip link until it is focused", () => {
    render(
      <AppShell>
        <p>page body</p>
      </AppShell>,
    );
    const className = screen
      .getByRole("link", { name: "Skip to main content" })
      .getAttribute("class")!;
    expect(className).toContain("sr-only");
    expect(className).toContain("focus:not-sr-only");
  });
});

describe("AppShell sidebar account e-mail", () => {
  it("keeps the full address in the DOM and in the title of the truncated text", () => {
    render(
      <AppShell>
        <p>page body</p>
      </AppShell>,
    );
    const email = "a-long-address-for-testing@example.test";
    const text = screen.getByText(email);
    expect(text.getAttribute("title")).toBe(email);
    // the address is truncated visually by CSS only, never in the markup
    expect(text.className).toContain("truncate");
  });
});
