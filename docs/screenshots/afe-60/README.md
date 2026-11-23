# AFE-60 verification

Story: a named user links a personal Terraform token, discovers a selected remote
workspace, reviews and confirms a scoped operation, receives a persisted request
receipt, and observes the provider's subsequent state.

| Boundary                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser                 | Chromium exercised real Afe pages at 1440px and 390px in light and dark using the theme switch. Profile, workspace, confirmation and administrator setup screenshots are below. No page errors or horizontal overflow.                                                                                                                                                                                        |
| Client → API            | The real Profile form linked a personal fixture token with explicit operation opt-in. Workspace discovery used the authenticated API. Preparing and cancelling dialogs sent no mutation; explicit confirmation called execute.                                                                                                                                                                                |
| API → provider          | A local HTTP Terraform provider received exactly the selected `POST /api/v2/runs/run-Q8k4n7X2m9Lp/actions/apply`. The real client enforced the operator lab HTTP/private-network exception. No external HCP/TFE account was contacted.                                                                                                                                                                        |
| API → PostgreSQL        | The real server encrypted the personal credential, rechecked Source access and provider permissions, acquired the receipt lock and persisted acceptance. Administrator setup saved a remote connection through its authenticated route.                                                                                                                                                                       |
| Response → UI           | The UI displayed acceptance separately from the refreshed `applying` source state. Browser fault injection checked empty discovery and provider-rate-limit errors. Component tests cover loading and failed preparation, explicit cancellation, double submission and uncertain responses.                                                                                                                    |
| Authorization / failure | Integration tests cover tenant/resource/run/policy ownership, local-reporter separation, source read versus action permissions, opt-in, legacy-policy denial, revocation, stale preparation, concurrent intents, provider 4xx/429/5xx/disconnection, receipt replay and explicit recovery. Transport tests cover actual timeout, response bounds, redirects, invalid JSON, team identities and DNS rebinding. |

Validation: `pnpm lint`, `pnpm typecheck`, `pnpm test` (105 files / 1,183 tests),
`pnpm build`, and the browser flow. The committed machine-readable
[browser evidence](browser-evidence.json) contains no credentials.

The test provider implements the HashiCorp API contracts documented in the
[capability matrix](../../terraform-actions.md). Live HCP/TFE account validation
remains a deployment-specific check; version-dependent capabilities fail closed.
Deferred task/approval controls, sensitive output rendering and workspace/state
administration are explicitly inventoried there. This work adds no live-log
transport or remote-run event ingestion/backfill.

| Theme / width  | Workspace                              | Confirmation                              | Profile                              | Setup                              |
| -------------- | -------------------------------------- | ----------------------------------------- | ------------------------------------ | ---------------------------------- |
| Light / 1440px | [Screenshot](workspace-light-1440.png) | [Screenshot](confirmation-light-1440.png) | [Screenshot](profile-light-1440.png) | [Screenshot](setup-light-1440.png) |
| Dark / 1440px  | [Screenshot](workspace-dark-1440.png)  | [Screenshot](confirmation-dark-1440.png)  | [Screenshot](profile-dark-1440.png)  | [Screenshot](setup-dark-1440.png)  |
| Light / 390px  | [Screenshot](workspace-light-390.png)  | [Screenshot](confirmation-light-390.png)  | [Screenshot](profile-light-390.png)  | [Screenshot](setup-light-390.png)  |
| Dark / 390px   | [Screenshot](workspace-dark-390.png)   | [Screenshot](confirmation-dark-390.png)   | [Screenshot](profile-dark-390.png)   | [Screenshot](setup-dark-390.png)   |
