# Basalt — Brand & Logo System

## Concept

The mark is a **faceted basalt crystal** — the hexagonal basalt column, split into
low-poly triangular planes. Cool **slate** faces on the shadow side, one **molten
face** catching the light on the right, a hot rim along the top-right crest and a
spark at the peak. It reads as *foundation under pressure*: the stone that forms deep
and holds the heat in its core — energy held under the surface, without a flame cliché.

Geometry is a true isometric flat-top hexagon (center 100,100, size 55, 30/60/90
symmetry) divided into six triangles from the centre, so it stays mathematically clean
at every size. The molten glow is done with **vector gradients + blur** (no raster
bloom), so the SVG scales sharply.

## The name — Basalt, not BasaltKit

The product is **Basalt**. The wordmark, the CLI (`basalt`), the scaffolder
(`create-basalt`) and the docs all use **Basalt**. `basaltkit` is only the **namespace**
— the npm scope `@basaltkit/*` and the GitHub org (like Prisma → `@prisma/*`, Vercel →
`@vercel/*`). The wordmark stays **neutral** (no orange "Kit"): the crystal's molten
face is the single hot accent, and a second hot note would compete. A "BasaltKit"
lockup exists only as a secondary namespace mark for org/npm contexts.

## Palette

| Role                    | Name           | Hex       |
|-------------------------|----------------|-----------|
| Ink / text / outlines   | Obsidian       | `#14181F` |
| Column base (darkest)   | Basalt Deep    | `#232E38` |
| Column mid face         | Basalt Slate   | `#3C4C59` |
| Lit face                | Ash Stone      | `#7B8B99` |
| Accent — molten core    | Magma          | `#FF5A1F` |
| Accent — ember highlight| Ember          | `#FFB347` |
| Light surface / paper   | Ash White      | `#F4F2ED` |

Slate tones (Deep → Slate → Ash Stone) do the structural work; Magma/Ember are the
single accent — the molten face and rim only, never a full fill or a glow-out.

## Typography

- **Wordmark:** `Helvetica Neue` / `Arial Nova` / `Arial` — a neutral technical
  grotesk. Weight **600**, letter-spacing **-3**. Set as live `<text>`, no font
  embedding. Paper (`#F4F2ED`) on dark, Obsidian (`#14181F`) on light.
- **Docs / UI pairing:** any clean grotesk (Inter, Söhne, system-ui) for body;
  a monospace (JetBrains Mono, ui-monospace) for code and labels.

## Clear space & minimum size

- **Clear space:** one hexagon half-width around the logo on all sides.
- **Minimum size:** full crystal down to ~32px; below that use the **flat** variant
  (`basalt-mark-flat.svg`) — it holds to 16px. Full logo no smaller than 96px wide.

## Files

| File                     | Description                                                        |
|--------------------------|--------------------------------------------------------------------|
| `basalt-mark.svg`        | Full-colour faceted crystal with molten core + glow — screen use.  |
| `basalt-mark-flat.svg`   | Flat 3-face variant, no gradients/glow — favicon → small sizes.    |
| `basalt-mark-mono.svg`   | Single-hue mark via `currentColor`; set `color` for light/print.   |
| `basalt-logo.svg`        | Horizontal logo (crystal + "Basalt") for light backgrounds.        |
| `basalt-logo-dark.svg`   | Horizontal logo tuned for dark backgrounds.                        |

The mono mark inherits `currentColor` — e.g. `#14181F` on light, `#F4F2ED` on dark.

## Do / Don't

- **Do** keep the hexagon crystal geometry intact and the molten face on the right.
- **Do** use the full crystal on screen; drop to `basalt-mark-flat.svg` below ~32px.
- **Do** let Magma be the single accent — one hot note per surface.
- **Don't** put an orange "Kit" in the primary wordmark (two competing accents).
- **Don't** blow the glow out into a raster bloom, or add drop shadows to the wordmark.
- **Don't** rotate the crystal, recolour the stone into purple-blue "AI" gradients,
  or re-space / re-typeset the wordmark.
