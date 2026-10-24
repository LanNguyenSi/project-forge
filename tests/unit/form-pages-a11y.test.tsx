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
            ? { ok: true, githubPat: "" }
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
