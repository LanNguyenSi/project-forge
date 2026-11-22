import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "API Documentation" };

export default function DocsLayout({ children }: { children: ReactNode }) {
  return children;
}
