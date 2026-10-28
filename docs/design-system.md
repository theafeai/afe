# Afe design system

This is the binding reference for every change to the web UI (`apps/web`). It
implements [ADR 0009](decisions/0009-web-ui-design-system.md). Humans and
agents follow it for **all** UI work, new features included. The rules marked
**[enforced]** are checked by `apps/web/src/design-system.test.ts`, which runs
in `pnpm test`; a violation fails CI.

Contents: [Rules](#rules) · [Principles](#principles) · [Tokens](#tokens) ·
[Typography](#typography) · [Layout and page anatomy](#layout-and-page-anatomy) ·
[Components](#components) · [Status language](#status-language) ·
[Patterns](#patterns) · [Adding to the system](#adding-to-the-system) ·
[UI change checklist](#ui-change-checklist)

## Rules

1. **Use the existing components and classes first.** Before writing markup or
   CSS, find the matching component or class in [Components](#components) and
   [Patterns](#patterns). A new feature should usually need little or no new CSS.
2. **No literal colours outside the token definitions.** No `#hex`, `rgb()`,
   `rgba()` or `hsl()` in any stylesheet except inside the `:root` token blocks
   of `styles.css`, and none in `.ts`/`.tsx` (the brand mark in `icons.tsx` is
   the only exception). **[enforced]**
3. **Every `var(--…)` must be a token defined in `styles.css`.** Do not
   invent tokens in page stylesheets or redefine them under `:root` elsewhere.
   **[enforced]**
4. **Themes are tokens, not overrides.** Only `styles.css` may contain
   `prefers-color-scheme`. A page that looks right in light mode with tokens is
   right in dark mode. **[enforced]**
5. **Every class used in markup must be styled**, or be listed (with a reason)
   in `SEMANTIC_HOOKS` in the test. An unstyled `className` is a bug: it renders
   as browser defaults. **[enforced]**
6. **Inline `style` is for geometry only** (`left`, `top`, `width`, `height`,
   `display`, `transform`, computed from data). Never colours, fonts, spacing,
   borders or shadows. **[enforced]**
7. **Fonts come only from the tokens.** `font-family` is always `var(--font)`
   or `var(--mono)`; fonts are bundled with `@fontsource-variable/*`, never
   loaded from a CDN. No external `url(http…)` in CSS. **[enforced]**
8. **Text tokens meet WCAG AA** (≥ 4.5:1) on `--bg`, `--surface` and
   `--surface-2` in both themes, and `--on-accent` on `--accent-solid`.
   Changing a token value re-runs this check. **[enforced]**
9. **Meaning is never carried by colour alone.** Every coloured state also has
   a word, a shape or an icon.
10. **Check light and dark** for every visual change, at desktop width and at
    390px wide, and attach screenshots to the PR.

## Principles

- **Precise and technical.** Cool graphite neutrals, 1px hairlines, tight type.
  It should feel like an instrument, not a marketing page.
- **Calm by default, loud only when it matters.** Most data is routine and
  stays neutral. Colour, weight and tinted backgrounds are reserved for what
  needs attention: observation gaps, drift, weak or conflicting confidence,
  failures. If everything is highlighted, nothing is.
- **One accent.** Indigo marks interactivity and selection (links, primary
  buttons, the current nav item, focus). It never encodes a status.
- **Data-dense but legible.** 13–14px text, tabular numerals, monospace only
  for identifiers.
- **Say what is known and how sure Afe is.** The UI never hides uncertainty;
  it shows it quietly and consistently ([Status language](#status-language)).

## Tokens

All tokens live in `apps/web/src/styles.css`: light values in `:root`, dark
values in `@media (prefers-color-scheme: dark) { :root { … } }`. Use the
token whose **role** matches, not the one whose colour looks right.

### Colour roles

| Token                                                     | Use for                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| `--bg`                                                    | Page canvas                                                         |
| `--sidebar`                                               | Sidebar background                                                  |
| `--surface`                                               | Cards, tables, inputs, menus                                        |
| `--surface-2`                                             | Hover rows, subtle fills, code blocks                               |
| `--surface-3`                                             | Pressed states, sidebar hover                                       |
| `--border`                                                | Default hairlines (cards, tables, dividers)                         |
| `--border-strong`                                         | Control borders (buttons, inputs)                                   |
| `--text`                                                  | Primary text, titles                                                |
| `--text-2`                                                | Secondary text (cell content, descriptions inside cards)            |
| `--muted`                                                 | Labels, metadata, timestamps, placeholders for values               |
| `--faint`                                                 | Decorative only (section overlines, empty cells); never for content |
| `--accent`                                                | Links and accent text (readable on surfaces)                        |
| `--accent-solid` / `--accent-solid-hover` / `--on-accent` | Primary button and selected-control fill and its text               |
| `--accent-soft`                                           | Selected backgrounds, chips, icon tiles                             |
| `--accent-ring` / `--focus`                               | Focus rings                                                         |
| `--ok` / `--ok-bg`                                        | Succeeded, healthy, certain                                         |
| `--warn` / `--warn-bg` / `--warn-border`                  | Pending, degraded, observation gaps, probable                       |
| `--bad` / `--bad-bg`                                      | Failed, revoked, weak, conflict, alerts                             |
| `--recon` / `--recon-bg`                                  | Found by reconciliation; ambiguous                                  |
| `--backfill` / `--backfill-bg`                            | Imported by backfill                                                |
| `--conf-*`                                                | Confidence scale (see [Status language](#status-language))          |
| `--highlight` / `--highlight-bg` / `--env-selected`       | Journey highlight, selected matrix cell                             |
| `--github` `--argocd` `--vercel` `--terraform` `--afe`    | Tool marks only                                                     |

### Type, space, shape, depth, motion

| Group          | Tokens                                                                                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Font families  | `--font` (Inter), `--mono` (JetBrains Mono)                                                                                                                                                                |
| Font sizes     | `--fs-xs` 11px (overlines, table heads) · `--fs-sm` 12px (badges, meta) · `--fs-md` 13px (controls, dense rows) · `--fs-base` 14px (body) · `--fs-lg` 16px (section titles) · `--fs-xl` 22px (page titles) |
| Spacing        | `--space-1` 4px · `--space-2` 8px · `--space-3` 12px · `--space-4` 16px · `--space-5` 24px · `--space-6` 32px                                                                                              |
| Radius         | `--radius-sm` 6px (controls, badges) · `--radius` 8px (cards, tables) · `--radius-lg` 12px (dialogs, sign-in card)                                                                                         |
| Control height | `--control-h` 32px                                                                                                                                                                                         |
| Elevation      | `--shadow-xs` (cards, controls) · `--shadow-sm` (hover lift) · `--shadow-md` (popovers, sign-in card) · `--sheen` (inner highlight on primary buttons)                                                     |
| Motion         | `--dur` 120ms · `--ease`; respect `prefers-reduced-motion` (handled globally)                                                                                                                              |
| Layout         | `--sidebar-w` · `--topbar-h` · `--sticky-top` (use for any `position: sticky` offset)                                                                                                                      |

Prefer the spacing and size tokens for new CSS. Some older page rules still
use literal `rem` values; convert them when you touch those rules.

## Typography

- **Inter** for all UI text. **JetBrains Mono** only for identifiers: commit
  SHAs, image references, event types (`deployment.created`), times in
  timelines, rule expressions. Never for prose or labels.
- Page title: `h1` (`--fs-xl`, weight 600). Section title: `h2` (`--fs-lg`).
  Card title: `h2` or `h3` inside `.card`.
- Overlines and table headers: `--fs-xs`, uppercase, `letter-spacing: 0.06em`,
  `--muted`. Use sparingly.
- Numbers that line up (tables, times, counts): `font-variant-numeric:
tabular-nums` (already on `.table`, `.row-time`).
- Sentence case everywhere ("Add a connection", not "Add A Connection").

## Layout and page anatomy

The app shell (`App.tsx`) is a left sidebar plus content. Below 900px the
sidebar becomes a top bar with a menu. Pages render inside `<main>`; do not
add your own header or nav.

Every page follows this structure:

```tsx
<div className="page">            {/* add "narrow" for forms and settings */}
  <div className="page-header">
    <div>
      <h1>Title</h1>
      <p className="lede">One sentence on what this page answers.</p>
    </div>
    <div className="toolbar">{/* page actions, e.g. Refresh */}</div>
  </div>
  <GapBanners connections={…} />   {/* when the page shows observed data */}
  {/* filters (.filters), then content: .card, .table-wrap, .events, … */}
</div>
```

- Wide data pages may widen `.page` with a page class (see `.page.env-page`,
  `.page.journey-page`).
- Group content in `.card`s. Two cards side by side: `.grid-2`.
- Back links sit above the `h1`: `<Link to="/events">← Events</Link>`.
- Pages shown before sign-in (sign-in, invitation, reset) use the auth card:
  `<div className="login"><section className="card login-card"><BrandMark />
  <h1>…</h1>…</section><p className="login-foot">…</p></div>`.

## Components

### React components (`components.tsx`, `icons.tsx`, `pages/environments-ui.tsx`)

Use these instead of re-creating their markup.

| Component                                                                    | Use for                                                                 |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `Loading`                                                                    | Any loading state (`role="status"`, spinner)                            |
| `ErrorBox`                                                                   | Any failed request; pass `onRetry` when retrying makes sense            |
| `Empty`                                                                      | Empty states; pass `icon={icons.x}` for first-run screens               |
| `KeyValue`                                                                   | Label/value details (`.kv`); never a bare `<dl>`                        |
| `GapBanners`                                                                 | Open observation gaps on any page that shows observed data              |
| `ToolBadge`                                                                  | Naming a source tool                                                    |
| `OutcomeBadge`, `HealthBadge`, `StatusBadge`, `MethodBadge`                  | Event outcome, connection health, connection status, observation method |
| `ConfidenceBadge`, `CertaintyBadge`, `KindBadge`, `GapFlagBadges`, `TimeAgo` | Placement confidence, kind, gap flags and relative times                |
| `ScopeNotice`                                                                | Notice that a view is limited to the user's permissions                 |
| `icons.*`, `BrandMark`                                                       | 16px line icons (`aria-hidden`) and the Afe mark                        |
| `useAsync`, `useDocumentTitle`                                               | Data loading with abort; the tab title (`"Title · Afe"`)                |

### CSS classes (`styles.css`)

| Need             | Class                                                                                                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buttons          | `.btn` (secondary, default) · `.btn-primary` (one per view, the main action) · `.btn-ghost` (toolbar and row actions) · `.btn-danger` (destructive) · `.btn-icon` (square, needs `aria-label`) · `.btn-wide` (full width, auth card) · `.btn-link` (a button that reads as a link) |
| Button groups    | `.toolbar`, `.button-row` (`.actions` is an alias) · `.segmented` (toggle group; set `aria-pressed`)                                                                                                                                                                               |
| Forms            | `.form` (vertical form) · `.field` (label + control) · `.check` (checkbox/radio + label) · `fieldset`/`legend` · `.joined` (select + input pair)                                                                                                                                   |
| Filters          | `.filters` (filter bar card) · `.chips` / `.chip` (active filters, removable)                                                                                                                                                                                                      |
| Containers       | `.card` · `.grid-2` · `.table-wrap` + `.table` · `.kv` · `.json` (raw data)                                                                                                                                                                                                        |
| Lists            | `.events` / `.event-row` / `.row-link` (timeline rows) · `.inline-list` · `.plain` · `.conn-list`                                                                                                                                                                                  |
| Callouts         | `.callout` + `.callout-error` / `.callout-ok` / `.callout-gap` / `.callout-reconciled`                                                                                                                                                                                             |
| States           | `.state` (inline status text) · `.spinner` · `.empty` (+ `.empty-icon`) · `.end` (end of list)                                                                                                                                                                                     |
| Badges           | `.badge` + a modifier from [Status language](#status-language)                                                                                                                                                                                                                     |
| Text             | `.muted` · `.small` · `.lede` · `.mono-title` · `.hash` · `.sr-only`                                                                                                                                                                                                               |
| Navigation cards | `.connect-buttons` / `.connect-card` + `.tool-<source>`                                                                                                                                                                                                                            |

## Status language

Afe's core value is saying what is live and how sure it is. Use these
encodings, the same way on every page.

- **Confidence** (`.badge.conf.conf-<level>`, or `ConfidenceBadge`): a graded
  glyph next to the word. `certain` full · `strong` ¾ · `probable` ½ ·
  `weak` ¼ · `ambiguous` dashed ring · `unknown` empty ring · `conflict` struck
  ring. Certain, strong and probable stay neutral; weak, ambiguous and conflict
  are tinted. Journey edges use the same `--conf-*` colours with solid, dashed
  or dotted lines.
- **Outcome** (`OutcomeBadge`): a dot plus a word. Filled dot for
  succeeded/failed, hollow for pending/in progress.
- **Health** (`HealthBadge`): a dot with a soft halo, plus a word.
- **Tool** (`ToolBadge`, `.tool-<source>`): a neutral badge with the tool's
  colour as a small square. Tool colours are never used for anything else.
- **Observation gaps:** the loud form is `GapBanners`, one panel per page, at
  the top. The per-item form is quiet: `.gap-badge` (warn text with a hollow
  diamond, no fill), e.g. "possibly stale". Never hatch, stripe or fill whole
  rows or cells for a gap.
- **Late observation:** `.row-reconciliation` and `.row-backfill` mark rows
  with a 2px inset rule plus a note; `MethodBadge` names the method.
- **Alerts:** `.alert-badge` ("Alert open"), linking to where the full message
  is shown. Do not put long alert prose in tables.
- **Severity** (drift): `.severity-high` / `.severity-critical` (bad),
  `.severity-medium` (warn); low stays neutral.

Accents for emphasis on a row or card are a **2px** inset rule
(`box-shadow: inset 2px 0 0 var(--…)`), never thicker borders.

## Patterns

- **Loading → error → empty → data.** Every data view handles all four, with
  `Loading`, `ErrorBox`, `Empty` and then the content.
- **Empty states** say what the view will show and the next step, with a link
  or button to it. First-run screens (no connections yet) pass an `icon`.
  Filtered-to-nothing states suggest widening the filters.
- **Tables** go in `.table-wrap`. Headers are short nouns. Row actions are
  `.btn-ghost` buttons or links at the end of the row; destructive actions ask
  for confirmation.
- **Row actions that repeat on every row** of a long list are shown on hover
  and focus only (see `.event-row.has-action`); touch screens always show them.
- **Identifiers**: short SHA (7 characters) in `<code>`, full value in `title`.
  Times: absolute in `title` / `dateTime`, relative in the text (`TimeAgo`).
- **Destructive actions** use `.btn-danger` and confirm first.
- **Forms**: labels above controls (`.field`), one primary button, errors in an
  `ErrorBox` or `.callout-error` with `role="alert"` next to the form.
- **Accessibility**: real `<button>`/`<a>` elements, labelled controls, visible
  focus (provided globally; never remove outlines), `aria-current="page"` on
  the active nav link, `aria-hidden` on decorative icons, `aria-label` on
  icon-only buttons.

## Adding to the system

When nothing existing fits:

1. **New colour or size:** add a token to `styles.css` with a value in both
   the light and the dark block, named by role (`--warn-border`), not by colour.
   The contrast check must still pass.
2. **New reusable class:** add it to `styles.css` under the matching section,
   built from tokens, and list it in [Components](#components) in this file in
   the same PR.
3. **Page-specific styling:** a page stylesheet next to the page
   (`pages/Foo.css`, imported by the page), tokens only, classes prefixed with
   the page (`.foo-…`).
4. **Semantic hook class** (used by tests or as a modifier family, never
   styled): add it to `SEMANTIC_HOOKS` in `design-system.test.ts` with a
   one-line reason.
5. **A change to the direction itself** (palette, typeface, navigation model)
   needs a new ADR that supersedes the relevant part of ADR 0009.

## UI change checklist

Before opening a PR that touches `apps/web`:

- [ ] Uses existing components and classes; anything new is added per [Adding to the system](#adding-to-the-system)
- [ ] Loading, error and empty states handled
- [ ] Checked in light and dark, at desktop width and at 390px; screenshots in the PR
- [ ] Keyboard: everything reachable with Tab, focus visible, icon buttons labelled
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass (includes the design-system check)
