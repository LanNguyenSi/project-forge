import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Alert } from "@/components/ui/primitives";

// WCAG 1.4.11: the close control is a graphic that needs 3:1 against its
// background at rest. The Tailwind classes do not apply in happy-dom, so the
// colours are computed from the theme tokens in globals.css and the opacity
// class on the button.
const css = readFileSync(path.resolve(__dirname, "../../app/globals.css"), "utf8");

function token(name: string): [number, number, number] {
  const m = css.match(new RegExp(`--color-${name}:\\s*#([0-9a-fA-F]{6})`));
  if (!m) throw new Error(`no theme token ${name}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

type Rgb = [number, number, number];
const mix = (fg: Rgb, bg: Rgb, alpha: number): Rgb =>
  [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha)) as Rgb;
const luminance = ([r, g, b]: Rgb) => {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Tint (or solid background) and text colour per variant, as in Alert.tsx.
const variants = {
  error: { text: "danger", tint: "danger" },
  success: { text: "success", tint: "success" },
  warning: { text: "warning", tint: "warning" },
  info: { text: "forge-mist", solid: "forge-steel" },
} as const;

// Surfaces an Alert sits on: the page and the Card / form card.
const surfaces = ["forge-void", "forge-iron"] as const;

describe("Alert close button contrast at rest", () => {
  it.each(Object.keys(variants) as (keyof typeof variants)[])(
    "keeps the %s close glyph at 3:1 or more on every surface",
    (variant) => {
      const { unmount } = render(
        <Alert variant={variant} onClose={() => {}}>
          Note
        </Alert>,
      );
      const button = screen.getByRole("button", { name: "Close" });
      const classes = button.className.split(/\s+/);
      const rest = classes.find((c) => /^opacity-\d+$/.test(c));
      const opacity = rest ? Number(rest.slice("opacity-".length)) / 100 : 1;

      const spec = variants[variant];
      for (const surface of surfaces) {
        const bg =
          "solid" in spec
            ? token(spec.solid)
            : mix(token(spec.tint), token(surface), 0.1);
        const glyph = mix(token(spec.text), bg, opacity);
        expect(contrast(glyph, bg)).toBeGreaterThanOrEqual(3);
      }
      unmount();
    },
  );

  it("still brightens to full opacity on hover and focus", () => {
    render(
      <Alert variant="error" onClose={() => {}}>
        Note
      </Alert>,
    );
    const classes = screen.getByRole("button", { name: "Close" }).className.split(/\s+/);
    expect(classes).toContain("hover:opacity-100");
    expect(classes).toContain("focus-visible:opacity-100");
  });
});
