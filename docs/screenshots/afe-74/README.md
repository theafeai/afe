# AFE-74: discoverable GitHub Actions controls

Before/after captures of the actual GitHub Actions page, rendered in Chromium
with the local `GitHubOperations.test.tsx` API fixture (completed failed run,
attempt 2). These are UI fixture captures, not a live GitHub integration test.

View logs now has an accent outline and fill in each job header. Hide logs uses
a solid accent and stays directly above its output. Re-run job is separated
below the steps. Open source run uses a bordered secondary button. Disabled log
controls include a description of the access/loading failure. Destructive run
controls retain the design system's danger styling and confirmation flow.

| Theme / width | Before                        | After                        | Before expanded                        | After expanded, keyboard focus        |
| ------------- | ----------------------------- | ---------------------------- | -------------------------------------- | ------------------------------------- |
| Light / 1440  | [View](before-light-1440.png) | [View](after-light-1440.png) | [View](before-expanded-light-1440.png) | [View](after-expanded-light-1440.png) |
| Dark / 1440   | [View](before-dark-1440.png)  | [View](after-dark-1440.png)  | [View](before-expanded-dark-1440.png)  | [View](after-expanded-dark-1440.png)  |
| Light / 390   | [View](before-light-390.png)  | [View](after-light-390.png)  | [View](before-expanded-light-390.png)  | [View](after-expanded-light-390.png)  |
| Dark / 390    | [View](before-dark-390.png)   | [View](after-dark-390.png)   | [View](before-expanded-dark-390.png)   | [View](after-expanded-dark-390.png)   |

Browser checks passed in all four layouts: no page overflow, log targets at
least 44px high (45px measured), and visible keyboard focus when tabbing back to
Hide logs. All 135 web tests pass, including attempt isolation, inline run
expansion, log errors, permission denial, collapse and retained focus. ESLint,
Prettier, both TypeScript checks and the design-system checks pass.

The full repository test run was attempted but stopped after database-backed
failures: PostgreSQL is unavailable at localhost:5432 (`ECONNREFUSED`). The pnpm
wrapper also attempts dependency installation in this environment, so validation
used the equivalent installed ESLint, Prettier, TypeScript and Vitest binaries.
