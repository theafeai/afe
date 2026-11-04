# AFE-91 Delete user

Real local Chromium → Vite → Fastify → PostgreSQL with a disposable user created
for verification. The confirmation uses a 100-character generated username.
The test user was deleted only after all cancellation checks and screenshots.

| Theme | Desktop (1440px)                                 | Mobile (390px)                                  |
| ----- | ------------------------------------------------ | ----------------------------------------------- |
| Light | [Screenshot](delete-confirmation-light-1440.png) | [Screenshot](delete-confirmation-light-390.png) |
| Dark  | [Screenshot](delete-confirmation-dark-1440.png)  | [Screenshot](delete-confirmation-dark-390.png)  |

Verified:

- Cancel receives native dialog focus. Cancel and Escape preserve the account
  and send no deletion request.
- Both themes and widths fit the complete confirmation and long username without
  horizontal overflow.
- An in-flight deletion disables actions and blocks Cancel/Escape.
- The single confirmed DELETE reaches the real API and removes the account.
  The list refreshes, the permissions panel clears, and focus returns to User accounts.
- The old bearer credential and login attempt fail; a previously active cookie
  session also fails its next request. The administrator session remains valid.
- No browser page errors or unexpected failed API requests.

Automated regressions also cover authorization, CSRF, tenant isolation,
case-insensitive self-deletion protection, protected administrator storage,
cleanup of linked credentials/OAuth/OIDC/email records, transaction rollback,
historical event attribution, retryable UI failures and preserved credentials
for unrelated records.
