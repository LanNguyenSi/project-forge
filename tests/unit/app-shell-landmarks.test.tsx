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
    data: { user: { email: "ui-test@example.test" } },
    status: "authenticated",
  }),
  signOut: vi.fn(),
}));

import { AppShell } from "@/components/layout/AppShell";

describe("AppShell landmark structure", () => {
  it("exposes the mobile top bar as a banner rendered with the header element", () => {
    render(
      <AppShell>
        <p>page body</p>
      </AppShell>,
    );
    const banners = screen.getAllByRole("banner");
    expect(banners).toHaveLength(1);
    expect(banners[0].tagName).toBe("HEADER");
    expect(banners[0].querySelector('[aria-label="Open navigation menu"]')).toBeTruthy();
    // md:hidden removes it from the accessibility tree on desktop, and the
    // desktop shell itself (aside + main) adds no banner, so a page never
    // shows two banners in one viewport.
    expect(banners[0].className).toContain("md:hidden");
  });

  it("keeps the desktop sidebar and page content out of the banner", () => {
    render(
      <AppShell>
        <p>page body</p>
      </AppShell>,
    );
    expect(screen.getAllByRole("banner")).toHaveLength(1);
    expect(screen.getAllByRole("complementary")).toHaveLength(1);
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });
});
