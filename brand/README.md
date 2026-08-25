# Basalt — Brand & Logo System

## Concept

The mark is a single **hexagonal basalt column**, extruded into 3D — the six-sided
stone that forms under pressure and cools into load-bearing colonnades (the Giant's
Causeway, Devil's Postpile). It reads as *foundation*: geometric, solid, engineered.
A thin **molten seam** runs down the front face — heat and energy held under the
surface, without resorting to a flaming cliché.

Everything is built on true hexagon geometry (flat-top, 30/60/90 symmetry, radius 55,
extrusion depth 45), so the shape stays mathematically clean at every size.

## Palette

| Role                    | Name           | Hex       |
|-------------------------|----------------|-----------|
| Ink / text / outlines   | Obsidian       | `#14181F` |
| Column base (darkest)   | Basalt Deep    | `#232E38` |
| Column mid face         | Basalt Slate   | `#3C4C59` |
| Lit top face            | Ash Stone      | `#7B8B99` |
| Accent — molten core    | Magma          | `#FF5A1F` |
| Accent — ember highlight| Ember          | `#FFB347` |
| Light surface / paper   | Ash White      | `#F4F2ED` |

Basalt tones (Deep → Slate → Ash Stone) do the structural work; Magma/Ember are the
single accent and should stay scarce — the seam only, never a fill.

## Typography

- **Wordmark:** `Helvetica Neue` / `Arial Nova` / `Arial` — a neutral technical
  grotesk. Weight **600**, letter-spacing **-3** (tight, engineered). Set as live
  `<text>` so it renders anywhere with no font embedding.
- **Docs / UI pairing:** any clean grotesk (Inter, Söhne, system-ui) for body;
  a monospace (JetBrains Mono, ui-monospace) for code.

## Clear space & minimum size

- **Clear space:** keep a margin of one hexagon half-width (½ the mark's width) on
  all sides of the logo.
- **Minimum size:** mark `basalt-mark.svg` down to **16px** (favicon); the full
  logo no smaller than **96px** wide so the wordmark stays legible.
- Below 24px, prefer the mark alone over the full logo.

## Files

| File                     | Description                                                        |
|--------------------------|--------------------------------------------------------------------|
| `basalt-mark.svg`        | Full-colour brandmark, square 200×200 viewBox — favicon → large.   |
| `basalt-mark-mono.svg`   | Single-hue mark using `currentColor`; set `color` for light/print. |
| `basalt-logo.svg`        | Horizontal logo (mark + wordmark) for light backgrounds.           |
| `basalt-logo-dark.svg`   | Horizontal logo tuned for dark backgrounds.                        |

The mono mark inherits `currentColor` — e.g. `<span style="color:#14181F">` on light,
`#F4F2ED` on dark.

## Do / Don't

- **Do** keep the hexagon geometry intact and the molten seam thin and central.
- **Do** place the full-colour mark on Ash White or on dark surfaces — it holds both.
- **Don't** recolour the basalt faces into purple-blue "AI" gradients.
- **Don't** turn the accent into flames, glows, or a full molten fill.
- **Don't** stretch, rotate, add drop shadows, or re-space the wordmark.
