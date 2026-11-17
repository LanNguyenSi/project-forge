// The repo's vitest environment is happy-dom (no jsdom package is installed),
// and happy-dom does not apply the stylesheet, so the CSS half is pinned by
// rule text like tests/unit/swagger-info-links.test.ts does.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { patchServerSelect } from "@/app/docs/patch-server-select";

const PRODUCTION = "https://project-forge.opentriologue.ai - Production";
const LOCAL = "http://localhost:3000 - Local development";

function serverSelect(): HTMLSelectElement {
  const select = document.createElement("select");
  select.id = "servers";
  const production = document.createElement("option");
  production.value = "https://project-forge.opentriologue.ai";
  production.textContent = PRODUCTION;
  const local = document.createElement("option");
  local.value = "http://localhost:3000";
  local.textContent = LOCAL;
  select.append(production, local);
  return select;
}

describe("patchServerSelect", () => {
  it("titles the select with the text of the selected option", () => {
    const select = serverSelect();
    patchServerSelect(select);
    expect(select.getAttribute("title")).toBe(PRODUCTION);
  });

  it("updates the title when the selection changes", () => {
    const select = serverSelect();
    patchServerSelect(select);
    expect(select.getAttribute("title")).toBe(PRODUCTION);

    select.selectedIndex = 1;
    select.dispatchEvent(new Event("change"));

    expect(select.getAttribute("title")).toBe(LOCAL);
  });

  it("adds the change listener once across repeated observer calls", () => {
    const select = serverSelect();
    const addEventListener = vi.spyOn(select, "addEventListener");
    patchServerSelect(select);
    patchServerSelect(select);
    patchServerSelect(select);
    expect(addEventListener.mock.calls.filter(([type]) => type === "change")).toHaveLength(1);
    addEventListener.mockRestore();

    select.selectedIndex = 1;
    select.dispatchEvent(new Event("change"));
    expect(select.getAttribute("title")).toBe(LOCAL);
  });

  it("names the select but preserves an accessible name it already has", () => {
    const select = serverSelect();
    patchServerSelect(select);
    expect(select.getAttribute("aria-label")).toBe("API server");

    const named = serverSelect();
    named.setAttribute("aria-label", "Pick a server");
    patchServerSelect(named);
    expect(named.getAttribute("aria-label")).toBe("Pick a server");
  });

  it("leaves the title empty while the select has no options", () => {
    const select = document.createElement("select");
    patchServerSelect(select);
    expect(select.getAttribute("title")).toBe("");
  });
});

describe("server picker narrow-width CSS", () => {
  const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");

  function declarationsFor(selectorText: string, scope: string): string {
    return [...scope.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
      .filter(([, selector]) => selector.split(",").some((sel) => sel.trim() === selectorText))
      .map(([, , body]) => body)
      .join("\n");
  }

  function mediaBlock(query: RegExp): string {
    const match = withoutComments.match(query);
    if (match?.index === undefined) return "";
    let depth = 0;
    for (let i = match.index + match[0].length; i < withoutComments.length; i++) {
      if (withoutComments[i] === "{") depth++;
      else if (withoutComments[i] === "}") {
        depth--;
        if (depth === 0) return withoutComments.slice(match.index + match[0].length, i);
      }
    }
    return "";
  }

  it("lets the select wrap onto a full-width line at narrow widths", () => {
    const narrow = mediaBlock(/@media \(max-width:\s*640px\)/);
    expect(narrow).not.toBe("");

    const declarations = declarationsFor(".swagger-ui .servers select", narrow);
    expect(declarations).toMatch(/max-width:\s*100%\s*!important/);
    expect(declarations).toMatch(/width:\s*100%\s*!important/);
    expect(declarations).toMatch(/white-space:\s*normal\s*!important/);
  });

  it("resets swagger-ui's label offset inside the 640px media block", () => {
    const narrow = mediaBlock(/@media \(max-width:\s*640px\)/);
    expect(narrow).not.toBe("");

    const declarations = declarationsFor(".swagger-ui .servers > label", narrow);
    expect(declarations).toMatch(/margin:\s*0\s*!important/);
  });
});
