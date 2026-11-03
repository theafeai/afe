# ADR 0013: Colour-code data by tool

- Status: Accepted; the tool-coloured row rule and the Afe mark superseded by
  [ADR 0015](0015-ink-design-language.md)
- Date: 2026-11-01
- Linear: AFE-65
- Supersedes: the "Tool" status-language rule in [ADR 0009](0009-web-ui-design-system.md)
  (a neutral badge with the tool's colour as a small square) and the 2px rule
  for late observation.

## Context

Most of what Afe shows comes from one of four tools. With only a small colour
square in each badge, users had to read the label to see where a row came
from. The product owner asked for data to be colour-coded by tool, with the
tools' own icons, so pages are quicker to scan.

## Decision

- **Colours are brand-based tokens:** `--github` grey, `--argocd` orange,
  `--vercel` black (white in dark mode), `--terraform` purple, `--afe` the
  accent. They identify a tool and never encode a status.
- **Logos:** `ToolBadge` shows the tool's logo (`ToolMark` in `icons.tsx`) in
  the tool colour. Outlines come from Simple Icons (CC0-1.0) and are bundled.
  The marks are the tools' trademarks and are used only to identify the
  integration. A tool without a logo falls back to a small square.
- **Rows:** timeline rows and the rows of the deployments, drift and
  connections tables carry a 2px left rule in the tool colour (`.tool-row`
  plus `.tool-<source>`). Rows stay neutral otherwise: no tool tints.
- **Status keeps priority.** The tool rule has zero specificity, so status
  emphasis wins wherever both apply: observation-gap rows keep their warning
  rule, and journey highlights replace the tool rule. Reconciled and
  backfilled timeline rows are marked with a light tint plus their note, so
  the left edge stays free for the tool.
- **Reconciliation moves to magenta** (`--recon`, also `--conf-ambiguous`),
  because Terraform's brand purple would otherwise read as the same signal.

## Consequences

- Tool identity is visible at a glance on every page that shows events,
  deployments, drift or connections.
- Adding a connector means adding its colour token (both themes) and, if
  available, its logo to `TOOL_PATHS`.
