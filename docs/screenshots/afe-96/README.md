# AFE-96 Workflow ref picker

The real Vite UI was checked in Chromium using local API fixtures. Repository
`acme/app` defaults to `trunk`; unsorted branch fixtures span two pages. No real
GitHub operation was executed.

| Theme | Desktop (1440px)                    | Mobile (390px)                     |
| ----- | ----------------------------------- | ---------------------------------- |
| Light | [Screenshot](picker-light-1440.png) | [Screenshot](picker-light-390.png) |
| Dark  | [Screenshot](picker-dark-1440.png)  | [Screenshot](picker-dark-390.png)  |

The screenshots show the reopened picker with empty, focused search and
`release` still selected. Themes were changed with the sidebar theme switch.

Verified in the browser:

- Initial workflow inputs load from the actual default branch, `trunk`.
- Clicking the field or arrow opens empty, focused search with every branch and
  tag sorted alphabetically, including branches from the second page.
- Typing filters results without changing the selected ref. No matches displays
  a useful empty state. Explicit tags and SHAs remain supported.
- Escape, outside click and reopening preserve selection and reset search.
- Arrow Down focuses the first result; Tab and Enter select options. Escape and
  selection return focus to the field.
- Selecting `release` blocks preparation until its inputs have loaded; preparation
  receives `ref: release`. The confirmation displays that ref.
- Ref loading is visible; a failed request shows an error and Try again restores
  the list. The popover fits the viewport and extends beyond the workflow list
  without clipping.
- No browser page errors. See [browser evidence](browser-evidence.json).

The full suite passed (102 files, 1,155 tests), including server authorization,
source default-branch response and dispatch validation against local fakes and
PostgreSQL. After the final keyboard and clipping fixes, the affected component,
server and design-system tests were rerun, along with lint and type checking.
