# Afe design system

This is the binding reference for every change to the web UI (`apps/web`). It
implements [ADR 0009](decisions/0009-web-ui-design-system.md), the type scale of
[ADR 0012](decisions/0012-readable-type-scale.md), the tool colours of
[ADR 0013](decisions/0013-tool-colour-coding.md), the Ink base of
[ADR 0015](decisions/0015-ink-design-language.md) and the Spectrum design language
of [ADR 0017](decisions/0017-spectrum-design-language.md). Humans and
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
   of `styles.css`, and none in `.ts`/`.tsx`. **[enforced]**
3. **Every `var(--…)` must be a token defined in `styles.css`.** Do not
   invent tokens in page stylesheets or redefine them under `:root` elsewhere.
   **[enforced]**
4. **Themes are tokens, not overrides.** Only `styles.css` may contain
   `prefers-color-scheme`. A page that looks right in light mode with tokens is
   right in dark mode. The dark tokens appear twice in `styles.css` (OS setting and
   the in-app `data-theme="dark"` choice) and must stay identical. **[enforced]**
5. **Every class used in markup must be styled**, or be listed (with a reason)
   in `SEMANTIC_HOOKS` in the test. An unstyled `className` is a bug: it renders
   as browser defaults. **[enforced]**
6. **Inline `style` is for geometry only** (`left`, `top`, `width`, `height`,
   `display`, `transform`, computed from data). Never colours, fonts, spacing,
   borders or shadows. **[enforced]**
7. **Fonts come only from the tokens.** `font-family` is always `var(--font)`
   (Geist) or `var(--mono)` (Geist Mono); the only font packages are
   `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`, never a
   CDN. No external `url(http…)` in CSS. **[enforced]**
8. **Text tokens meet WCAG AA** (≥ 4.5:1) on `--bg`, `--surface` and
   `--surface-2` in both themes: `--text`, `--text-2`, `--muted`, `--accent`,
   `--ok-text`, `--warn-text`, `--bad-text` and every `--<tool>-text`. Also each
   status text on its tint (`--ok-bg`, `--bad-bg`, `--warn-bg`), `--on-accent` on
   `--accent-solid`, and each tool's logo (`--<tool>-text`) on its tile.
   Changing a token value re-runs this check. **[enforced]**
9. **Strokes meet 3:1.** Every tool stroke (`--<tool>`) and status stroke (`--ok`,
   `--warn`, `--bad`) is ≥ 3:1 on all three surfaces in both themes, and `--muted`
   keeps ≥ 4.5:1 on the densest point of the page aurora. **[enforced]**
10. **Every tool is complete.** Each logo in `TOOL_PATHS` (`icons.tsx`) has
    `--<tool>`, `--<tool>-text` and `--<tool>-tile` in light and dark and a
    `.t-<tool>` class. A new connector fails the build until it has its colours.
    **[enforced]**
