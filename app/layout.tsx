import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { SessionProvider } from "@/components/SessionProvider";

// Fonts are vendored in ./fonts (see fonts/README.md). Each family is declared
// once per subset with the same CSS font-family name: the latin faces carry the
// CSS variable used by the stylesheet and Tailwind and are the only preloaded
// ones; the other subsets are registered under the same family name and only
// load for their unicode-range. next/font/local has no per-file unicode-range,
// hence one call per subset.

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

const spaceGroteskLatinExt = localFont({
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
  variable: "--font-display-latin-ext",
});

const spaceGroteskVietnamese = localFont({
  src: [
    { path: "./fonts/space-grotesk-vietnamese-wght-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/space-grotesk-vietnamese-wght-normal.woff2", weight: "700", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "Space Grotesk" },
    { prop: "unicode-range", value: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-display-vietnamese",
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

const ibmPlexSansLatinExt = localFont({
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
  variable: "--font-sans-latin-ext",
});

const ibmPlexSansCyrillic = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-cyrillic-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-cyrillic-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-cyrillic-600-normal.woff2", weight: "600", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "IBM Plex Sans" },
    { prop: "unicode-range", value: "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-sans-cyrillic",
});

const ibmPlexSansCyrillicExt = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-cyrillic-ext-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-cyrillic-ext-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-cyrillic-ext-600-normal.woff2", weight: "600", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "IBM Plex Sans" },
    { prop: "unicode-range", value: "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-sans-cyrillic-ext",
});

const ibmPlexSansGreek = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-greek-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-greek-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-greek-600-normal.woff2", weight: "600", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "IBM Plex Sans" },
    { prop: "unicode-range", value: "U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-sans-greek",
});

const ibmPlexSansVietnamese = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-vietnamese-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-vietnamese-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-vietnamese-600-normal.woff2", weight: "600", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "IBM Plex Sans" },
    { prop: "unicode-range", value: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-sans-vietnamese",
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

const ibmPlexMonoLatinExt = localFont({
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
  variable: "--font-mono-latin-ext",
});

const ibmPlexMonoCyrillic = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-cyrillic-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-cyrillic-500-normal.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "IBM Plex Mono" },
    { prop: "unicode-range", value: "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-mono-cyrillic",
});

const ibmPlexMonoCyrillicExt = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-cyrillic-ext-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-cyrillic-ext-500-normal.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "IBM Plex Mono" },
    { prop: "unicode-range", value: "U+0460-052F,U+1C80-1C8A,U+20B4,U+2DE0-2DFF,U+A640-A69F,U+FE2E-FE2F" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-mono-cyrillic-ext",
});

const ibmPlexMonoVietnamese = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-vietnamese-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-vietnamese-500-normal.woff2", weight: "500", style: "normal" },
  ],
  declarations: [
    { prop: "font-family", value: "IBM Plex Mono" },
    { prop: "unicode-range", value: "U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-mono-vietnamese",
});

export const metadata: Metadata = {
  title: "project-forge",
  description: "Create AI-toolchain projects with planforge + scaffoldkit",
};

const fontVariables = [
  spaceGrotesk.variable,
  spaceGroteskLatinExt.variable,
  spaceGroteskVietnamese.variable,
  ibmPlexSans.variable,
  ibmPlexSansLatinExt.variable,
  ibmPlexSansCyrillic.variable,
  ibmPlexSansCyrillicExt.variable,
  ibmPlexSansGreek.variable,
  ibmPlexSansVietnamese.variable,
  ibmPlexMono.variable,
  ibmPlexMonoLatinExt.variable,
  ibmPlexMonoCyrillic.variable,
  ibmPlexMonoCyrillicExt.variable,
  ibmPlexMonoVietnamese.variable,
].join(" ");

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={fontVariables}
    >
      <body className="antialiased">
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
