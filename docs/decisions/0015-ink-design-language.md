# ADR 0015: Ink design language

- Status: Accepted
- Date: 2026-11-03
- Linear: AFE-86 (also covers AFE-83 and AFE-85)
- Supersedes: in [ADR 0009](0009-web-ui-design-system.md) the indigo accent, the Inter
  typeface, the OS-only theme and the 6px controls; in
  [ADR 0012](0012-readable-type-scale.md) the section/page title sizes and uppercase
  table heads; in [ADR 0013](0013-tool-colour-coding.md) the 2px tool-coloured rule on
  rows and the Afe mark. Everything else in those ADRs stands.

## Context

Users were dissatisfied with the app's look as a whole: colours, fonts, icons and
layout. AFE-86 lifted the earlier constraint to keep the palette. Three directions
were mocked up on the same screens (Cobalt, Console and Ink); the product owner
chose **Ink** and decided the open questions below.

## Decision

**Direction: Ink.** Black and white, with colour reserved for signal. Fewer boxes:
sections are separated by hairlines and whitespace.

- **Palette.** Pure neutral greys (no hue). Buttons, links and navigation are ink
  (`--accent-solid`: near-black in light, near-white in dark). Status (`--ok`,
  `--warn`, `--bad`, `--recon`, `--backfill`), confidence and tool logos are the only
  colours, so colour always means something.
- **One blue for selection.** `--select` / `--select-soft` mark keyboard focus,
  selected cells, journey highlights and active filter chips. It is never used for
  status or decoration.
- **Confidence.** `--conf-strong` moves from blue to lime so the scale reads green
  (certain) → lime (strong) → amber (probable) → red (weak), and does not collide
  with the selection blue.
- **Type.** Instrument Sans for UI, JetBrains Mono for identifiers, both bundled with
  `@fontsource-variable/*`. Page titles 28px/600, section titles 18px/600; table
  heads and overlines are sentence case, not uppercase.
- **Shape.** Pill buttons, nav items and chips (`--radius-pill`); 8px inputs; 12px
  tables and callouts; 16px dialogs. No resting shadows; shadows only for popovers,
  toasts and the sign-in card.
- **Layout.** Airy shell and forms; data views (timeline, tables, matrix) keep compact
  rows. `.card` is a section under a hairline, not a box. Tables, the timeline and
  inline forms keep their own containers.
- **Icons.** Lucide outlines (ISC), copied into `icons.tsx` (no runtime dependency).
- **Logo.** A wordmark: "afe" in Instrument Sans with a solid dot, drawn as an SVG
  outline. The favicon and the Afe tool mark are a lowercase "a" on an ink tile.
- **Tools.** Tool logos keep their brand colours; rows no longer carry a
  tool-coloured left rule. The logo in each row identifies the source.
- **Theme.** Users can choose System, Light or Dark in the sidebar account area.
  The choice is stored per browser and applied before the first render. Dark tokens
  live in two identical blocks (OS setting and `data-theme="dark"`); the
  design-system test keeps them equal.
- **Creation controls (AFE-85).** Forms that create something open in place from a
  labelled "Add …" button with Cancel and Save, never from an arrow disclosure. The
  GitHub Actions repository picker is a labelled button that opens a search popover
  (closed by Escape or a click outside), with pinned repositories as tabs beside it.
- **Lists of named things (AFE-83).** Services, environments and similar lists use
  structured rows: name, identifier in mono, metadata underneath, labelled icon
  actions aligned on the right.

## Consequences

- `docs/design-system.md` lists the new tokens, classes and patterns.
  `design-system.test.ts` keeps enforcing contrast (now including the new values)
  and checks that both dark blocks match.
- Pages read as calmer; status colour stands out more because nothing else is
  coloured.
- The repository picker overlays content while open, which replaces the in-flow
  picker from AFE-80. It is capped in height and closes on Escape or a click
  outside.
- Instrument Sans does not distinguish `l`, `I` and `1` as strongly as Inter did;
  identifiers are set in JetBrains Mono, which does.
