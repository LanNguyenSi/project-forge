import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, useRef } from "react";
import { mount, unmountAll, waitFor } from "./render-helpers";

vi.mock("swagger-ui-react/swagger-ui.css", () => ({}));
vi.mock("next/dynamic", () => ({
  // Stand-in for swagger-ui: an info block with its h1 title, a tag heading,
  // and a servers container that gets the same unnamed picker (label wrapping a
  // select with no text) after mount.
  default: () =>
    function FakeSwagger() {
      const ref = useRef<HTMLDivElement | null>(null);
      useEffect(() => {
        const t = setTimeout(() => {
          const label = document.createElement("label");
          const select = document.createElement("select");
          select.id = "servers";
          label.appendChild(select);
          ref.current!.appendChild(label);
          const info = document.createElement("div");
          info.className = "info";
          const title = document.createElement("h1");
          title.className = "title";
          title.textContent = "project-forge API";
          info.appendChild(title);
          const tag = document.createElement("h3");
          tag.className = "opblock-tag";
          tag.textContent = "Projects";
          ref.current!.append(info, tag);
        }, 0);
        return () => clearTimeout(t);
      }, []);
      return <div ref={ref} className="servers" />;
    },
}));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "unauthenticated", data: null }) }));
vi.mock("@/components/layout/PublicNav", () => ({ PublicNav: () => null }));
vi.mock("@/components/layout/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import ApiDocsPage from "@/app/docs/page";

// happy-dom holds each observer's delivery callback only through a WeakRef, so
// a garbage collection can silently drop notifications. A stand-in observer
// that records its registration and is fired by hand keeps these tests
// deterministic; the page's own logic is what is under test.
class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  observed: { target: Node; options: MutationObserverInit }[] = [];
  disconnected = false;
  constructor(public callback: () => void) {
    FakeMutationObserver.instances.push(this);
  }
  observe(target: Node, options: MutationObserverInit) {
    this.observed.push({ target, options });
  }
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
}

const RealMutationObserver = globalThis.MutationObserver;

beforeEach(() => {
  FakeMutationObserver.instances = [];
  globalThis.MutationObserver = FakeMutationObserver as unknown as typeof MutationObserver;
});

afterEach(() => {
  unmountAll();
  globalThis.MutationObserver = RealMutationObserver;
});

async function mountWithPicker() {
  const container = mount(<ApiDocsPage />);
  await waitFor(() => container.querySelector("#servers") !== null);
  return container;
}

describe("API docs page", () => {
  it("watches the swagger subtree for the server select and stops on unmount", async () => {
    const container = await mountWithPicker();
    expect(FakeMutationObserver.instances).toHaveLength(1);
    const observer = FakeMutationObserver.instances[0];
    expect(observer.observed).toHaveLength(1);
    expect(observer.observed[0].target.contains(container.querySelector("#servers"))).toBe(true);
    expect(observer.observed[0].options).toEqual({ childList: true, subtree: true });

    unmountAll();
    expect(observer.disconnected).toBe(true);
  });

  it("gives the swagger server select an accessible name once it appears", async () => {
    const container = await mountWithPicker();
    const select = container.querySelector("#servers")!;
    expect(select.hasAttribute("aria-label")).toBe(false);

    act(() => FakeMutationObserver.instances[0].callback());

    expect(select.getAttribute("aria-label")).toBe("API server");
  });

  it("names a server select that swagger-ui re-creates later and keeps an existing name", async () => {
    const container = await mountWithPicker();
    const observer = FakeMutationObserver.instances[0];
    act(() => observer.callback());

    const servers = container.querySelector(".servers")!;
    servers.replaceChildren();
    const fresh = document.createElement("select");
    servers.appendChild(fresh);
    act(() => observer.callback());
    expect(fresh.getAttribute("aria-label")).toBe("API server");

    fresh.setAttribute("aria-label", "Pick a server");
    act(() => observer.callback());
    expect(fresh.getAttribute("aria-label")).toBe("Pick a server");
  });

  it("does not name selects outside the swagger server picker", async () => {
    const container = await mountWithPicker();
    const other = document.createElement("select");
    container.querySelector(".servers")!.parentElement!.appendChild(other);

    act(() => FakeMutationObserver.instances[0].callback());

    expect(other.hasAttribute("aria-label")).toBe(false);
  });

  it("announces the swagger API title as a level 2 heading and leaves the other headings alone", async () => {
    const container = await mountWithPicker();
    const title = container.querySelector(".info h1.title")!;
    const pageHeading = container.querySelector("main h1")!;
    const tag = container.querySelector("h3.opblock-tag")!;
    expect(title.hasAttribute("aria-level")).toBe(false);

    act(() => FakeMutationObserver.instances[0].callback());

    expect(title.getAttribute("aria-level")).toBe("2");
    expect(pageHeading.hasAttribute("aria-level")).toBe(false);
    expect(tag.hasAttribute("aria-level")).toBe(false);
  });

  it("sets the title level once and again on a re-created swagger title", async () => {
    const container = await mountWithPicker();
    const observer = FakeMutationObserver.instances[0];
    act(() => observer.callback());

    const setAttribute = vi.spyOn(Element.prototype, "setAttribute");
    try {
      act(() => observer.callback());
      act(() => observer.callback());
      expect(setAttribute.mock.calls.filter(([name]) => name === "aria-level")).toHaveLength(0);

      const info = container.querySelector(".info")!;
      info.replaceChildren();
      const fresh = document.createElement("h1");
      fresh.className = "title";
      info.appendChild(fresh);
      act(() => observer.callback());
      expect(fresh.getAttribute("aria-level")).toBe("2");
      expect(setAttribute.mock.calls.filter(([name]) => name === "aria-level")).toHaveLength(1);
    } finally {
      setAttribute.mockRestore();
    }
  });

  it("only levels the title inside the swagger info block", async () => {
    const container = await mountWithPicker();
    const outside = document.createElement("h1");
    outside.className = "title";
    container.querySelector(".servers")!.appendChild(outside);

    act(() => FakeMutationObserver.instances[0].callback());

    expect(outside.hasAttribute("aria-level")).toBe(false);
  });

  it("lets both code blocks scroll inside themselves and be reached by keyboard", () => {
    const container = mount(<ApiDocsPage />);
    const pres = Array.from(container.querySelectorAll("pre"));
    expect(pres.length).toBe(2);
    for (const pre of pres) {
      expect(pre.className).toContain("overflow-x-auto");
      expect(pre.getAttribute("tabindex")).toBe("0");
    }
  });
});
