import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { fireEvent, render } from "@testing-library/react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next-auth/react", () => ({
  useSession: () => ({ data: null, status: "unauthenticated" }),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));
// The public docs view renders the swagger bundle; only the page structure
// around it matters here.
vi.mock("swagger-ui-react/swagger-ui.css", () => ({}));
vi.mock("next/dynamic", () => ({
  default: () =>
    function SwaggerStub() {
      return <div className="swagger-stub" />;
    },
}));
// Only the signed-out views are under test; the signed-in docs view renders
// AppShell, whose own skip link is covered by app-shell-a11y.test.tsx.
vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import LandingPage from "@/app/page";
import LoginPage from "@/app/(dashboard)/login/page";
import ApiDocsPage from "@/app/docs/page";
import { MAIN_CONTENT_ID } from "@/components/layout/SkipLink";

// Each public page renders PublicNav and its own <main> (the skip-link target),
// so the bypass link is only correct per page; the dashboard layout is covered
// by app-shell-a11y.test.tsx.
const pages: { path: string; view: () => ReactNode }[] = [
  { path: "/", view: () => <LandingPage /> },
  { path: "/login", view: () => <LoginPage /> },
  { path: "/docs (signed out)", view: () => <ApiDocsPage /> },
];

function parts(container: HTMLElement) {
  const main = container.querySelector<HTMLElement>(`#${MAIN_CONTENT_ID}`);
  const nav = container.querySelector<HTMLElement>("nav");
  const link = container.querySelector<HTMLElement>(`a[href="#${MAIN_CONTENT_ID}"]`);
  expect(main).not.toBeNull();
  expect(nav).not.toBeNull();
  expect(link).not.toBeNull();
  return { main: main!, nav: nav!, link: link! };
}

describe.each(pages)("skip link on $path", ({ view }) => {
  it("renders the target as a focusable main landmark", () => {
    const { container } = render(view());
    const { main } = parts(container);
    expect(main.tagName).toBe("MAIN");
    expect(main.getAttribute("tabindex")).toBe("-1");
  });

  it("keeps the skip link and the navigation outside the target", () => {
    const { container } = render(view());
    const { main, nav, link } = parts(container);
    // A link that is a child of its own target cannot bypass anything: activation
    // lands on the target and the next Tab comes straight back to the link.
    expect(main.contains(link)).toBe(false);
    expect(main.contains(nav)).toBe(false);
    expect(nav.contains(link)).toBe(false);
  });

  it("puts the target after the navigation in document order", () => {
    const { container } = render(view());
    const { main, nav, link } = parts(container);
    // Pre-order over every element: a descendant of <main> always sorts after
    // <main> itself, so a nav inside the target fails this.
    const order = Array.from(container.querySelectorAll("*"));
    expect(order.indexOf(link)).toBeLessThan(order.indexOf(nav));
    expect(order.indexOf(nav)).toBeLessThan(order.indexOf(main));
  });

  it("makes the skip link the first focusable element, before any nav link", () => {
    const { container } = render(view());
    const { nav, link } = parts(container);
    const focusable = Array.from(container.querySelectorAll("a[href], button, input, [tabindex]"));
    expect(focusable[0]).toBe(link);
    for (const navLink of Array.from(nav.querySelectorAll("a[href]"))) {
      expect(focusable.indexOf(navLink)).toBeGreaterThan(0);
    }
  });

  it("moves the focus to the target when the skip link is activated", () => {
    const { container } = render(view());
    const { main, link } = parts(container);
    // Activation has to move the focus itself: a page whose target the browser
    // does not focus on a fragment navigation sends the next Tab back into the
    // navigation the link just bypassed.
    fireEvent.click(link);
    expect(document.activeElement).toBe(main);
  });
});
