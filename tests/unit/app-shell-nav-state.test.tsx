import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { buttonByLabel, byRole, click, keyDown, mount, unmountAll } from "./render-helpers";

let pathname = "/dashboard";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { email: "ui-test@example.test" } },
    status: "authenticated",
  }),
  signOut: vi.fn(),
}));

import { AppShell } from "@/components/layout/AppShell";

beforeEach(() => {
  pathname = "/dashboard";
});

afterEach(() => {
  unmountAll();
  document.body.style.overflow = "";
});

function renderShell() {
  return mount(
    <AppShell>
      <p>page body</p>
    </AppShell>,
  );
}

function sidebarOf(container: HTMLElement) {
  return container.querySelector<HTMLElement>("aside")!;
}

function linkIn(root: ParentNode, href: string) {
  const el = root.querySelector<HTMLElement>(`a[href="${href}"]`);
  if (!el) throw new Error(`no link ${href}`);
  return el;
}

function toggleIn(root: ParentNode) {
  return root.querySelector<HTMLButtonElement>("button[data-user-menu-toggle]")!;
}

describe("AppShell aria-current on the navigation links", () => {
  it("marks only the active link with aria-current=page", () => {
    const aside = sidebarOf(renderShell());
    expect(linkIn(aside, "/dashboard").getAttribute("aria-current")).toBe("page");
    expect(linkIn(aside, "/docs").hasAttribute("aria-current")).toBe(false);
    expect(linkIn(aside, "/create").hasAttribute("aria-current")).toBe(false);
  });

  it("moves with the route", () => {
    pathname = "/docs";
    const aside = sidebarOf(renderShell());
    expect(linkIn(aside, "/docs").getAttribute("aria-current")).toBe("page");
    expect(linkIn(aside, "/dashboard").hasAttribute("aria-current")).toBe(false);
  });

  it("keeps a parent link current on a nested route", () => {
    pathname = "/dashboard/some-project";
    const aside = sidebarOf(renderShell());
    expect(linkIn(aside, "/dashboard").getAttribute("aria-current")).toBe("page");
  });

  it("does not treat a sibling that shares a prefix as nested", () => {
    pathname = "/dashboards";
    const aside = sidebarOf(renderShell());
    expect(linkIn(aside, "/dashboard").hasAttribute("aria-current")).toBe(false);
  });

  it("marks the New Project link on /create", () => {
    pathname = "/create";
    const aside = sidebarOf(renderShell());
    expect(linkIn(aside, "/create").getAttribute("aria-current")).toBe("page");
    expect(linkIn(aside, "/dashboard").hasAttribute("aria-current")).toBe(false);
  });

  it("marks the Settings link in the open user menu on /settings", () => {
    pathname = "/settings";
    const aside = sidebarOf(renderShell());
    click(toggleIn(aside));
    expect(linkIn(aside, "/settings").getAttribute("aria-current")).toBe("page");
  });

  it("leaves the Settings link unmarked on another route", () => {
    const aside = sidebarOf(renderShell());
    click(toggleIn(aside));
    expect(linkIn(aside, "/settings").hasAttribute("aria-current")).toBe(false);
  });

  it("marks the active link in the mobile drawer too", () => {
    pathname = "/docs";
    const container = renderShell();
    click(buttonByLabel(container, "Open navigation menu"));
    const dialog = byRole(container, "dialog")[0];
    expect(linkIn(dialog, "/docs").getAttribute("aria-current")).toBe("page");
    expect(linkIn(dialog, "/dashboard").hasAttribute("aria-current")).toBe(false);
  });
});

describe("AppShell user menu toggle", () => {
  it("exposes the collapsed state and the region it controls", () => {
    const toggle = toggleIn(sidebarOf(renderShell()));
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBeTruthy();
    // a disclosure, not an ARIA menu
    expect(toggle.hasAttribute("aria-haspopup")).toBe(false);
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeNull();
  });

  it("toggles aria-expanded and points aria-controls at the revealed region", () => {
    const aside = sidebarOf(renderShell());
    const toggle = toggleIn(aside);

    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const region = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(region).toBeTruthy();
    expect(region!.querySelector('a[href="/settings"]')).toBeTruthy();

    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).toBeNull();
  });

  it("hides the avatar letter and names the button after the e-mail", () => {
    const toggle = toggleIn(sidebarOf(renderShell()));
    const avatar = Array.from(toggle.querySelectorAll("div")).find((d) => d.textContent === "U")!;
    expect(avatar.getAttribute("aria-hidden")).toBe("true");
    // the accessible name comes from the visible text; aria-hidden drops the letter
    const visible = Array.from(toggle.querySelectorAll("*"))
      .filter((n) => !n.closest("[aria-hidden='true']"))
      .map((n) => (n.children.length === 0 ? n.textContent : ""))
      .join("")
      .trim();
    expect(visible).toBe("ui-test@example.test");
    expect(toggle.hasAttribute("aria-label")).toBe(false);
  });

  it("closes the menu on Escape and returns focus to the toggle", () => {
    const aside = sidebarOf(renderShell());
    const toggle = toggleIn(aside);
    click(toggle);
    const settings = linkIn(aside, "/settings");
    settings.focus();

    const event = keyDown("Escape", settings);

    // handled here: the key is consumed and does not reach a window listener
    expect(event.defaultPrevented).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(aside.querySelector('a[href="/settings"]')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it("ignores Escape while the menu is closed", () => {
    const aside = sidebarOf(renderShell());
    const toggle = toggleIn(aside);
    toggle.focus();
    const event = keyDown("Escape", toggle);
    expect(event.defaultPrevented).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("uses distinct region ids in the sidebar and the drawer", () => {
    const container = renderShell();
    click(buttonByLabel(container, "Open navigation menu"));
    const dialog = byRole(container, "dialog")[0];
    // the open state is shared, so one click opens the region in both copies
    click(toggleIn(dialog));
    const ids = Array.from(container.querySelectorAll("[id^='user-menu-']")).map((e) => e.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(toggleIn(dialog).getAttribute("aria-controls")).not.toBe(
      toggleIn(sidebarOf(container)).getAttribute("aria-controls"),
    );
  });

  it("closes only the menu on the first Escape in the drawer, then the drawer", () => {
    const container = renderShell();
    const hamburger = buttonByLabel(container, "Open navigation menu");
    hamburger.focus();
    click(hamburger);
    const dialog = byRole(container, "dialog")[0];
    const toggle = toggleIn(dialog);
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.focus();

    keyDown("Escape", toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle);
    expect(byRole(container, "dialog")).toHaveLength(1);

    keyDown("Escape", toggle);
    expect(byRole(container, "dialog")).toHaveLength(0);
    expect(document.activeElement).toBe(hamburger);
  });
});
