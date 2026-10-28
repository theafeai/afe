# Afe – instructions for coding agents

Read `CLAUDE.md` first: every rule there applies to all agents (Codex, Claude
and others), including ADRs in `docs/decisions/`, migrations, tenancy, logging,
tests and sign-off. This file adds what an agent must not miss.

## Web UI: the design system is mandatory

Any change under `apps/web` (new pages, new features, small fixes) must follow
**`docs/design-system.md`**, which implements ADR 0009. Read it before writing
UI code. In short:

- Build from the existing React components (`Loading`, `ErrorBox`, `Empty`,
  `KeyValue`, `GapBanners`, `ToolBadge`, `OutcomeBadge`, `HealthBadge`,
  `ConfidenceBadge`, …) and CSS classes (`.page`, `.page-header`, `.card`,
  `.table-wrap`, `.btn*`, `.field`, `.badge`, `.callout*`, …). New features
  should need little or no new CSS.
- Colours, sizes, spacing, radii, shadows and fonts come from the tokens in
  `apps/web/src/styles.css`. No literal colours, no new tokens outside
  `styles.css`, no dark-mode overrides in page CSS.
- Every class used in markup must be styled; inline `style` is for geometry
  only.
- Use the shared status language for confidence, outcome, health, tools,
  observation gaps and alerts. Do not invent new badges or colours for them.
- Handle loading, error and empty states; check light and dark at desktop
  width and at 390px; put screenshots in the PR.

`apps/web/src/design-system.test.ts` enforces the mechanical rules and runs in
`pnpm test`. Fix the code, not the test. Change the test only as the
"Adding to the system" section of `docs/design-system.md` describes.