11. **The spectrum has five jobs and no others.** `--sp-*`, `--spectrum`,
    `--aurora` and tokens built from them appear only in the selectors listed in
    `SPECTRUM_SELECTORS` in the test (Afe itself, selection and focus, live,
    Afe's inferences, all-tools summaries), and never in `.ts`/`.tsx`. Adding a
    selector there is a design decision recorded in ADR 0017. **[enforced]**
12. **Colours keep their jobs.** Tool tokens (`--<tool>*`, `--t*`) never appear in
    a status rule (`.s-*`, `.si`, `.tri`, `.outcome*`, `.health*`, `.status*`,
    `.conf*`, `.gap-*`, `.severity*`, …), and status tokens (`--ok*`, `--warn*`
    including `--warn-fill`, `--bad*`, `--conf-*`) never appear in a tool rule
    (`.t-*`, `.lg*`, `.tm`, `.tool-badge`, `.tool-mark`). **[enforced]**
13. **Status is a solid shape plus a word.** `OutcomeBadge`, `HealthBadge`,
    `StatusBadge` and every status family render through `StatusWord`/`StatusMark`:
    a filled disc, a filled triangle (warn) or the spectrum ring (in progress),
    never an outline icon and never without the word. **[enforced]**
14. **No built-in environment styling.** No selector keys on environment names or
    kinds (`env-prod`, `[data-kind="staging"]`, …), and no built-in kind word as a
    label beside an environment's name (`{env.kind}`, a kind picker). Only `.pl`
    (production-like) may be styled or labelled: `EnvironmentChip` renders the
    outline chip, or the solid ink chip with a shield for production-like.
    **[enforced]**
15. **Legend wherever colour codes tools.** Every page file that renders tool
    marks (`ToolBadge`, `ToolMark`, `.t-*`) also renders `<ToolLegend>`, unless it
    is listed with a reason in `LEGEND_EXEMPT` in the test. **[enforced]**
16. **Meaning is never carried by colour alone.** Every coloured state also has
    a word, a shape or an icon.
17. **Check light and dark** for every visual change, at desktop width and at
    390px wide, and attach screenshots to the PR.

## Principles

- **Spectrum on an ink base.** Cool neutral greys, 1px hairlines, ink buttons,
  links and navigation. Sections are divided by hairlines and whitespace rather
  than boxed. Colour has three jobs: it says which **tool** a thing came from (the
  tool's own brand colour), it marks **status** (solid shapes in their own hues),
  and Afe's own **spectrum** marks Afe itself, focus and selection, live states,
  Afe's inferences and all-tools summaries.
- **Anything multi-hue is Afe's; anything single-hue is a tool or a status.** No
  tool is multi-hue, so focus and selection can never be read as a tool.
- **Every colour has a job, and a legend.** Wherever colour codes tools, the
  `ToolLegend` names them. Colour is never decoration. Glows are rare: focus,
  selection, live, and at most one attention item per page (the gap panel).
- **Airy shell, compact data.** Page headers, forms and settings breathe; the
  timeline, tables and matrix keep tight rows. 15px body, 14px dense rows,
  nothing below 12px, tabular numerals, monospace only for identifiers.
- **Say what is known and how sure Afe is.** The UI never hides uncertainty;
  it shows it quietly and consistently ([Status language](#status-language)).

## Tokens

All tokens live in `apps/web/src/styles.css`: light values in `:root`, dark
values in `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }`
and again, identically, in `:root[data-theme="dark"] { … }` (the in-app theme
choice, `theme.ts`). Use the token whose **role** matches, not the one whose
colour looks right.

### Colour roles

| Token                                                     | Use for                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `--bg`                                                    | Page canvas                                                                                |
| `--sidebar`                                               | Sidebar background                                                                         |
| `--surface`                                               | Cards, tables, inputs, menus                                                               |
| `--surface-2`                                             | Hover rows, subtle fills, code blocks, reconciled and backfilled rows                      |
| `--surface-3`                                             | Pressed states                                                                             |
| `--border`                                                | Default hairlines (cards, tables, dividers)                                                |
| `--border-strong`                                         | Control borders (buttons, inputs), empty meter bars                                        |
| `--text`                                                  | Primary text, titles                                                                       |
| `--text-2`                                                | Secondary text (cell content, descriptions inside cards)                                   |
| `--muted`                                                 | Labels, metadata, timestamps, placeholders (the third text level, ≥ 4.5:1)                 |
| `--ink` / `--on-ink`                                      | Ink fills and the focus outline; text on ink                                               |
| `--accent`                                                | Links and accent text: ink                                                                 |
| `--accent-solid` / `--accent-solid-hover` / `--on-accent` | Primary button and filled-control fill (ink) and its text                                  |
| `--accent-soft`                                           | Neutral selected backgrounds                                                               |
| `--ok` / `--ok-text` / `--ok-bg`                          | Succeeded, healthy, certain: stroke (shapes, rules), text, tint                            |
| `--warn` / `--warn-text` / `--warn-bg` / `--warn-border`  | Pending, degraded, observation gaps, probable (gold)                                       |
| `--warn-fill`                                             | Bright yellow, only for warn tints, hatches and glows                                      |
| `--bad` / `--bad-text` / `--bad-bg`                       | Failed, revoked, weak, conflict, alerts (crimson)                                          |
| `--conf-*`                                                | Confidence ramp (see [Status language](#status-language))                                  |
| `--<tool>` / `--<tool>-text` / `--<tool>-tile`            | A tool's brand colour: stroke (≥ 3:1), text (≥ 4.5:1), logo tile. Read through `.t-<tool>` |
| `--t` / `--t-text` / `--t-tile`                           | Set by `.t-<tool>`; what tool marks, badges, legend entries and strokes read               |
| `--sp-1`…`--sp-4` / `--spectrum`                          | Afe's spectrum (magenta, violet, blue, cyan): its five jobs only (rule 11)                 |
| `--on-spectrum`                                           | The "a" on the Afe tile                                                                    |
| `--tint` / `--glow-a` / `--aurora`                        | The only alphas for tints, glows and the page aurora                                       |

Tools today: `github` (ink), `ghactions` (GitHub Actions blue `#2088FF`), `argocd`
(orange-red `#FE6446`, deepened in light), `vercel` (ink), `terraform` (violet).

### Type, space, shape, depth, motion

| Group          | Tokens                                                                                                                                                                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Font families  | `--font` (Geist), `--mono` (Geist Mono)                                                                                                                                                                                    |
| Font sizes     | `--fs-xs` 12px (counts, overlines) · `--fs-sm` 13px (badges, labels, meta, table heads) · `--fs-md` 14px (controls, dense rows) · `--fs-base` 15px (body) · `--fs-lg` 18px (section titles) · `--fs-xl` 30px (page titles) |
| Line height    | `--lh` 1.55 (running text) · `--lh-dense` 1.45 (rows, cells, callouts) · `--lh-tight` 1.25 (headings)                                                                                                                      |
| Spacing        | `--space-1` 4px · `--space-2` 8px · `--space-3` 12px · `--space-4` 16px · `--space-5` 24px · `--space-6` 32px · `--space-7` 48px (page padding)                                                                            |
| Radius         | `--radius-pill` (buttons, nav items, chips, badges) · `--radius-sm` 8px (inputs) · `--radius` 12px (tables, callouts, inline forms) · `--radius-lg` 16px (dialogs, sign-in card)                                           |
| Control height | `--control-h` 36px                                                                                                                                                                                                         |
| Elevation      | None at rest (`--shadow-xs` and `--sheen` are transparent) · `--shadow-sm` (sign-in card, pressed theme switch) · `--shadow-md` (popovers, toasts) · glows only for focus, selection, live and one attention item          |
| Motion         | `--dur` 120ms · `--ease`; respect `prefers-reduced-motion` (handled globally)                                                                                                                                              |
| Layout         | `--dialog-w` (confirmation dialog width) · `--sidebar-w` · `--topbar-h` · `--sticky-top` (use for any `position: sticky` offset)                                                                                           |

Prefer the spacing and size tokens for new CSS. Some older page rules still
use literal `rem` values; convert them when you touch those rules.

## Typography

- **Geist** for all UI text. **Geist Mono** only for identifiers: commit
  SHAs, image references, event types (`deployment.created`), times in
  timelines, rule expressions. Never for prose or labels.
- Page title: `h1` (`--fs-xl`, weight 650, -0.035em), with the spectrum title
  accent under it inside `.page-header` (`.h-acc` elsewhere). Section title: `h2` (`--fs-lg`).
  Card title: `h2` (or a first-child `h3`) inside `.card`, shown at `--fs-lg`;
  later `h3`s in a card are subsections at `--fs-base`.
- Body text has no negative letter spacing; only headings are tightened.
  Identifiers are always mono, where `l`, `I` and `1` are distinct.
- Labels are muted and values are `--text` (`.kv`, `.field`); ledes use
  `--text-2`. There is no colour lighter than `--muted` for text.
- Never set a font size below `--fs-xs` (12px), and use the size tokens, not
  literal `rem`/`px` font sizes.
- Table headers and day headings: `--fs-sm`, sentence case, `--muted`. No
  uppercase overlines.
- Numbers that line up (tables, times, counts): `font-variant-numeric:
tabular-nums` (already on `.table`, `.row-time`).
- Sentence case everywhere ("Add a connection", not "Add A Connection"); no
  `text-transform: uppercase`. **[enforced]**

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
  <ToolLegend />                   {/* when the page colour-codes tools */}
  <GapBanners connections={…} />   {/* when the page shows observed data */}
  {/* filters (.filters), then content: .card, .table-wrap, .events, … */}
</div>
```

- `<main>` draws the page aurora (a faint spectrum wash fading out within 260px)
  behind the page header. Do not put data in the first 260px without a surface.
- Wide data pages may widen `.page` with a page class (see `.page.env-page`,
  `.page.journey-page`).
- Group content in `.card`s: a section under a hairline, not a box. Start a
  section with `SectionHead` (title, optional count and hint, and the section's
  main action on the right). Two sections side by side: `.grid-2`.
- Back links sit above the `h1`: `<Link to="/events">← Events</Link>`.
- Pages shown before sign-in (sign-in, invitation, reset) use the auth card:
  `<div className="login"><section className="card login-card"><BrandMark />
  <h1>…</h1>…</section><p className="login-foot">…</p></div>`.

## Components

### React components (`components.tsx`, `icons.tsx`, `pages/environments-ui.tsx`)

Use these instead of re-creating their markup.

| Component                                                                    | Use for                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Loading`                                                                    | Any loading state (`role="status"`, spinner)                                                                                                                                                                                                                                                                                      |
| `ErrorBox`                                                                   | Any failed request; pass `onRetry` when retrying makes sense                                                                                                                                                                                                                                                                      |
| `Empty`                                                                      | Empty states; pass `icon={icons.x}` for first-run screens                                                                                                                                                                                                                                                                         |
| `KeyValue`                                                                   | Label/value details (`.kv`); never a bare `<dl>`                                                                                                                                                                                                                                                                                  |
| `GapBanners`                                                                 | Open observation gaps on any page that shows observed data                                                                                                                                                                                                                                                                        |
| `ToolBadge`                                                                  | Naming a source tool: logo tile plus name, in the tool's colour                                                                                                                                                                                                                                                                   |
| `ToolLegend`                                                                 | The sticky legend under the page header wherever colour codes tools; pass `connections` (source and status) when the page has loaded them, or `sources` for the tools on screen, and `keys` for the page's own keys. It counts only tools with an active connection; others on screen show as `.lg-off` with the reason (AFE-119) |
| `OutcomeBadge`, `HealthBadge`, `StatusBadge`, `MethodBadge`                  | Event outcome, connection health, connection status, observation method                                                                                                                                                                                                                                                           |
| `StatusWord`, `StatusMark`                                                   | Any other status: solid shape plus word (`tone` ok, warn, bad, wait, idle, live)                                                                                                                                                                                                                                                  |
| `ProvenancePill`                                                             | Whether Afe inferred a value (spectrum dot, "inferred", confidence) or a person set it ("set by …")                                                                                                                                                                                                                               |
| `LiveIndicator`                                                              | "Afe is watching this happen now" (spectrum pulse)                                                                                                                                                                                                                                                                                |
| `ConfidenceBadge`, `CertaintyBadge`, `KindBadge`, `GapFlagBadges`, `TimeAgo` | Placement confidence, kind, gap flags and relative times                                                                                                                                                                                                                                                                          |
| `ScopeNotice`                                                                | Notice that a view is limited to the user's permissions                                                                                                                                                                                                                                                                           |
| `SectionHead`                                                                | A section's title, optional count and hint, and its main action                                                                                                                                                                                                                                                                   |
| `OperationDialog` (`OperationDialog.tsx`)                                    | Operation review and confirmation in a native modal                                                                                                                                                                                                                                                                               |
| `useToast` (`toast.tsx`)                                                     | Confirming an action the user just took (see [Patterns](#patterns))                                                                                                                                                                                                                                                               |
| `icons.*`, `BrandMark`, `ToolMark`                                           | 16px Lucide line icons (`aria-hidden`), the Afe wordmark (spectrum dot) and tool logos (`tile` puts one on its brand tile)                                                                                                                                                                                                        |
| `useAsync`, `useDocumentTitle`                                               | Data loading with abort; the tab title (`"Title · Afe"`)                                                                                                                                                                                                                                                                          |

### CSS classes (`styles.css`)

| Need             | Class                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buttons          | `.btn` (secondary, default) · `.btn-primary` (one per view, the main action) · `.btn-ghost` (toolbar and row actions) · `.btn-danger` (destructive) · `.btn-icon` (round, needs `aria-label`) · `.btn-sm` (section and row actions) · `.btn-wide` (full width, auth card) · `.btn-link` (a button that reads as a link) |
| Button groups    | `.toolbar`, `.button-row` (`.actions` is an alias) · `.segmented` (toggle group; set `aria-pressed`)                                                                                                                                                                                                                    |
| Forms            | `.form` (vertical form) · `.field` (label + control) · `.check` (checkbox/radio + label) · `fieldset`/`legend` · `.joined` (select + input pair) · `.inline-form` (a creation form opened in place) · `.form-pair` (two fields side by side) · `.form-end` (right-aligned buttons)                                      |
| Filters          | `.filters` (filter bar card) · `.chips` / `.chip` (active filters, removable)                                                                                                                                                                                                                                           |
| Containers       | `.card` · `.grid-2` · `.section-head` / `.section-title` / `.count` · `.table-wrap` + `.table` (`.num`, `.row-actions` cells) · `.kv` · `.json` (raw data)                                                                                                                                                              |
| Lists            | `.events` / `.event-row` / `.row-link` (timeline rows) · `.entity-list` with `.entity-main` / `.entity-name` / `.entity-meta` / `.entity-order` / `.entity-actions` (named things) · `.inline-list` · `.plain` · `.conn-list`                                                                                           |
| Callouts         | `.callout` + `.callout-error` / `.callout-ok` / `.callout-gap` / `.callout-reconciled`                                                                                                                                                                                                                                  |
| Toasts           | `.toasts` / `.toast` + `.toast-ok` / `.toast-info` / `.toast-error` (rendered by `ToastProvider`; do not write this markup by hand)                                                                                                                                                                                     |
| States           | `.state` (inline status text) · `.spinner` (loading) · `.empty` (+ `.empty-icon`) · `.end` (end of list)                                                                                                                                                                                                                |
| Badges           | `.badge` + a modifier from [Status language](#status-language)                                                                                                                                                                                                                                                          |
| Text             | `.muted` · `.small` · `.lede` · `.mono-title` · `.hash` · `.sr-only`                                                                                                                                                                                                                                                    |
| Navigation cards | `.connect-buttons` / `.connect-card`                                                                                                                                                                                                                                                                                    |
| Tools            | `.t-<tool>` (sets `--t*`) · `.tm` (logo tile) · `.tool-badge` · `.tool-mark` · `.legend` / `.lg` / `.lg-off` + `.lg-state` (not observing) / `.lg-sw` / `.legend-keys` / `.key-sp` / `.key-gap` · `.dim` (faded by the legend)                                                                                          |
| Status shapes    | `.si` (solid disc) · `svg.tri` (solid warn triangle) · `.spin` (spectrum in-progress ring) · `.s-ok` / `.s-warn` / `.s-bad` / `.s-wait` / `.s-idle` / `.s-live` (set `--s`, `--s-text`)                                                                                                                                 |
| Afe              | `.live` + `.pulse` · `.prov` + `.inf-dot` / `.prov-set` · `.h-acc` (title accent outside `.page-header`) · `.avatar` (spectrum ring)                                                                                                                                                                                    |
| Shell            | `.theme-switch` (System / Light / Dark, `aria-pressed`) in the sidebar account area                                                                                                                                                                                                                                     |

## Status language

Afe's core value is saying what is live and how sure it is. Use these
encodings, the same way on every page.

- **Status** (`StatusWord`, `StatusMark`): always a **solid shape plus a word**.
  A filled disc for ok (check), bad (cross), waiting (clock) and neutral states
  (minus); a filled triangle for warn; a spectrum ring for in progress, because
  in progress is live. Warn is gold, bad is crimson, so neither shares Argo CD's
  orange-red; tools never draw solid shapes.
- **Confidence** (`.badge.conf.conf-<level>`, or `ConfidenceBadge`): a four-bar
  meter on the status ramp plus the word. `certain` four green bars · `strong`
  three green · `probable` two warn · `weak` one bad · `ambiguous` a dashed meter ·
  `unknown` empty. Journey edges use the same `--conf-*` colours with solid,
  dashed or dotted lines.
- **Outcome** (`OutcomeBadge`), **Health** (`HealthBadge`), connection **status**
  (`StatusBadge`), drift **severity** and **status**: the status shape plus a word.
- **Tool** (`ToolBadge`, `.t-<source>`): the tool's real logo on its brand tile and
  its name in the tool's text colour. Tool colour appears only on a tool's marks,
  strokes, rails and tiles, never on status, buttons, navigation, page backgrounds
  or text other than the tool's own name. Every such page shows `ToolLegend`.
- **Afe's inferences** (`ProvenancePill`): a spectrum dot, "inferred" and the
  confidence meter; or a person icon and "set by _name_". A person's choice always
  wins over Afe's guess.
- **Live** (`LiveIndicator`, the in-progress ring): Afe's spectrum, never ok-green.
- **Observation gaps:** the loud form is `GapBanners`, one panel per page, at
  the top, with a warn edge and a soft yellow glow (the page's one attention
  item). The per-item form is `.gap-badge`: a solid triangle and the word on a
  faint yellow tint, e.g. "possibly stale". Never hatch, stripe or fill whole
  rows or cells for a gap.
- **Late observation:** `.row-reconciliation` and `.row-backfill` mark rows with a
  neutral tint plus a note; `MethodBadge` names the method with an icon.
- **Alerts:** `.alert-badge` ("Alert open"), linking to where the full message
  is shown. Do not put long alert prose in tables.
- **Severity** (drift): high and critical are bad, medium is warn; low is neutral.
- **Focus and selection** belong to Afe: a 2px ink outline at a 2px offset plus a
  two-hue spectrum halo for focus; a spectrum border with a two-hue glow for a
  selected cell (`[aria-selected="true"]`, `[aria-pressed="true"]`). A journey
  highlight in the timeline is a filter, shown with an ink rule.
- **Environments** are the org's: one look for all, no hue per environment, no
  built-in dev/staging/prod styling or labels. Only production-like (`.pl`) may
  differ (`EnvironmentChip`).

Accents for emphasis on a row or card are a **2px** inset rule
(`box-shadow: inset 2px 0 0 var(--…)`), never thicker borders.

The `.operation-dialog` class styles `OperationDialog` with theme tokens.
User deletion names the selected account, states the actual cleanup and retention
effects, and keeps errors in the dialog for retry. Cancel receives initial focus;
Escape and cancellation are blocked during submission.

## Patterns

- **Loading → error → empty → data.** Every data view handles all four, with
  `Loading`, `ErrorBox`, `Empty` and then the content.
- **Refreshing resource data** retains valid content with a neutral loading indicator.
  Treat changed resource dependencies as unresolved immediately; never render old
  data under a new selection. Operation controls stay blocked while resource state
  or capabilities are unresolved. See [loading-state behavior](loading-states.md).
- **Empty states** say what the view will show and the next step, with a link
  or button to it. First-run screens (no connections yet) pass an `icon`.
  Filtered-to-nothing states suggest widening the filters.
- **Tool account not linked yet** (AFE-118) is an expected state, not an error:
  tool pages render a failed first load with `ToolPageError`
  (`pages/tool-link.tsx`), which shows an `Empty` with a link to Profile for a
  `403` whose `reason` is `tool_not_linked` or `named_user_required`, and
  `ErrorBox` for anything else, including real permission errors.
- **Tables** go in `.table-wrap`. Headers are short nouns. Row actions are
  `.btn-ghost` buttons or links at the end of the row; destructive actions ask
  for confirmation.
- **Creating things** (AFE-85): a section's "Add …" button (`.btn.btn-sm` with
  `icons.plus`, `aria-expanded`) opens an `.inline-form` in place with Cancel and
  a primary Save. Never hide a creation form behind an arrow (`<details>`).
  `<details>` is for optional reading (raw data, legends) and renders as a
  labelled chevron toggle.
- **Lists of named things** (AFE-83) use `.entity-list`: the name in `strong`,
  the identifier in `code`, metadata in `.entity-meta`, and icon-only
  `.btn-ghost.btn-icon.btn-sm` actions in `.entity-actions`, each with an
  `aria-label` and a matching `title`.
  The Users list uses a full-row selection button (`.users-row` in `Users.css`),
  with a wrapping name and optional email, an aligned neutral status badge and
  a manage icon. `aria-pressed` exposes selection; selection tokens and the
  global focus ring distinguish selected and keyboard-focused rows.
  The permissions editor sits beside the list on wide screens and below it on
  smaller screens (`.users-workspace`). A sticky identity header carries the same
  selection rule and a "Change user" link; selecting a user focuses that heading.
  User search matches usernames (the current display identity) and email addresses
  without regard to case; results are paged by ten. Filtering or paging does not
  change the selected user. After user selection, a labelled Tool button opens a
  searchable popover of the tools returned by the permissions API. Only the
  selected tool's editor is displayed. Tool sections show the saved access mode,
  label unsaved changes, and name the user beside Save and in permission feedback.
  User and tool selection are disabled during a save. Changing either selection
  remounts the editor and discards unsaved drafts; saved policies remain available
  when returning to a tool. The picker focuses search on opening, supports Tab and
  Enter for choices, and closes on Escape, outside click or focus leaving it.
- **Pickers** with many options (the GitHub repository picker) are a labelled
  button that opens a search popover (`role="dialog"`), closed by Escape or a
  click outside, returning focus to the button.
  The workflow ref picker uses the same popover: it displays the selected ref
  when closed and opens with empty, focused search. Branches and tags are merged
  across pages, deduplicated and sorted alphabetically. Escape, outside click or
  focus leaving dismisses without changing selection. Tab and Enter select an
  option; entering an explicit ref or SHA also works. Loading a selected ref
  remains explicit before dispatch so its input schema matches the dispatch ref.
  `.gh-ref-picker` keeps the menu within the viewport and allows it to extend
  beyond the workflow list without clipping.
- **Row actions that repeat on every row** of a long list are shown on hover
  and focus only (see `.event-row.has-action`); touch screens always show them.
- **Identifiers**: short SHA (7 characters) in `<code>`, full value in `title`.
  Times: absolute in `title` / `dateTime`, relative in the text (`TimeAgo`).
- **Tool operation confirmations** use `OperationDialog`, mounted only while reviewing
  an operation. This applies to GitHub Actions (including recovery), connection
  disconnects for every tool, and future integrations. Supply an operation-specific
  `title` and `confirmLabel`, a `description` naming the target and consequences,
  optional input controls or a summary as children, and `onConfirm` / `onCancel`.
  Preparation, validation and execution errors stay inside the dialog (`error`);
  use `busy`, `pendingLabel` and `confirmDisabled` while preparing or submitting.
  Keep the caller's synchronous submission guard and existing authorization,
  version checks and request IDs. Only the explicit confirmation button executes;
  do not submit on Enter in an input. Cancel, Escape and backdrop clicks dismiss
  idle dialogs without executing. During a request, dismissal is held until the
  result is known. Native modal behavior contains focus and makes the page inert;
  initial focus is Cancel, and closing restores the trigger with `preventScroll`.
  The dialog overlays the current selection without scrolling to a separate panel
  or shifting the list. Do not replace editing workspaces with modals; show their
  submitted inputs when confirming the resulting operation.
- **Destructive actions** use `.btn-danger` and confirm first.
- **Confirmations are toasts, state is a callout.** After an action succeeds
  ("Saved", "Invitation queued", "disconnected"), call `useToast()` instead of
  rendering a banner on the page: `toast("Saved.")`, or
  `toast({ message, action: { label, to } })` for a next step. Toasts sit at the
  bottom right, leave after a few seconds (they wait while hovered or focused)
  and carry an icon and a screen-reader word as well as the colour rule. Errors
  from a form or a page load stay in an `ErrorBox` next to what failed; use
  `kind: "error"` only for a failure with no place on the page. Anything the user
  must read again later (a one-time credential, observation gaps, a read-only
  check) stays a callout.
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
5. **A new tool:** its logo in `TOOL_PATHS`, `--<tool>`, `--<tool>-text` and
   `--<tool>-tile` in light and both dark blocks (chosen by the rule in ADR 0017
   decision 1), a `.t-<tool>` class, and its label in `toolLabel`.
6. **A new use of the spectrum:** only for one of its five jobs, and only by adding
   the selector to `SPECTRUM_SELECTORS` with a note in ADR 0017. A new job needs a
   new decision.
7. **A change to the direction itself** (palette, typeface, navigation model)
   needs a new ADR that supersedes the relevant part of ADR 0017.

## UI change checklist

Before opening a PR that touches `apps/web`:

- [ ] Uses existing components and classes; anything new is added per [Adding to the system](#adding-to-the-system)
- [ ] Loading, error and empty states handled
- [ ] Checked in light and dark (switch with the theme control), at desktop width and at 390px; screenshots in the PR
- [ ] Keyboard: everything reachable with Tab, focus visible, icon buttons labelled
- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass (includes the design-system check)

The Vercel delivery workspace uses the existing section, entity-list, inline-form,
KeyValue and OperationDialog patterns. Scope and preparation are refreshed before
a consequential operation; the dialog shows project/build/parameters and retains
the request UUID after an ambiguous network response.

## ArgoCD workspace

The ArgoCD workspace uses existing fields, checkboxes, tables, entity lists and
`OperationDialog` for preparation, explicit consent, confirmation and recovery.
Action capabilities include a source permission/state explanation. A retained
callout names acceptance or uncertainty; it never implies deployment completion.
