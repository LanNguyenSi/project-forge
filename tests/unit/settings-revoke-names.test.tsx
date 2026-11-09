import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

// Two tokens with the same name, only the prefix tells them apart.
const duplicateNames = [
  { id: "d1", name: "ci-pipeline", tokenPrefix: "pf_aaaaaaa", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" },
  { id: "d2", name: "ci-pipeline", tokenPrefix: "pf_bbbbbbb", lastUsedAt: null, createdAt: "2026-01-02T00:00:00Z" },
];

let servedTokens = tokens;

beforeEach(() => {
  servedTokens = tokens;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.includes("/pat")
          ? { ok: true, githubPat: "" }
          : { ok: true, tokens: servedTokens, user: {} },
    })),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("settings page Revoke buttons", () => {
  it("gives each Revoke button a name that includes its token name and prefix", async () => {
    render(<SettingsPage />);
    const first = await screen.findByRole("button", {
      name: "Revoke token ci-pipeline, prefix pf_aaaaaaa",
    });
    const second = screen.getByRole("button", {
      name: "Revoke token release-bot, prefix pf_bbbbbbb",
    });
    expect(first).not.toBe(second);
    // exactly one button per token, none left with the bare name
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("keeps the visible text as Revoke", async () => {
    render(<SettingsPage />);
    const button = await screen.findByRole("button", {
      name: "Revoke token ci-pipeline, prefix pf_aaaaaaa",
    });
    expect(button.textContent).toBe("Revoke");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^Revoke token / })).toHaveLength(2),
    );
  });

  it("names two tokens that share a name apart by their prefix", async () => {
    servedTokens = duplicateNames;
    render(<SettingsPage />);
    await screen.findByRole("button", {
      name: "Revoke token ci-pipeline, prefix pf_aaaaaaa",
    });
    const first = screen.getAllByRole("button", {
      name: "Revoke token ci-pipeline, prefix pf_aaaaaaa",
    });
    const second = screen.getAllByRole("button", {
      name: "Revoke token ci-pipeline, prefix pf_bbbbbbb",
    });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]).not.toBe(second[0]);
  });

  it("names the prefix of the chosen token in the confirm dialog", async () => {
    servedTokens = duplicateNames;
    render(<SettingsPage />);
    const chosen = await screen.findByRole("button", {
      name: "Revoke token ci-pipeline, prefix pf_bbbbbbb",
    });
    fireEvent.click(chosen);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/pf_bbbbbbb/)).toBeTruthy();
    expect(within(dialog).queryByText(/pf_aaaaaaa/)).toBeNull();
  });
});
