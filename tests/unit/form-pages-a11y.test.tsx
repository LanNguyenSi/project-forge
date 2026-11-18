import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const signInMock = vi.fn();
const sessionState: { status: string; data: unknown } = {
  status: "authenticated",
  data: { user: { email: "a@example.test" } },
};

vi.mock("next-auth/react", () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
  signOut: vi.fn(),
  useSession: () => sessionState,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/login",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/layout/PublicNav", () => ({ PublicNav: () => null }));
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import LoginPage from "@/app/(dashboard)/login/page";
import SettingsPage from "@/app/(dashboard)/settings/page";

describe("login page accessible names", () => {
  beforeEach(() => signInMock.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it("exposes email and password fields by label", () => {
    render(<LoginPage />);
    expect(screen.getByRole("textbox", { name: "Email" })).toBeTruthy();
    // password inputs have no ARIA textbox role; the label is the name
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("keeps the names in register mode", () => {
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(screen.getByRole("textbox", { name: "Email" })).toBeTruthy();
    expect(screen.getByLabelText("Password")).toBeTruthy();
  });

  it("announces a failed sign-in as role=alert", async () => {
    signInMock.mockResolvedValue({ error: "CredentialsSignin" });
    render(<LoginPage />);
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "a@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Invalid email or password");
  });
});

describe("settings page accessible names", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () =>
          url.includes("/pat")
            ? { ok: true, connected: false, kind: null }
            : { ok: true, tokens: [], user: {} },
      })),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("names the PAT and token-name fields", async () => {
    render(<SettingsPage />);
    await waitFor(() => expect(screen.getByLabelText("GitHub personal access token")).toBeTruthy());
    expect(screen.getByRole("textbox", { name: "API token name" })).toBeTruthy();
  });

  it("announces a validation error as role=alert", async () => {
    render(<SettingsPage />);
    const btn = await screen.findByRole("button", { name: "Create Token" });
    fireEvent.click(btn);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Token name is required");
  });
});

describe("settings page PAT handling", () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  // The mocked router is a new object per render, which re-runs the load
  // effect, so the GET answer follows the server state after a POST.
  const mockFetch = (initial: { connected: boolean; kind: string | null }) => {
    let pat = initial;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: true,
          json: async () =>
            url.includes("/pat")
              ? init?.method === "POST"
                ? ((pat = { connected: true, kind: "manual" }), { ok: true })
                : { ok: true, ...pat }
              : { ok: true, tokens: [], user: {} },
        };
      }),
    );
  };
  beforeEach(() => {
    calls.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the saved state for a manual PAT with an empty input", async () => {
    mockFetch({ connected: true, kind: "manual" });
    render(<SettingsPage />);
    await screen.findByTestId("pat-connected-state");
    expect(screen.getByText("Connected via PAT")).toBeTruthy();
    expect((screen.getByLabelText("GitHub personal access token") as HTMLInputElement).value).toBe("");
  });

  it("shows the OAuth state when the token kind is oauth", async () => {
    mockFetch({ connected: true, kind: "oauth" });
    render(<SettingsPage />);
    await screen.findByText("Connected via OAuth");
    expect(screen.queryByLabelText("GitHub personal access token")).toBeNull();
  });

  it("does not post when nothing was typed", async () => {
    mockFetch({ connected: true, kind: "manual" });
    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Replace PAT" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Enter a GitHub PAT");
    expect(calls.filter((c) => c.init?.method === "POST")).toHaveLength(0);
  });

  it("posts only the typed value and clears the input afterwards", async () => {
    mockFetch({ connected: false, kind: null });
    render(<SettingsPage />);
    const input = (await screen.findByLabelText("GitHub personal access token")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  ghp_typedNew " } });
    fireEvent.click(screen.getByRole("button", { name: "Save PAT" }));
    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST")).toBe(true));
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ githubPat: "ghp_typedNew" });
    await screen.findByText("Connected via PAT");
    expect(input.value).toBe("");
  });
});
