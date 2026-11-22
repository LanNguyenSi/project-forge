import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "New Project" };

export default function CreateLayout({ children }: { children: ReactNode }) {
  return children;
}
