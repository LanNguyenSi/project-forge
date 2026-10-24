import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
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

type ChangeListener = (event: { matches: boolean }) => void;

const realMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
let mediaListeners: Set<ChangeListener>;
let mediaQueries: string[];

function stubMatchMedia() {
  mediaListeners = new Set();
  mediaQueries = [];
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => {
      mediaQueries.push(query);
      return {
        matches: false,
        media: query,
        addEventListener: (_type: string, listener: ChangeListener) => mediaListeners.add(listener),
        removeEventListener: (_type: string, listener: ChangeListener) =>
          mediaListeners.delete(listener),
      };
    },
  });
}

function fireMediaChange(matches: boolean) {
  act(() => {
    for (const listener of Array.from(mediaListeners)) listener({ matches });
  });
}

beforeEach(stubMatchMedia);

afterEach(() => {
  unmountAll();
  document.body.style.overflow = "";
  if (realMatchMedia) Object.defineProperty(window, "matchMedia", realMatchMedia);
  else delete (window as { matchMedia?: unknown }).matchMedia;
});

function focusableIn(dialog: HTMLElement) {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>("a[href], button:not([disabled])"),
  );
}

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
  describe("keyboard focus trap", () => {
    it("wraps Tab from the last focusable element to the first", () => {
      const { dialog } = openDrawer();
      const focusable = focusableIn(dialog);
      expect(focusable.length).toBeGreaterThan(1);
      focusable[focusable.length - 1].focus();

      const event = keyDown("Tab");

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(focusable[0]);
    });

    it("wraps Shift+Tab from the first focusable element to the last", () => {
      const { dialog } = openDrawer();
      const focusable = focusableIn(dialog);
      focusable[0].focus();

      const event = keyDown("Tab", window, { shiftKey: true });

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    });

    it("leaves Tab to the browser between the ends", () => {
      const { dialog } = openDrawer();
      const focusable = focusableIn(dialog);
      focusable[0].focus();
      expect(keyDown("Tab").defaultPrevented).toBe(false);

      focusable[focusable.length - 1].focus();
      expect(keyDown("Tab", window, { shiftKey: true }).defaultPrevented).toBe(false);
    });

    it("pulls focus back into the drawer when it sits outside", () => {
      const { dialog, hamburger } = openDrawer();
      hamburger.focus();

      const event = keyDown("Tab");

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(focusableIn(dialog)[0]);
    });

    it("ignores keys other than Tab and Escape", () => {
      const { dialog } = openDrawer();
      const focusable = focusableIn(dialog);
      focusable[focusable.length - 1].focus();

      const event = keyDown("a");

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(focusable[focusable.length - 1]);
    });
  });

  describe("viewport grows to the desktop layout while the drawer is open", () => {
    it("watches the md breakpoint", () => {
      renderShell();
      expect(mediaQueries).toEqual(["(min-width: 768px)"]);
    });

    it("closes the drawer, releases the scroll lock and the Tab trap", () => {
      const { container, hamburger } = openDrawer();
      expect(document.body.style.overflow).toBe("hidden");

      fireMediaChange(true);

      expect(byRole(container, "dialog")).toHaveLength(0);
      expect(hamburger.getAttribute("aria-expanded")).toBe("false");
      expect(document.body.style.overflow).toBe("");
      // The window keydown trap is gone: Tab from the page is not intercepted.
      document.body.focus();
      expect(keyDown("Tab").defaultPrevented).toBe(false);
      expect(keyDown("Tab", window, { shiftKey: true }).defaultPrevented).toBe(false);
    });

    it("keeps the drawer open when the change event says the query no longer matches", () => {
      const { container } = openDrawer();

      fireMediaChange(false);

      expect(byRole(container, "dialog")).toHaveLength(1);
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("stops listening once the shell unmounts", () => {
      renderShell();
      expect(mediaListeners.size).toBe(1);

      unmountAll();

      expect(mediaListeners.size).toBe(0);
    });

    it("still works where matchMedia does not exist", () => {
      delete (window as { matchMedia?: unknown }).matchMedia;

      const { container } = openDrawer();
      expect(byRole(container, "dialog")).toHaveLength(1);

      keyDown("Escape");
      expect(byRole(container, "dialog")).toHaveLength(0);
    });
  });
});
