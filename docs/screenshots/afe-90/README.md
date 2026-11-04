# AFE-90 User permissions editor

Real local Chromium → Vite → Fastify API → PostgreSQL, using sample accounts.
Alice is selected and her GitHub policy has been saved through the UI. The Vercel
section shows an unsaved draft so that the saved access badge, pending changes,
and per-user save context can be compared.

| Theme | Desktop (1440px)                         | Mobile (390px)                          |
| ----- | ---------------------------------------- | --------------------------------------- |
| Light | [Screenshot](permissions-light-1440.png) | [Screenshot](permissions-light-390.png) |
| Dark  | [Screenshot](permissions-dark-1440.png)  | [Screenshot](permissions-dark-390.png)  |

Verified in both themes with the sidebar switch and at both widths:

- Side-by-side list/editor on desktop, stacked layout on mobile.
- Selecting a row updates its marker, focuses the named editing heading and
  loads only that user's settings.
- The selected-user identity stays visible while scrolling through tool sections.
- Save is disabled until a draft changes. During a save, selection is disabled;
  success feedback names the tool and user, and the API persists that user's
  mode and restrictions with empty custom grants.
- Switching to another user and back reloads the saved policy and drops the draft.
- Only No access and Linked tool account are offered for ordinary policies.
- The Change user link returns to the list. A selected 100-character username
  wraps without horizontal overflow on mobile.
- No browser page errors or unexpected failed API requests.

Component regressions also exercise aborted/late loads, failed saves retaining
user-specific drafts, legacy policy review, loading, retry and empty states.
