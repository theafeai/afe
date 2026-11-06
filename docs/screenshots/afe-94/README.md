# AFE-94 Loading-state correctness

Chromium rendered the real Vite application against intercepted local API fixtures.
No connected GitHub operation was executed. Requests were held until the loading
state was checked, then released deliberately.

| Theme                      | Desktop (1440px)                     | Mobile (390px)                      |
| -------------------------- | ------------------------------------ | ----------------------------------- |
| Light, opening run details | [Screenshot](loading-light-1440.png) | [Screenshot](loading-light-390.png) |
| Dark, opening run details  | [Screenshot](loading-dark-1440.png)  | [Screenshot](loading-dark-390.png)  |
| Light, refreshing          | [Screenshot](refresh-light-1440.png) | [Screenshot](refresh-light-390.png) |
| Dark, refreshing           | [Screenshot](refresh-dark-1440.png)  | [Screenshot](refresh-dark-390.png)  |

Checked with the sidebar theme switch at both widths:

- Opening details shows neutral loading for run details, capabilities, jobs and
  deployment reviews. The succeeded status already known from the list remains
  succeeded; no pending or in-progress status is invented.
- Run actions are absent until run details and capabilities resolve. Refreshing
  keeps the selected row and known result visible, marks checks as loading, and
  prevents operation execution until the refreshed state resolves.
- The selected row's vertical position is identical before and during refresh.
  [Recorded measurements](browser-evidence.json) also show no page overflow or
  browser page errors in any viewport/theme combination.
- Controls are labelled, reachable by keyboard, and retain visible focus.

Delayed-response component tests cover ref changes, operation-capability loading,
initial/empty/error states, repeated resource navigation, out-of-order responses,
permission revocation, refresh failure and pagination cancellation. Existing tests
also exercise failed and empty GitHub results and operation confirmation.
