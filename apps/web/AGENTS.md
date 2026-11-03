# Web UI (`apps/web`) – instructions for coding agents

This applies to every change in this folder, on top of the root `AGENTS.md` and
`CLAUDE.md`. The binding references are `docs/design-system.md` and
[ADR 0015](../../docs/decisions/0015-ink-design-language.md) (Ink). If this file and
those disagree, they win; fix this file.

## Before you write code

1. Read `docs/design-system.md` (rules, tokens, components, patterns).
2. Find the page that already does what you need and copy its structure.
3. Look up each need below. If something has no entry, follow "Adding to the
   system" in `docs/design-system.md`; do not invent a one-off.

## Use this, not that

| Need                                         | Use                                                                                                    | Never                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Page frame                                   | `.page` > `.page-header` (`h1` + `.lede`, `.toolbar`)                                                  | Your own header or nav                                 |
| A section with a title and an action         | `.card` + `SectionHead` (title, optional count and hint, action on the right)                          | A boxed card with its own border and shadow            |
| Creating something                           | `.btn.btn-sm` "Add …" with `icons.plus` and `aria-expanded`, opening an `.inline-form` (Cancel + Save) | A `<details>` arrow around a form; an always-open form |
| A list of named things                       | `.entity-list` (`strong` name, `code` identifier, `.entity-meta`, `.entity-actions`)                   | Run-together text with inline links                    |
| A row action                                 | `.btn.btn-ghost.btn-icon.btn-sm` with an icon, `aria-label` and the same `title`                       | Text arrows (← ↑), bare `.btn-link` "Delete"           |
| Tables                                       | `.table-wrap` > `.table`, sentence-case heads, `.num` and `.row-actions` cells                         | Uppercase heads, tables without the wrapper            |
| Picking from many options                    | A labelled button opening a search popover (`role="dialog"`, Escape and outside click close it)        | A long inline list                                     |
| Status (outcome, health, confidence, gaps)   | `OutcomeBadge`, `HealthBadge`, `ConfidenceBadge`, `GapBanners`, `.gap-badge`                           | New badges or colours for status                       |
| Naming a tool                                | `ToolBadge` / `ToolMark`                                                                               | Tool colours anywhere else; tool-coloured rows         |
| Selection, focus, highlights, active filters | `--select`, `--select-soft`, `--focus`, `--accent-ring`                                                | The selection blue for anything else                   |
| Icons                                        | `icons.*` from `icons.tsx` (Lucide; add new ones there, `aria-hidden`)                                 | Inline `<svg>` in pages, emoji, another icon library   |
| Confirming an action                         | `useToast()`                                                                                           | A success banner on the page                           |
| Loading / error / empty                      | `Loading`, `ErrorBox` (`onRetry`), `Empty` (with a next step)                                          | Blank areas, spinners you build yourself               |

## Style rules

- Ink: buttons, links and nav are ink. Colour only means status, a tool logo or
  selection. One `.btn-primary` per view.
- Tokens only: colours, `--fs-*`, `--space-*`, `--radius*`, shadows, `--font` /
  `--mono`. Page CSS goes in `pages/<Page>.css` with classes prefixed by the page.
- Sentence case for all text. No `text-transform: uppercase`. Identifiers (SHAs,
  event types, IDs) in `code` / `--mono`; prose never.
- Themes come from tokens. Never write `prefers-color-scheme` or `[data-theme]`
  outside `styles.css`. Check System, Light and Dark with the sidebar switch.
- Accessibility: real buttons and links, labelled controls, visible focus,
  `aria-label` on icon-only buttons, `aria-current="page"` on the active nav item.

Some older rules in `pages/Journey.css` and `pages/EnvironmentMatrix.css` still
use uppercase labels or literal radii from before ADR 0015. When you touch one of
those rules, convert it to the rules above.

## Before you open the PR

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass (includes
      `design-system.test.ts`; fix the code, never loosen the test).
- [ ] Loading, error and empty states handled.
- [ ] Checked in light and dark at desktop width and at 390px; screenshots in the
      PR (the repo keeps them in `docs/screenshots/<issue>/`).
- [ ] Keyboard: everything reachable with Tab, focus visible, icon buttons
      labelled.
- [ ] Anything new added to `docs/design-system.md` in the same PR.
