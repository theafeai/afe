# AFE-88 Users list

Real local browser → Vite → Fastify API → PostgreSQL, using sample user accounts.
The selected account has a generated username at the supported 100-character
limit; the first row has an email address and keyboard focus. Status badges and
manage icons stay aligned while names and email addresses wrap.

| Theme | Desktop (1440px)                   | Mobile (390px)                    |
| ----- | ---------------------------------- | --------------------------------- |
| Light | [Screenshot](users-light-1440.png) | [Screenshot](users-light-390.png) |
| Dark  | [Screenshot](users-dark-1440.png)  | [Screenshot](users-dark-390.png)  |

Verified with the sidebar theme switch in both themes and at both widths:

- No horizontal overflow; every status badge shares the same column.
- Keyboard focus is visible, and selection works with Space.
- Selecting another row updates the management panel and selected state.
- Enable/disable writes persist through the API and the refreshed list.
- Credential reset shows the one-time credential, which can be dismissed.
- No browser page errors or unexpected failed API requests.

Component regression tests cover loading, retryable errors, the empty state,
selection, and account management. Validation: `pnpm lint`, `pnpm typecheck`, and
`pnpm test` (100 files, 1,115 tests).
