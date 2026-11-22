import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = { title: "Styleguide" };

export default function StyleguideLayout({ children }: { children: ReactNode }) {
  return children;
}
