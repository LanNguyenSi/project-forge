import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { buttonByLabel, byRole, click, keyDown, mount, unmountAll } from "./render-helpers";

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

afterEach(() => {
  unmountAll();
  document.body.style.overflow = "";
});

function renderShell() {
  const container = mount(
    <AppShell>
      <p>page body</p>
    </AppShell>,
  );
  const hamburger = buttonByLabel(container, "Open navigation menu");
  return { container, hamburger };
}

function openDrawer() {
  const shell = renderShell();
  shell.hamburger.focus();
  click(shell.hamburger);
  const dialog = byRole(shell.container, "dialog")[0];
  return { ...shell, dialog };
}

function linkByText(root: ParentNode, text: string) {
  const el = Array.from(root.querySelectorAll<HTMLElement>("a")).find((a) =>
    a.textContent?.includes(text),
  );
  if (!el) throw new Error(`no link ${text}`);
  return el;
}

describe("AppShell mobile navigation drawer", () => {
  it("names the hamburger and exposes its expanded state and target", () => {
    const { container, hamburger } = renderShell();
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
    expect(hamburger.getAttribute("aria-controls")).toBeTruthy();
    expect(byRole(container, "dialog")).toHaveLength(0);
  });

  it("opens a labelled modal dialog that the hamburger controls", () => {
    const { hamburger, dialog } = openDrawer();

    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelId = dialog.getAttribute("aria-labelledby")!;
    expect(dialog.querySelector(`[id="${labelId}"]`)?.textContent).toBe("Navigation menu");
    expect(dialog.id).toBe(hamburger.getAttribute("aria-controls"));
    expect(hamburger.getAttribute("aria-expanded")).toBe("true");
    expect(linkByText(dialog, "API Docs")).toBeTruthy();
  });

  it("moves focus into the drawer on open", () => {
    const { dialog } = openDrawer();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape and returns focus to the hamburger", () => {
    const { container, hamburger } = openDrawer();

    keyDown("Escape");

    expect(byRole(container, "dialog")).toHaveLength(0);
    expect(document.activeElement).toBe(hamburger);
    expect(hamburger.getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on overlay click but not on a click inside the drawer", () => {
    const { container, hamburger, dialog } = openDrawer();

    click(dialog);
    expect(byRole(container, "dialog")).toHaveLength(1);

    click(dialog.parentElement as HTMLElement);
    expect(byRole(container, "dialog")).toHaveLength(0);
    expect(document.activeElement).toBe(hamburger);
  });

  it("closes when a navigation link inside the drawer is chosen", () => {
    const { container, dialog } = openDrawer();

    click(linkByText(dialog, "API Docs"));
    expect(byRole(container, "dialog")).toHaveLength(0);
  });

  it("keeps focus where it is when the drawer re-renders (user menu toggle)", () => {
    const { container, dialog } = openDrawer();

    const toggle = Array.from(dialog.querySelectorAll<HTMLElement>("button")).find((b) =>
      b.textContent?.includes("ui-test@example.test"),
    )!;
    toggle.focus();
    click(toggle);

    expect(byRole(container, "dialog")[0]).toBe(dialog);
    expect(document.activeElement).toBe(toggle);
  });

  it("keeps the hamburger at least 44px square", () => {
    const { hamburger } = renderShell();
    expect(hamburger.className).toContain("h-11");
    expect(hamburger.className).toContain("w-11");
  });
});
