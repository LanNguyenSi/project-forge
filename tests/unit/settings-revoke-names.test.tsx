import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: { user: { email: "a@example.test" } }, status: "authenticated" }),
  signOut: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/settings",
}));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import SettingsPage from "@/app/(dashboard)/settings/page";

const tokens = [
  { id: "t1", name: "ci-pipeline", tokenPrefix: "pf_aaaaaaa", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" },
  { id: "t2", name: "release-bot", tokenPrefix: "pf_bbbbbbb", lastUsedAt: null, createdAt: "2026-01-02T00:00:00Z" },
];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes("/pat") ? { ok: true, githubPat: "" } : { ok: true, tokens, user: {} },
    })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("settings page Revoke buttons", () => {
  it("gives each Revoke button a name that includes its token name", async () => {
    render(<SettingsPage />);
    const first = await screen.findByRole("button", { name: "Revoke ci-pipeline" });
    const second = screen.getByRole("button", { name: "Revoke release-bot" });
    expect(first).not.toBe(second);
    // exactly one button per token, none left with the bare name
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("keeps the visible text as Revoke", async () => {
    render(<SettingsPage />);
    const button = await screen.findByRole("button", { name: "Revoke ci-pipeline" });
    expect(button.textContent).toBe("Revoke");
    await waitFor(() => expect(screen.getAllByRole("button", { name: /^Revoke / })).toHaveLength(2));
  });
});
