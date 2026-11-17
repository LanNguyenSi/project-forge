import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// The page renders the shared public nav; the nav and its skip link are pinned
// by public-page-skip-link.test.tsx, this file checks the component gallery.
vi.mock("@/components/layout/PublicNav", () => ({ PublicNav: () => null }));

import StyleguidePage from "@/app/styleguide/page";

describe("styleguide page structure", () => {
  it("has exactly one main landmark", () => {
    render(<StyleguidePage />);
    expect(screen.getAllByRole("main")).toHaveLength(1);
  });

  it("renders swatch names in the light text color on the page background", () => {
    render(<StyleguidePage />);
    // names that used to be rendered in text-forge-void (same as the page bg)
    for (const name of ["ember", "gold", "success", "warning", "danger", "forge.ash", "forge.mist"]) {
      const el = screen.getByText(name, { selector: "div" });
      expect(el.className).toContain("text-forge-mist");
      expect(el.className).not.toContain("text-forge-void");
    }
  });

  it("names the styleguide inputs through their labels", () => {
    render(<StyleguidePage />);
    expect(screen.getByRole("textbox", { name: "Default input" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Description" })).toBeTruthy();
  });
});
