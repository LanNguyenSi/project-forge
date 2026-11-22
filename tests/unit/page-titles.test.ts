import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// The root layout builds its fonts with next/font/local, which only works inside
// the Next compiler.
vi.mock("next/font/local", () => ({ default: () => ({ variable: "", className: "" }) }));

import { metadata as rootMetadata } from "@/app/layout";
import { metadata as createMetadata } from "@/app/(dashboard)/create/layout";
import { metadata as dashboardMetadata } from "@/app/(dashboard)/dashboard/layout";
import { metadata as loginMetadata } from "@/app/(dashboard)/login/layout";
import { metadata as settingsMetadata } from "@/app/(dashboard)/settings/layout";
import { metadata as docsMetadata } from "@/app/docs/layout";
import { metadata as styleguideMetadata } from "@/app/styleguide/layout";

// The pages are client components and cannot export metadata, so each route
// segment has a small server layout that does.
const segments = [
  { route: "/create", file: "app/(dashboard)/create/layout.tsx", metadata: createMetadata, title: "New Project" },
  { route: "/dashboard", file: "app/(dashboard)/dashboard/layout.tsx", metadata: dashboardMetadata, title: "Dashboard" },
  { route: "/login", file: "app/(dashboard)/login/layout.tsx", metadata: loginMetadata, title: "Sign In" },
  { route: "/settings", file: "app/(dashboard)/settings/layout.tsx", metadata: settingsMetadata, title: "Settings" },
  { route: "/docs", file: "app/docs/layout.tsx", metadata: docsMetadata, title: "API Documentation" },
  { route: "/styleguide", file: "app/styleguide/layout.tsx", metadata: styleguideMetadata, title: "Styleguide" },
];

describe("page titles", () => {
  it("gives the root a default title and a template for the segments", () => {
    expect(rootMetadata.title).toEqual({ default: "project-forge", template: "%s | project-forge" });
  });

  for (const { route, metadata, title } of segments) {
    it(`titles ${route} "${title}"`, () => {
      expect(metadata.title).toBe(title);
    });
  }

  it("uses a distinct title per route", () => {
    const titles = segments.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  for (const { route, file } of segments) {
    it(`keeps the ${route} layout a server component (metadata cannot come from a client one)`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/^\s*["']use client["']/m);
    });
  }
});
