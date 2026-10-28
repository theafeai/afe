# ADR 0009: Web UI design system

- Status: Accepted
- Date: 2026-10-28
- Linear: AFE-42 (parent), AFE-43 tokens, AFE-44 shell, AFE-45 components

## Context

The web UI (`apps/web`) grew page by page. It worked, but it looked generic
(system font, warm beige palette), used loud signals for routine states
(hatched fills, thick coloured rules, stacked banners), and pages started to
define their own colours. The product owner chose a direction for how Afe
should look and feel.

## Decision

**Direction: precise and technical.** Cool graphite neutrals, 1px hairlines,
tight type, and colour reserved for signal. Routine data is calm; colour and
weight mark what needs attention (gaps, drift, weak confidence).

- **Tokens.** All colours, type sizes, spacing, radii, shadows and motion are
  CSS custom properties on `:root` in `apps/web/src/styles.css`, with a dark
  variant under `prefers-color-scheme: dark`. Page stylesheets use tokens
  only, never literal colours. Both themes are first-class. The OS
  setting picks the theme.
- **Accent: indigo.** `--accent` is the readable accent (links, accent text,
  outlines). `--accent-solid` with `--on-accent` fills primary buttons and
  selected controls. Status colours (`--ok`, `--warn`, `--bad`, `--recon`,
  `--backfill`) are separate from the accent and never used decoratively.
- **Type.** Inter for UI, JetBrains Mono for identifiers only (SHAs, image
  references, event types, times). Both are bundled with
  `@fontsource-variable/*`: Afe is self-hosted and loads no fonts from a
  CDN. Body text is 14px; dense controls and rows are 13px. Numbers in
  tables and times use tabular figures.
- **Shell.** Left sidebar with grouped navigation (Observe, Setup,
  Account) and the signed-in account pinned at the bottom. Below 900px
  it becomes a top bar with a menu button.
- **Components.** Controls are 32px high with a 6px radius. Badges are small
  rounded rectangles; status (outcome, health) is a dot plus a label; tools
  are a neutral badge with the tool's colour as a small square.
- **Accessibility.** WCAG AA contrast for every text token on every surface,
  in both themes. Visible focus rings. Meaning is never carried by colour
  alone.

## Consequences

- New UI uses the existing classes and tokens. A new colour or size becomes
  a token first.
- Visual changes are reviewed with light and dark screenshots of the
  affected pages.
