# Afe – instructions for coding agents

Read `CLAUDE.md` first: every rule there applies to all agents (Codex, Claude
and others), including ADRs in `docs/decisions/`, migrations, tenancy, logging,
tests and sign-off. This file adds what an agent must not miss.

## Web UI: the Ink design system is mandatory

Any change under `apps/web` (new pages, new features, small fixes) must follow
**`docs/design-system.md`** and the **Ink** design language of
[ADR 0015](docs/decisions/0015-ink-design-language.md) (which builds on ADRs 0009,
0012 and 0013). Read both before writing UI code, and read `apps/web/AGENTS.md`,
which has the detailed checklist. The hard rules:

- **Ink, colour only for signal.** Buttons, links and navigation are ink
  (`--accent*`). The only colours are status (`--ok`, `--warn`, `--bad`,
  `--recon`, `--backfill`, `--conf-*`), tool logos (`--github`, … only inside
  `ToolMark`) and the one selection blue (`--select*`, `--focus`) for focus,
  selected cells, highlights and active filters. Never add another accent,
  colour something for decoration, or tint a row by tool.
- **Build from what exists.** Use the React components (`SectionHead`,
  `Loading`, `ErrorBox`, `Empty`, `KeyValue`, `GapBanners`, `ToolBadge`,
  `OutcomeBadge`, `HealthBadge`, `ConfidenceBadge`, …), the icons in `icons.tsx`
  and the CSS classes (`.page`, `.page-header`, `.card`, `.section-head`,
  `.entity-list`, `.inline-form`, `.table-wrap`, `.btn*`, `.field`, `.badge`,
  `.callout*`, …). New features should need little or no new CSS.
- **Tokens only.** Colours, sizes, spacing, radii, shadows and fonts come from
  `apps/web/src/styles.css`. No literal colours or sizes, no new tokens outside
  `styles.css`, no dark-mode overrides in page CSS. Fonts are Instrument Sans and
  JetBrains Mono only; icons are Lucide outlines in `icons.tsx` only.
- **Patterns.** Create things from a section's "Add …" button that opens an
  `.inline-form` (Cancel + Save); never hide a form behind a `<details>` arrow.
  Lists of named things use `.entity-list` with labelled icon actions. Sentence
  case everywhere, including table heads; no uppercase labels.
- Every class used in markup must be styled; inline `style` is for geometry only.
- Handle loading, error and empty states; check light and dark (use the theme
  switch) at desktop width and at 390px; put screenshots in the PR.

`apps/web/src/design-system.test.ts` enforces the mechanical rules and runs in
`pnpm test`. Fix the code, not the test. Change the test only as the
"Adding to the system" section of `docs/design-system.md` describes. A change to
the direction itself (palette, typeface, navigation model) needs a new ADR.

## Review guidelines

When reviewing a pull request, treat these as blocking findings:

- A change under `apps/web` that breaks a hard rule above: a new or decorative
  colour, a colour literal, a token defined outside `styles.css`, a font or icon
  set other than the bundled ones, a tool-coloured row, an uppercase label, a
  creation form behind a `<details>` arrow, or a hand-built replacement for an
  existing component or class.
- A UI change without light and dark screenshots at desktop width and 390px, or
  without loading, error and empty states for data it shows.
- An edit to `apps/web/src/design-system.test.ts` that loosens a rule instead of
  fixing the code.
- Anything that breaks a rule in `CLAUDE.md` (migrations, tenancy, events,
  logging of secrets, sign-off).
