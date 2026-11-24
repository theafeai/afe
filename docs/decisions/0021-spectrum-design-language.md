# ADR 0021: Spectrum design language

- Status: Accepted
- Date: 2026-11-23
- Decided by: the product owner, after reviewing three directions and three revisions of
  the chosen one
- Supersedes: parts of [ADR 0013](0013-tool-colour-coding.md) and
  [ADR 0015](0015-ink-design-language.md), listed exactly under "What this supersedes".
  Everything else in ADRs 0009, 0012, 0013 and 0015 stands.

## Context

Ink (ADR 0015) is black and white, with colour reserved for signal. It reads as precise
but too plain: Afe should feel modern and vivid, with colour clearly present but
limited. Three directions were mocked up on the same screens; the product owner chose
**Spectrum**, in which colour identifies the source tool, gradients mark hand-offs
between tools, glows are rare, and status keeps its own hues.

Three refinements followed. Tools use their **own brand colours**, with an
**always-visible legend**, rather than a designed palette. Afe's own multi-colour
gradient takes a bigger, rule-bound role, so that an org whose tools are all black and
white still opens onto colour. Argo CD keeps its orange-red, and GitHub Actions becomes
its own tool in its own blue.

Afe also adapts to each org's delivery process and never imposes one. No screen may
assume fixed environments (dev, staging, prod), a fixed stage order, one commit per
deployment, automatic or approval-gated production, or a particular cadence. Afe infers
an org's environments and process from what its tools report, each with a confidence,
and an admin can confirm or override any of it; a person's choice always wins over
Afe's guess.

## Decision

**Direction: Spectrum.** A calm neutral base (Ink's greys, hairlines and shapes) where
colour has three jobs. It says which tool a thing came from (brand colour), it marks
hand-offs between tools (gradients), and it marks the few things that need attention
(glows). Status keeps its own hues.

1. **Tool colour = brand colour.** Each tool has three tokens per theme, all in its
   brand hue: `--<tool>` (stroke, ≥ 3:1 on every surface), `--<tool>-text` (≥ 4.5:1) and
   `--<tool>-tile` (logo tile fill, logo on it ≥ 4.5:1). The colour is taken from the
   tool's official logo by this rule: prefer the tool's **most recognisable** colour,
   even near a status hue (the status treatment in decision 8 carries the difference).
   Fall back to another logo colour only when the brand colour is practically a status
   colour, and fall back to **ink** for black-and-white brands. Derive the stroke and
   text values in the same hue, using the pure brand value wherever it passes. A
   product with its own logo and its own kind of events inside a larger brand is its
   own tool (GitHub Actions within GitHub). Values today:

   | Tool           | Light stroke / text / tile        | Dark stroke / text / tile         |
   | -------------- | --------------------------------- | --------------------------------- |
   | GitHub         | `#24292F` / `#24292F` / `#EDEFF2` | `#F0F6FC` / `#F0F6FC` / `#1F242D` |
   | GitHub Actions | `#2088FF` / `#1767CC` / `#E7F1FF` | `#2088FF` / `#2088FF` / `#132339` |
   | Argo CD        | `#E84A2A` / `#C63A1E` / `#FFEDE8` | `#FE6446` / `#FE6446` / `#2C1915` |
   | Vercel         | `#000000` / `#000000` / `#EDEFF2` | `#FFFFFF` / `#FFFFFF` / `#1F242D` |
   | Terraform      | `#844FBA` / `#844FBA` / `#F1EAF9` | `#844FBA` / `#B892EA` / `#231B30` |

   Argo CD's brand orange-red `#FE6446` is used as is in dark mode and deepened (same
   hue) in light mode, where the pure value is below 3:1 on white. There is no cap on
   the number of tools. A new tool adds its tokens and its logo.

2. **Shared colours.** When two connected tools resolve to the same colour (two ink
   brands), the logo tells them apart everywhere. In area charts the later tool gets a
   dot texture, and the legend shows it.
3. **Legend, always.** Every screen that colour-codes tools shows a sticky legend under
   the page title. It lists only the tools the tenant has connected, each with its real
   logo, name and swatch, plus a short key for whatever else that screen codes and
   Afe's own key ("Afe: all tools, live, selected"). Hovering or focusing an entry fades
   the other tools.
