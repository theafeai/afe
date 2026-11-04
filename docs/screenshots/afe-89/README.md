# AFE-89 Account settings

Account → Settings (`/account/settings`) now contains Email delivery, moved from
Users. The page retains the operator-configured SMTP sender, test recipient
validation, test-email submission, delivery status and administrator authorization.
Users retains invitations, email-address editing and credential reset actions.

| View                               | Light                                 | Dark                                   |
| ---------------------------------- | ------------------------------------- | -------------------------------------- |
| Settings, 1440px                   | [Screenshot](settings-light-1440.png) | [Screenshot](settings-dark-1440.png)   |
| Settings, 390px                    | [Screenshot](settings-light-390.png)  | [Screenshot](settings-dark-390.png)    |
| Expanded mobile Account navigation | —                                     | [Screenshot](account-nav-dark-390.png) |

Verification used the production web build served by local Fastify, a disposable
PostgreSQL 16 database and a loopback SMTP receiver. No external email was sent.

- Signed in through the browser; verified Profile, Users and Settings as siblings,
  the active Settings link, direct loading and reloading `/account/settings`.
- Checked required and invalid recipient validation, test-email POST returning 202,
  local SMTP acceptance and delivery status changing to `sent` with one attempt.
  Status persisted after reloading the page.
- Created a user with an email invitation (201) and followed the toast's
  **View delivery status** link into Settings. The delivery form is absent from Users.
- Verified viewer accounts cannot see the Settings navigation item, get an
  administrator-access message on direct navigation, and receive 403 from both
  the email-status and test-email endpoints.
- Checked System, Light and Dark theme controls, keyboard tab order through the
  recipient and actions, and light/dark layouts at 1440px and 390px. No horizontal
  overflow or browser page errors occurred.
- Component tests cover loading, failed-load retry, SMTP disabled, empty history,
  failed submission with retained draft, pending submission and status refresh.
- `pnpm lint`, `pnpm typecheck`, all builds and the complete suite passed:
  **1,118 tests across 101 files**. After the final spacing adjustment, rebuilt
  the web app and reran Settings and design-system checks (14 tests).

SMTP configuration remains operator-managed; there are no new settings APIs,
configuration controls, migrations or placeholder sections.
