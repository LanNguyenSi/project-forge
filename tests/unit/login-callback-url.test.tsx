import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const signInMock = vi.fn();
const pushMock = vi.fn();

vi.mock("next-auth/react", () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/components/layout/PublicNav", () => ({ PublicNav: () => null }));

import LoginPage from "@/app/(dashboard)/login/page";

function visit(search: string) {
  window.history.replaceState(null, "", `/login${search}`);
}

function submitCredentials() {
  fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
    target: { value: "a@example.test" },
  });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "right-password" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
}

beforeEach(() => {
  signInMock.mockReset();
  pushMock.mockReset();
  signInMock.mockResolvedValue({ ok: true });
});
afterEach(() => {
  visit("");
  vi.restoreAllMocks();
});

describe("login page after a credentials sign-in", () => {
  it("goes to the callbackUrl deep link", async () => {
    visit(`?callbackUrl=${encodeURIComponent("/create")}`);
    render(<LoginPage />);
    submitCredentials();
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(pushMock).toHaveBeenCalledWith("/create");
  });

  it("keeps the query of the callbackUrl", async () => {
    visit(`?callbackUrl=${encodeURIComponent("/settings?tab=tokens")}`);
    render(<LoginPage />);
    submitCredentials();
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(pushMock).toHaveBeenCalledWith("/settings?tab=tokens");
  });

  it("goes to /dashboard without a callbackUrl", async () => {
    visit("");
    render(<LoginPage />);
    submitCredentials();
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(pushMock).toHaveBeenCalledWith("/dashboard");
  });

  it("goes to /dashboard for an empty callbackUrl", async () => {
    visit("?callbackUrl=");
    render(<LoginPage />);
    submitCredentials();
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(pushMock).toHaveBeenCalledWith("/dashboard");
  });

  it("goes to /dashboard for a protocol-relative callbackUrl", async () => {
    visit(`?callbackUrl=${encodeURIComponent("//evil.test")}`);
    render(<LoginPage />);
    submitCredentials();
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(pushMock).toHaveBeenCalledWith("/dashboard");
  });

  it("goes to /dashboard for an absolute callbackUrl", async () => {
    visit(`?callbackUrl=${encodeURIComponent("https://evil.test/create")}`);
    render(<LoginPage />);
    submitCredentials();
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(pushMock).toHaveBeenCalledWith("/dashboard");
  });

  it("does not navigate when the sign-in fails", async () => {
    signInMock.mockResolvedValue({ error: "CredentialsSignin" });
    visit(`?callbackUrl=${encodeURIComponent("/create")}`);
    render(<LoginPage />);
    submitCredentials();
    await screen.findByText("Invalid email or password");
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("login page GitHub sign-in", () => {
  function clickGithub() {
    fireEvent.click(screen.getByRole("button", { name: /Continue with GitHub/ }));
  }

  it("passes the callbackUrl deep link to signIn", () => {
    visit(`?callbackUrl=${encodeURIComponent("/settings?tab=tokens")}`);
    render(<LoginPage />);
    clickGithub();
    expect(signInMock).toHaveBeenCalledWith("github", { callbackUrl: "/settings?tab=tokens" });
  });

  it("passes /dashboard without a callbackUrl", () => {
    visit("");
    render(<LoginPage />);
    clickGithub();
    expect(signInMock).toHaveBeenCalledWith("github", { callbackUrl: "/dashboard" });
  });

  it("passes /dashboard for a rejected callbackUrl", () => {
    visit(`?callbackUrl=${encodeURIComponent("/\\evil.test")}`);
    render(<LoginPage />);
    clickGithub();
    expect(signInMock).toHaveBeenCalledWith("github", { callbackUrl: "/dashboard" });
  });
});