4. **Where tool colour appears**: tool logos, logo tiles and badges; the fading top
   stroke of a matrix cell; the ring of an event's logo node on the timeline spine;
   journey lanes (a faint tint), step borders and rails; timing rails and chart
   segments. It never appears on status, buttons, navigation, page backgrounds or text
   other than a tool's own name.
5. **Gradients.** Brand-to-brand gradients mark hand-offs between tools. Afe's own
   **spectrum** (magenta `#E14BD2`, violet `#7B61FF`, blue `#3A8DFF`, cyan `#1FC8E3`)
   has exactly these jobs:
   1. **Afe itself**: the brand dot and the Afe tile, the page **aurora** (a four-hue
      wash at the top of each page, at most `--aurora` alpha, fading out within 260px,
      never behind data), the page-title accent bar, and the active navigation (rail
      plus wash; a spectrum-bordered pill on a phone).
   2. **Selection and focus** (decision 6).
   3. **Live**: the live pulse and the in-progress spinner. A running item keeps its
      tool-coloured glow.
   4. **Afe's inferences**: a spectrum dot marks what Afe inferred, next to its
      confidence.
   5. **All tools together**: aggregate views across tools (for example deployments
      per day). Their split by tool uses brand colours.

   Gradients are never used for text, status, buttons or a single tool. The exact
   selectors allowed to read the spectrum are listed in `SPECTRUM_SELECTORS` in
   `apps/web/src/design-system.test.ts`. Adding a selector for one of the five jobs
   (for example the selected step of the journey diagram, or a spinner on a new
   screen) is recorded there; any new job needs a change to this list.

6. **Focus and selection belong to Afe, never to a tool.** Anything multi-hue is Afe's,
   and anything single-hue belongs to a tool or a status. Focus is a 2px ink outline at
   a 2px offset plus a two-hue spectrum halo. Selection is a spectrum border with a
   two-hue glow. This replaces the single selection blue, which a blue brand could now
   share.
7. **Glows** appear only for focus, selection, live or running states, and at most one
   attention item per screen. There are no resting shadows, as in Ink.
8. **Status** (`--ok`, `--warn`, `--bad` and their `-text` values) is always a **solid
   shape + word**: a filled disc for ok (✓) and bad (✕), and a filled triangle for warn
   (!). Tools never draw solid shapes, only logos, strokes, rails and tiles. Warn is gold
   (~45°) and bad is crimson-rose (~347°), so neither shares Argo CD's hue (~10°). Warn
   tints, hatches and glows use the bright `--warn-fill` yellow. Confidence is a four-bar
   meter plus a word, on the status ramp; ambiguous is a dashed meter.
9. **Environments** are whatever the tenant has, in its order. They have one look (an
   outline chip). Environments flagged **production-like** get the solid ink chip with a
   shield icon. There is no hue per environment and no built-in dev, staging or prod
   styling. Each environment, each inferred setting and the process summary show their
   **provenance** in a pill: either **Afe inferred it** (spectrum dot, the word
   "inferred", a confidence meter and, where there is room, the reason), or **a person
   set it** (person icon, "set by _name_" and when). A value a person set offers "Use
   Afe's guess" to hand it back to inference. An **Adjust** control sits next to the
   process summary.
10. **The journey is derived, not templated, and drawn as a diagram.** Lanes are the
    tools that took part. Each step is a logo node on its lane's track, labelled below
    and to the right so lines never cross text; the route changes lane at hand-offs and
    fades between the two brand colours. Columns are moments in time order: parallel
    steps and immediate cross-tool hand-offs share a column (fan-out). A headline per
    environment, in the org's order, says where the change is live and since when.
    Steps that reached an environment are stations with a ring and the environment
    chip. A gap from an approval request to its decision is a hatched warn band across
    all lanes; other long gaps are a labelled dotted break. Steps that carried several
    changes show stacked rings and a count, and "Shipped together" lists every change in
    the deployment. "Where the time went" is one proportional bar (tool colours, idle
    grey, approval hatched) with exact durations. Selecting a step uses the spectrum
    selection. Phones get a vertical step list.
