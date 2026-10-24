import { afterEach, describe, expect, it, vi } from "vitest";
import { act, useEffect, useRef } from "react";
import { mount, settle, unmountAll } from "./render-helpers";

vi.mock("swagger-ui-react/swagger-ui.css", () => ({}));
vi.mock("next/dynamic", () => ({
  // Stand-in for swagger-ui: renders the same unnamed picker markup after mount.
  default: () =>
    function FakeSwagger() {
      const ref = useRef<HTMLDivElement | null>(null);
      useEffect(() => {
        const t = setTimeout(() => {
          ref.current!.innerHTML =
            '<div class="servers"><label for="servers"><select id="servers"><option>a</option></select></label></div>';
        }, 0);
        return () => clearTimeout(t);
      }, []);
      return <div ref={ref} />;
    },
}));
vi.mock("next-auth/react", () => ({ useSession: () => ({ status: "unauthenticated", data: null }) }));
vi.mock("@/components/layout/PublicNav", () => ({ PublicNav: () => null }));
vi.mock("@/components/layout/AppShell", () => ({ AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import ApiDocsPage from "@/app/docs/page";

afterEach(unmountAll);

describe("API docs page", () => {
  it("gives the swagger server select an accessible name once it appears", async () => {
    const container = mount(<ApiDocsPage />);
    await settle();
    const select = container.querySelector("#servers");
    expect(select).not.toBeNull();
    expect(select!.getAttribute("aria-label")).toBe("API server");
  });

  it("names a server select that swagger-ui re-creates later", async () => {
    const container = mount(<ApiDocsPage />);
    await settle();
    const servers = container.querySelector(".servers")!;
    await act(async () => {
      servers.replaceChildren();
      const select = document.createElement("select");
      select.id = "servers";
      servers.appendChild(select);
    });
    await settle();
    expect(container.querySelector("#servers")!.getAttribute("aria-label")).toBe("API server");
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
