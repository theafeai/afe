# AFE-59 browser verification

A managed user opens ArgoCD, explicitly enables actions for the linked personal
account, selects a revision, a Deployment and a sync option, then reviews and
confirms the operation. The browser runs the production web build against the
real Afe API and PostgreSQL, with a local fake ArgoCD source. No external provider
or deployment was changed.

| Boundary                                  | Evidence                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Observation access does not imply actions | Review disabled before consent                                                                        |
| UI to authenticated API                   | Session cookies and CSRF, real consent/prepare/execute calls                                          |
| API to source                             | Exactly one upstream `POST /api/v1/applications/checkout-api/sync`                                    |
| Source response to database/UI            | One accepted operational receipt visible in request history; no generated deployment-completion event |
| Modal/keyboard                            | Cancel initially focused; operation executes only on explicit confirm                                 |
| Responsive/theme                          | Light and dark with the actual theme switch at 1440px and 390px; no page overflow                     |
| Browser runtime                           | No JavaScript errors                                                                                  |

See [browser-evidence.json](browser-evidence.json) for machine-readable evidence.
The provider API request/response behavior is additionally covered by local
HTTP/HTTPS fakes, including denial, stale state, throttling, failure and timeout.
A production ArgoCD instance was not used; API shapes were checked against the
published v2.14.11 OpenAPI definition.

## Screenshots

| Theme             | Desktop                              | Mobile                             |
| ----------------- | ------------------------------------ | ---------------------------------- |
| Light workspace   | [1440px](workspace-light-1440.png)   | [390px](workspace-light-390.png)   |
| Dark workspace    | [1440px](workspace-dark-1440.png)    | [390px](workspace-dark-390.png)    |
| Dark confirmation | [1440px](confirmation-dark-1440.png) | [390px](confirmation-dark-390.png) |
