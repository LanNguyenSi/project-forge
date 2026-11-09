import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const signInMock = vi.fn();
let query = "";

vi.mock("next-auth/react", () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(query),
}));
vi.mock("@/components/layout/PublicNav", () => ({ PublicNav: () => null }));

import LoginPage from "@/app/(dashboard)/login/page";
import { authErrorMessage } from "@/app/(dashboard)/login/auth-error-message";

beforeEach(() => {
  query = "";
  signInMock.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("login page error from the query string", () => {
  it("shows nothing without an error query", () => {
    render(<LoginPage />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows nothing for an empty error value", () => {
    query = "error=";
    render(<LoginPage />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("ignores other query parameters", () => {
    query = "callbackUrl=%2Fsettings";
    render(<LoginPage />);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    ["OAuthSignin", "Could not start the GitHub sign-in"],
    ["OAuthCallback", "The GitHub sign-in did not complete"],
    ["OAuthAccountNotLinked", "already registered with a different sign-in method"],
    ["CredentialsSignin", "Invalid email or password"],
    ["AccessDenied", "Access denied"],
    ["Callback", "Sign-in failed while setting up your account"],
  ])("maps %s to a human message in an error alert", (code, expected) => {
    query = `error=${code}`;
    render(<LoginPage />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(expected);
    expect(alert.textContent).not.toContain(code);
  });

  it("uses a generic message for an unknown code and never renders the raw value", () => {
    query = `error=${encodeURIComponent("<b>Hacked</b> by someone")}`;
    render(<LoginPage />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Sign-in failed. Please try again.");
    expect(alert.innerHTML).not.toContain("Hacked");
  });

  it.each(["constructor", "__proto__", "toString"])(
    "treats the Object.prototype name %s as an unknown code",
    (code) => {
      expect(authErrorMessage(code)).toBe("Sign-in failed. Please try again.");
    },
  );

  it("lets an error from the form win over the query error", async () => {
    query = "error=OAuthSignin";
    signInMock.mockResolvedValue({ error: "CredentialsSignin" });
    render(<LoginPage />);
    expect(screen.getByRole("alert").textContent).toContain("Could not start the GitHub sign-in");

    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "a@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await screen.findByText("Invalid email or password");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe("Invalid email or password");
  });
});

describe("login page query error is one-shot", () => {
  function submitWrongPassword() {
    fireEvent.change(screen.getByRole("textbox", { name: "Email" }), {
      target: { value: "a@example.test" },
    });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));
  }

  it("shows the query error on a fresh load", () => {
    query = "error=OAuthSignin";
    render(<LoginPage />);
    expect(screen.getByRole("alert").textContent).toContain("Could not start the GitHub sign-in");
  });

  it("drops the query error while a submit is pending", () => {
    query = "error=OAuthSignin";
    signInMock.mockReturnValue(new Promise(() => {}));
    render(<LoginPage />);
    submitWrongPassword();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not bring the query error back after a form error and a switch to register", async () => {
    query = "error=OAuthSignin";
    signInMock.mockResolvedValue({ error: "CredentialsSignin" });
    render(<LoginPage />);
    submitWrongPassword();
    await screen.findByText("Invalid email or password");

    fireEvent.click(screen.getByRole("button", { name: "Register" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeTruthy();
  });

  it("does not bring the query error back after switching back to sign in", () => {
    query = "error=OAuthSignin";
    render(<LoginPage />);
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops the query error on the first switch to register without any submit", () => {
    query = "error=AccessDenied";
    render(<LoginPage />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Register" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
