# ADR 0012: Readable type scale

- Status: Accepted
- Date: 2026-11-01
- Linear: AFE-65
- Supersedes: the type sizes and control height in [ADR 0009](0009-web-ui-design-system.md)
  ("Type" and "Components" bullets). The rest of ADR 0009 stands.

## Context

Users found the UI hard to read: body text was 14px, dense rows and controls
13px, table heads and overlines 11px, and every line had slightly negative
tracking. Some content (sidebar group headings, the sign-in footer, input
placeholders) used `--faint`, which is meant for decoration and is below AA.
Labels and values in detail views had the same size, so they were hard to
tell apart. Users like the colours and asked to keep them.

## Decision

Keep the palette, the typefaces (Inter, JetBrains Mono) and the "precise and
technical" direction. Change the type scale, rhythm and spacing only:

- **Sizes** (tokens in `styles.css`): `--fs-xs` 12px (overlines, table
  heads), `--fs-sm` 13px (badges, labels, meta), `--fs-md` 14px (controls,
  dense rows, tables), `--fs-base` 15px (body), `--fs-lg` 17px (section and
  card titles), `--fs-xl` 24px (page titles). Nothing in the UI is smaller
  than 12px.
- **Line height** tokens: `--lh` 1.55 (running text), `--lh-dense` 1.45
  (rows, cells, callouts), `--lh-tight` 1.25 (headings).
- **Tracking**: body text has no negative letter spacing; only headings are
  tightened slightly. Inter's `cv05`/`cv08` alternates are on so `l`, `I` and
  `1` are distinct in identifiers.
- **Hierarchy**: page title 24px/650, card and section titles 17px/600;
  labels (`.kv dt`, field labels) are muted, values are `--text`; ledes use
  `--text-2`.
- **Controls** are 36px high (`--control-h`), badges 22px, so the larger text
  keeps comfortable padding and touch targets.
- **Contrast**: `--faint` stays decorative only. Text that carries content
  uses `--muted` or stronger.
- Cards get 24px padding (16px below 640px); tables 12px × 16px cells
  (8px × 12px below 640px).

## Consequences

- Pages are a little less dense; dense views (timeline, tables, matrix)
  still fit at 1440px and reflow at 390px without clipping.
- `docs/design-system.md` lists the new values. Page stylesheets use the size
  tokens instead of literal `rem` font sizes.
