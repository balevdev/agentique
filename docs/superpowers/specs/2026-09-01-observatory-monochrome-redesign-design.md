# Observatory monochrome redesign — design

Date: 2026-09-01
Scope: `skills/anakin/scripts/dashboard/` UI + minimal server/test wiring.

## Goal

Redesign the anakin factory observatory into a strict black-and-white,
Linear/Apple/troopers-grade interface with light and dark themes, zero
flicker, zero layout shift, and no added dependencies or weight.

## Direction

Monochrome editorial. All color is grayscale OKLCH (chroma 0). Emphasis is
carried by **filled-vs-outline inversion**, not hue: solid ink means
"loud" (failure, active state), hairline outline means "quiet". Typography
does the hierarchy work: tight negative tracking on headings, uppercase
monospace kickers, tabular numerals for stats, inverted `::selection`.

## Approaches considered

1. Soften the existing blue theme — rejected: violates the black/white rule.
2. **Strict monochrome (chosen)** — matches troopers site + CMS inspiration.
3. Monochrome plus one gray-blue tint — rejected: cognitive load without payoff.

## Components

- `dashboard/theme.js` (new): 10-line blocking script in `<head>` that sets
  `data-theme` from localStorage or `prefers-color-scheme` **before first
  paint**. Kills the theme flash; CSP-safe (served, not inline).
- `dashboard/index.html`: references theme.js before the stylesheet.
- `dashboard/style.css`: full rewrite. Tokens on `:root` (light default),
  dark under `@media (prefers-color-scheme: dark)` guarded with
  `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]`.
  Keeps `oklch(` and `[data-theme="light"]` (test contract).
- `dashboard/app.ts`: theme init removed (theme.js owns it); toggle keeps
  writing `anakin-theme`; brand gets a 2×2 square mark; stat cards go
  label-over-value; all data/render logic untouched.
- `dashboard.ts`: serves `/theme.js`; snapshot mode inlines it.
- `dashboard.test.ts`: asserts `/theme.js` is served and inlined in snapshots.

## Motion & stability rules

- Transitions only on color, background-color, border-color (120–180 ms).
- No transform/size transitions that move layout; theme flips instantly.
- `scrollbar-gutter: stable` on the root; sticky rail; pulse dot is the one
  animation and is disabled under `prefers-reduced-motion`.

## Error handling / testing

Server behavior unchanged (read-only, CSP, Host allowlist). Validation:
`bun test` in `skills/anakin/scripts`, plus a live visual pass of both
themes on a seeded DB.