11. **Type.** Geist for UI, Geist Mono for identifiers, bundled with
    `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`. Afe loads no
    fonts from a CDN. Page titles are 30px/650 with -0.035em tracking. The ADR 0012 size
    tokens stay, with `--fs-xl` moving from 28px to 30px.
12. **Logo.** The wordmark "afe" with a spectrum dot. The favicon and the Afe tool mark
    are an "a" on a spectrum tile.

## What this supersedes

**ADR 0013 (tool colour coding):**

- The brand-based tool tokens (`--github` grey, `--argocd` orange, `--vercel` black or
  white, `--terraform` purple, `--afe` the accent) are replaced by decision 1: brand
  colours chosen by the rule, with stroke, text and tile tokens. Argo CD stays
  orange-red and moves to `#FE6446`. GitHub moves from grey to ink. GitHub Actions is
  added as its own tool (`--ghactions`). `--afe` is removed; Afe uses the spectrum.
- Reconciliation in magenta (`--recon`, also `--conf-ambiguous`) is retired, because a
  future brand may be magenta and the spectrum contains it. The teal backfill colour
  (`--backfill`) leaves with it. Reconciled and backfilled rows get a neutral tint; the
  method badge (icon and word) and the note say what happened. Ambiguous confidence is a
  dashed meter.
- "Journey highlights replace the tool rule" is replaced by decision 6 (spectrum
  selection). Status keeps priority as before.
- **Kept**: logos via `ToolMark` (Simple Icons, CC0), "a tool colour never encodes
  status", and the square fallback for tools without a logo.

**ADR 0015 (Ink):**

- "Status, confidence and tool logos are the only colours" is replaced by: colour
  identifies the source tool; status keeps its own hues; Afe owns the spectrum, with the
  five jobs in decision 5.
- Outline status glyphs are replaced by decision 8 (solid shapes), and the warn and bad
  hues move (gold and crimson).
- "One blue for selection (`--select`, `--select-soft`)" is replaced by decision 6.
  `--select*`, `--accent-ring`, `--focus`, `--highlight*` and `--env-selected` are
  removed.
- "Confidence: `--conf-strong` moves from blue to lime" is dropped. Strong is three of
  four green bars.
- "Type: Instrument Sans … JetBrains Mono … page titles 28px/600" is replaced by
  decision 11.
- "Logo: a wordmark with a solid dot; the favicon and the Afe tool mark an 'a' on an
  ink tile" is replaced by decision 12.
- "Rows no longer carry a tool-coloured left rule" is replaced by decision 4. Rows and
  cells carry the tool colour again as a fading top stroke or a logo-node ring, not the
  old 2px left rule.
- "No resting shadows; shadows only for popovers, toasts and the sign-in card" is
  extended by decision 7: glows are allowed for focus, selection, live states and one
  attention item.
- **Kept**: neutral greys and hairlines, the ink primary button and ink links and
  navigation, pill shapes, 8/12/16 radii, `.card` as a section, sentence-case heads,
  Lucide icons, the System/Light/Dark switch and its two identical dark blocks, the
  creation controls (AFE-85) and the structured lists (AFE-83).

## Tokens

Light `:root` and both dark blocks, which stay identical. Values are in
`apps/web/src/styles.css`; `docs/design-system.md` describes each role.

- **Neutrals** (cool): `--bg` `#F6F7F9` / `#0A0C10`, `--surface` `#FFFFFF` / `#12151B`,
  `--surface-2` `#F1F3F6` / `#181C24`, `--border` `#E4E7EC` / `#232833`,
  `--border-strong` `#CDD2DA` / `#353C4A`, `--text` `#0D1117` / `#EDF0F5`, `--text-2`
  `#4A5262` / `#A9B1BF`, `--muted` `#626B7A` / `#8D96A6`, `--ink` the text colour.
