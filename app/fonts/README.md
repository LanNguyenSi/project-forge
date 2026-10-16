# Vendored fonts

Self-hosted so `next build` never fetches from fonts.googleapis.com or
fonts.gstatic.com. Loaded in `app/layout.tsx` through `next/font/local`.

| Files | Family | Weights used | Subsets |
| --- | --- | --- | --- |
| `space-grotesk-<subset>-wght-normal.woff2` | Space Grotesk | 500, 700 | latin, latin-ext, vietnamese |
| `ibm-plex-sans-<subset>-{400,500,600}-normal.woff2` | IBM Plex Sans | 400, 500, 600 | latin, latin-ext, cyrillic, cyrillic-ext, greek, vietnamese |
| `ibm-plex-mono-<subset>-{400,500}-normal.woff2` | IBM Plex Mono | 400, 500 | latin, latin-ext, cyrillic, cyrillic-ext, vietnamese |

Space Grotesk is a variable font (wght axis), taken from the
`@fontsource-variable/space-grotesk` npm package, version 5.3.0. IBM Plex has no
variable build, so the static weights the app uses (all normal style) come from
`@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono`, version 5.3.0
each. Files are from the packages' `files/` directory. Fontsource repackages the
upstream OFL fonts: same font versions and glyph coverage as Google Fonts,
though not byte-identical files.

## Subset decision

Every subset that Google Fonts serves for these families and weights is
vendored, so the rendered coverage equals the previous `next/font/google` build
(which downloaded all of Google's subsets and only used `subsets` to choose
preloads). The app renders user-entered project names and descriptions, so
non-latin glyphs can appear. Space Grotesk has no Cyrillic or Greek subset and
IBM Plex Mono has no Greek subset upstream, so those scripts fall back to the
next font in the stack, as before. Only the latin faces are preloaded; the other
subsets load on demand through their `unicode-range`. Each subset is its own
`localFont` call in the layout, registered under the same CSS family name with
the fontsource `unicode-range`, because `next/font/local` cannot set a
unicode-range per file. The non-latin calls only exist to emit those faces;
their CSS variables (`--font-*-<subset>`) are unused.

## Licenses

All three fonts are licensed under the SIL Open Font License 1.1. The license
texts (with each project's copyright line) are in `OFL-Space-Grotesk.txt`,
`OFL-IBM-Plex-Sans.txt` and `OFL-IBM-Plex-Mono.txt`, copied verbatim from the
fontsource packages.

## Updating

Fetch the new files from the same packages (`npm pack
@fontsource-variable/space-grotesk @fontsource/ibm-plex-sans
@fontsource/ibm-plex-mono`), replace the files here, update the versions above,
and keep the `unicode-range` values in `app/layout.tsx` in sync with the
packages' CSS.
