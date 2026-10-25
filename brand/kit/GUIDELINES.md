# Hive — brand guidelines

## The mark

**Team stack.** Three agent cells overlap like the avatars in the collapsed notch: a hive is a team. The front cell is
the one at work, the two behind are ready. The gaps are real cut-outs, so the mark works in one colour.

| File (`kit/svg/`) | Use |
|---|---|
| `hive-symbol-color.svg` | Default symbol on light or dark backgrounds |
| `hive-symbol.svg` | One colour (black). Recolour to any single brand colour |
| `hive-symbol-small.svg` | ≤ 24 px: wider gaps, slightly bigger cells (favicon, menu bar) |
| `hive-horizontal-color.svg` / `-reversed.svg` | Lockup for headers, README, slides |
| `hive-stacked.svg` | Square-ish spaces (splash, social avatar) |
| `hive-wordmark.svg` | Name alone. Monoline, built from strokes; the i-dot is a cell |
| `hive-app-icon.svg` | macOS app icon master (graphite tile, white mark at 78%) |
| `hive-menubar.svg` | Menu bar template (black on transparent; macOS tints it) |

Exports: `kit/export/` (web icons + favicon, mono/white/black variants, `app/AppIcon.icns`, `menubar/MenuBarIcon*.png`).
Rebuild everything with `kit/build.py` (needs `shapely`).

## Colour

| Name | HEX | RGB | Role |
|---|---|---|---|
| Honey | `#F5B23D` | 245 178 61 | Front cell, primary accent, "working" |
| Amber | `#D9962A` | 217 150 42 | Middle cell, hover/pressed accent |
| Bronze | `#B57B1F` | 181 123 31 | Back cell, borders on dark |
| Graphite | `#16181D` | 22 24 29 | Background, app tile, text on light |
| Cream | `#F4EFE6` | 244 239 230 | Text on graphite, light surfaces |

Honey on graphite: contrast 9.6:1. Graphite text on cream: 15.5:1. Don't put honey text on cream (1.6:1).

## Clear space and minimum size

- Clear space around the symbol = the gap between two cells × 3 (≈ 12 % of the symbol width).
- Minimum: symbol 16 px wide (use the small cut below 24 px), horizontal lockup 72 px wide.

## Typography

- The wordmark is custom geometry; never retype it.
- Product UI: the system font (SF Pro on macOS, `system-ui` on the board). Monospace for commands and paths.

## Don't

- Don't reorder, rotate or recolour cells individually outside the three honey tones (or a single colour).
- Don't add outlines, shadows, gradients or a fourth cell.
- Don't fill the gaps or place the colour mark on busy imagery; use one colour instead.
- Don't stretch the lockup or change the symbol–wordmark spacing.

## In the product

- The stack is the "team" motif: the collapsed notch shows working agents' avatars stacked the same way.
- Menu bar: the stack as a template image; pending approvals show as a number next to it.
- Accent colour everywhere is Honey; graphite surfaces; cream text in dark mode.

Trademark clearance wasn't checked. Search before commercial use.