- **Status**, stroke and text: `--ok` `#15803D` with `--ok-text` `#127A3A`, `--warn`
  `#A87900` with `--warn-text` `#8A6400`, `--bad` `#E11D48` with `--bad-text`
  `#BE123C`. Dark: `#3DD68C` / `#5EE0A0`, `#FACC15` / `#FACC15`, `#FB7185` / `#FB7185`.
  `--warn-fill` `#FACC15` in both themes, for warn tints, hatches and glows only.
- **Tools**: decision 1.
- **Spectrum**: `--sp-1`…`--sp-4` and `--spectrum` (a 100° linear gradient), the same in
  both themes.
- **Alpha knobs**, the only alphas for tints, glows and the aurora: `--tint` 7% / 10%,
  `--glow-a` 26% / 40%, `--aurora` 9% / 17%. The aurora is capped so that `--muted` text
  keeps ≥ 4.5:1 at its densest point.
- **Type**: `--font` Geist, `--mono` Geist Mono (the old fonts stay as fallbacks in the
  stack), `--fs-xl` 30px.

## Enforcement

`apps/web/src/design-system.test.ts` encodes this ADR (rules in
`docs/design-system.md`):

- Text contrast: `--text`, `--text-2`, `--muted`, `--accent`, the status `-text` tokens
  and every `--<tool>-text` are ≥ 4.5:1 on `--bg`, `--surface` and `--surface-2` in both
  themes; each status text on its tint and each logo on its tile also.
- Non-text contrast: every tool stroke and status stroke is ≥ 3:1 on all three
  surfaces in both themes; `--muted` over the densest aurora is ≥ 4.5:1.
- Tool tokens are complete: every logo in `TOOL_PATHS` has its three tokens in both
  themes and a `.t-<tool>` class.
- Colours keep their jobs: tool tokens never in a status rule, status tokens (including
  `--warn-fill`) never in a tool or legend rule, and the spectrum only in the selectors
  allow-listed for its five jobs.
- Status uses solid shapes: the status components render a disc, triangle or spectrum
  ring with the word, never an outline icon.
- No built-in environment styling: no selector keys on environment names or kinds;
  only `.pl` (production-like) may be styled.
- Legend present: every page file that renders tool marks renders `<ToolLegend>`, with
  a listed exception for files embedded in a page that has one or that name the tool
  beside every mark.
- Fonts: only the Geist packages, no CDN. The dark blocks stay identical.

## Migration

The product stays shippable after every step, each with light and dark screenshots at
desktop width and 390px.

1. **Shell** (this change): tokens and fonts; focus and selection on the spectrum; the
   aurora, title accent, active-nav wash and rail, spectrum brand dot, Afe tile and
   favicon; solid status shapes and the confidence meter; `ToolBadge` as a logo tile,
   the GitHub Actions logo and tokens, `ToolLegend`, `ProvenancePill` and
   `LiveIndicator`; reconciliation, backfill, magenta, lime and the selection blue
   retired; the test rules above.
2. **Tool split and cell strokes**: derive a display tool per event so GitHub Actions
   events (workflow runs, dispatches, deployment reviews, workflow-created deployments)
   show as GitHub Actions; the matrix-cell top stroke and the timeline logo nodes.
3. **New screens**: My changes, Activity, Waiting on whom, the journey diagram
   (decision 10) and the inferred setup with Adjust (decision 9), each built from these
   tokens and components.

## Consequences

- Tools are recognisable at a glance by their real colour and logo, and the legend
  removes the guesswork. Adding a connector means adding three tokens per theme and a
  logo; the tests enforce it.
- Colour no longer depends only on which tools an org connects. Afe's spectrum gives
  every org the same vivid frame, and the brand colours add identity on top. The
  spectrum's jobs are listed and tested, so it cannot spread into decoration.
- Argo CD sits close to the status hues. Status is told apart by shape, word and warn's
  yellow fills, not by hue alone. This needs checking with colour-blind users.
- The selection blue, lime, magenta and teal leave the palette, so the palette is
  neutrals, the connected brands, three status hues (plus the warn fill) and the
  spectrum.
- The journey stops encoding a pipeline and shows what each org actually does:
  previews per change, on-demand environments, approval waits, batches and fan-out.
- Trademarked logos are shown more prominently (legend, hand-off nodes). They are still
  used only to identify integrations.
