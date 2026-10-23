---
name: figlint
description: Check a figure you drew (HTML or SVG: diagram, chart, map, slide graphic) for layout bugs before handing it over. Use after writing or editing any .svg or .html figure. Runs `npx -y figlint`, which renders the file in headless Chromium and reports overlapping labels, clipped text, shapes off the canvas, arrows that end in mid-air, labels sitting on lines, and low contrast in light and dark mode.
---

# figlint

Looking at your own screenshot is not enough: overlaps of a few pixels, an arrow that stops 20px short
of its box, or a caption that is unreadable only in dark mode are easy to miss. figlint measures the
rendered figure and tells you where each problem is and how far to move things.

## When

Run it every time you finish drawing or changing an HTML or SVG figure, before you show it to the user.
Run it again after each round of fixes.

## How

```bash
npx -y figlint path/to/figure.svg
```

- Exit code 0: no errors (warnings may remain). 1: errors found. 2: figlint itself failed (bad path,
  no browser).
- `--json` gives the same report as JSON if you want to parse it.
- `--shot marked.png` saves the render with every finding boxed and numbered. Look at it when a
  finding is not obvious from the text.
- `--theme light` or `--theme dark` checks one theme. The default checks both.
- HTML pages are checked at 1280px wide. Pass `--width` if the figure is meant for another width.

If it exits 2 because no browser is found, run `npx -y playwright-core install chromium` once, or set
`FIGLINT_CHROME` to an installed Chrome or Edge.

## Loop

1. Run figlint.
2. Fix every error. Each finding has a `fix` line; follow it unless you have a better layout idea.
3. Fix warnings unless they are deliberate (see below).
4. Run figlint again. Stop when it exits 0 and the remaining warnings are ones you can defend.
5. Tell the user what figlint found and what you changed, in one or two lines.

Do not stop after one pass: moving one label often creates a new overlap.

## Reading findings

Every finding has a rule, a CSS selector for the element, its box on the page (`x,y widthxheight` in
CSS pixels), and a fix. Distances in the fix line are in the element's own units, so for SVG you can
apply them straight to `x`, `y` or path coordinates.

| rule | what it means | usual fix |
|---|---|---|
| `text-overlap` | two pieces of text overlap | move one by the amount given; if there is no room, shorten one or use a leader line |
| `text-covered` | a shape is painted on top of text | move the text after the shape in the source (SVG paints in document order) |
| `text-clipped` | text runs past the viewBox, the page, or a box with `overflow: hidden` | shorten, wrap into two lines, shrink the font, or grow the container |
| `off-canvas` | a shape is fully (error) or partly (warning) outside the viewBox | move it in, or grow the viewBox |
| `dangling-connector` | an arrow or connecting line ends in empty space | extend the end to the point given; it is on the edge of the nearest box |
| `text-shape-overlap` | a label sits half inside, half outside a filled shape | put it fully inside or fully outside, or make the shape bigger |
| `label-on-line` | a line runs through a label | move the label, or add a halo: `stroke="<background>" stroke-width="3" paint-order="stroke"` |
| `low-contrast` | text fails WCAG AA (4.5:1, or 3:1 for large text) in light or dark | use the suggested color; for dark-only failures set it under `@media (prefers-color-scheme: dark)` |

A transparent SVG is checked on white in light mode and on `#0d1117` (GitHub's dark background) in dark
mode. If an SVG will be shown on dark pages, give its text a color that works there or add a dark
`@media` block.

## Deliberate exceptions

Mark an element (or a group) with `data-figlint-ignore` to skip it for every rule, or
`data-figlint-ignore="low-contrast label-on-line"` to skip just those rules. Use it only for things that
are meant to look that way, such as a faint watermark or a background label that is intentionally
crossed by lines. Never use it to make a real bug go away, and tell the user what you ignored and why.

Arrows are recognised by their markers (`marker-end`, `marker-start`) or by a class or id containing
edge, link, arrow, connector, wire, flow or leader. Add `data-figlint-connector` to a plain line to have
both of its ends checked.
