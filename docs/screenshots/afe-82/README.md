# AFE-82: inline mapping rule forms

Chromium captures of the Mapping page using the local `Mapping.test.tsx` API
fixtures. These verify UI behavior with mocked responses; they do not verify
persistence against a running PostgreSQL server.

The new-rule form appears inside the corresponding rules card, beneath its
existing rules. Edit and unmapped-value entry points use the same placement.
Changing Assigns moves the draft to the matching card and preserves its fields.

| Theme / width | Service form                   | Environment form                   |
| ------------- | ------------------------------ | ---------------------------------- |
| Light / 1440  | [View](service-light-1440.png) | [View](environment-light-1440.png) |
| Dark / 1440   | [View](service-dark-1440.png)  | [View](environment-dark-1440.png)  |
| Light / 390   | [View](service-light-390.png)  | [View](environment-light-390.png)  |
| Dark / 390    | [View](service-dark-390.png)   | [View](environment-dark-390.png)   |

Both forms passed browser checks for placement, rule type, cancellation,
keyboard access to Save rule, no page overflow, and no page errors in all four
layouts. Save rule has keyboard focus in the captures.

All 156 web tests pass, including nine Mapping tests and the design-system
checks. ESLint, Prettier, and both TypeScript checks pass. The full repository
suite was attempted and stopped after server failures; a focused server test
confirmed PostgreSQL connections to localhost:5432 fail with EPERM in the sandbox.
