import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import * as fs from "fs";
import * as path from "path";

const sessionState: { status: string; data: unknown } = {
  status: "unauthenticated",
  data: null,
};

vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
  signOut: vi.fn(),
  useSession: () => sessionState,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

vi.mock("@/components/layout/PublicNav", () => ({ PublicNav: () => null }));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import LandingPage from "@/app/page";
import SettingsPage from "@/app/(dashboard)/settings/page";

// A horizontally scrollable code region has to be reachable by keyboard, carry
// an accessible name and a visible focus ring (axe scrollable-region-focusable).
// The name needs a role that accepts one, so the group role is required too
// (axe aria-prohibited-attr rejects aria-label on a bare pre or code); group,
// unlike region, adds no landmark per code block.
function expectFocusableCodeRegion(el: Element | null, label: string) {
  expect(el, label).not.toBeNull();
  expect(el!.className).toContain("overflow-x-auto");
  expect(el!.getAttribute("tabindex")).toBe("0");
  expect(el!.getAttribute("role")).toBe("group");
  expect(el!.getAttribute("aria-label")).toBeTruthy();
  expect(el!.className).toContain("focus-visible:ring-2");
}

describe("landing page code block", () => {
  beforeEach(() => {
    sessionState.status = "unauthenticated";
    sessionState.data = null;
  });

  it("makes the curl sample a focusable scroll region", () => {
    const { container } = render(<LandingPage />);
    const pres = Array.from(container.querySelectorAll("pre"));
    expect(pres.length).toBe(1);
    expectFocusableCodeRegion(pres[0], "curl sample");
  });
});

describe("settings page API quick reference", () => {
  beforeEach(() => {
    sessionState.status = "authenticated";
    sessionState.data = { user: { email: "a@example.test" } };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.includes("/pat")
            ? { ok: true, githubPat: "" }
            : { ok: true, tokens: [], user: {} },
      })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionState.status = "unauthenticated";
    sessionState.data = null;
  });

  it("makes the request-body sample a focusable scroll region", async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => expect(container.querySelector("pre")).toBeTruthy());
    const pres = Array.from(container.querySelectorAll("pre"));
    expect(pres.length).toBe(1);
    expectFocusableCodeRegion(pres[0], "request body sample");
  });

  it("keeps the endpoint and headers chips wrapping instead of scrolling", async () => {
    const { container } = render(<SettingsPage />);
    await waitFor(() => expect(container.querySelector("pre")).toBeTruthy());
    const chips = Array.from(container.querySelectorAll("code")).filter((c) =>
      /POST https|X-API-Key/.test(c.textContent ?? ""),
    );
    expect(chips.length).toBe(2);
    for (const chip of chips) {
      expect(chip.className).toContain("break-all");
      // A scroll region would need tabIndex too; these must wrap instead.
      expect(chip.className).not.toContain("overflow-x-auto");
      expect(chip.hasAttribute("tabindex")).toBe(false);
    }
  });
});

// The create screen reaches its clone-command chip only after a real publish,
// so no mount can reach it; a structural guard reads the element's opening tag
// from the source instead (same shape as tests/unit/error-shape-guard.test.ts).
describe("create page clone command (source guard)", () => {
  it("makes the scrollable git clone line a named focusable region", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/(dashboard)/create/page.tsx"),
      "utf8",
    );
    const content = source.indexOf("git clone {repoUrl}");
    expect(content).toBeGreaterThan(-1);
    const opening = source.slice(source.lastIndexOf("<code", content), content);
    expect(opening).toContain("tabIndex={0}");
    expect(opening).toContain('role="group"');
    expect(opening).toContain("aria-label=");
    expect(opening).toContain("overflow-x-auto");
    // min-w-0 lets the flex item shrink so the region scrolls inside itself.
    expect(opening).toContain("min-w-0");
    expect(opening).toContain("focus-visible:ring-2");
  });
});
