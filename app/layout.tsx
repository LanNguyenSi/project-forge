import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { SessionProvider } from "@/components/SessionProvider";

// Fonts are vendored in ./fonts (see fonts/README.md). Each family is declared
// twice with the same CSS font-family name: the latin faces carry the CSS
// variable used by the stylesheet and Tailwind; the latin-ext faces are
// registered under the same family name and only load for their unicode-range.
// next/font/local has no per-file unicode-range, hence one call per subset.

const spaceGrotesk = localFont({
  src: [
    { path: "./fonts/space-grotesk-latin-wght-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/space-grotesk-latin-wght-normal.woff2", weight: "700", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "Space Grotesk" },
    { prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
  ],
  display: "swap",
  variable: "--font-display",
});

const spaceGroteskExt = localFont({
  src: [
    { path: "./fonts/space-grotesk-latin-ext-wght-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/space-grotesk-latin-ext-wght-normal.woff2", weight: "700", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "Space Grotesk" },
    { prop: "unicode-range", value: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-display-ext",
});

const ibmPlexSans = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "IBM Plex Sans" },
    { prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
  ],
  display: "swap",
  variable: "--font-sans",
});

const ibmPlexSansExt = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-latin-ext-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-ext-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-ext-600-normal.woff2", weight: "600", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "IBM Plex Sans" },
    { prop: "unicode-range", value: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-sans-ext",
});

const ibmPlexMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "IBM Plex Mono" },
    { prop: "unicode-range", value: "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD" },
  ],
  display: "swap",
  variable: "--font-mono",
});

const ibmPlexMonoExt = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-ext-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-ext-500-normal.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "IBM Plex Mono" },
    { prop: "unicode-range", value: "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-mono-ext",
});

export const metadata: Metadata = {
  title: "project-forge",
  description: "Create AI-toolchain projects with planforge + scaffoldkit",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${spaceGroteskExt.variable} ${ibmPlexSans.variable} ${ibmPlexSansExt.variable} ${ibmPlexMono.variable} ${ibmPlexMonoExt.variable}`}
    >
      <body className="antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
