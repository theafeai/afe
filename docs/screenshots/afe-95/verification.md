# AFE-95 verification

Afe displays existing workflow definitions as read-only YAML and operates existing
workflows. Workflow-file creation, updates and deletion have no UI, API operation,
agent capability, input schema or provider mutation path. Profile no longer offers
workflow-edit consent, and OAuth never requests the `workflow` scope.

| Boundary                | Evidence                                                                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser                 | Chromium opened the workflow details and keyboard-operated the YAML disclosure. No editor, save, delete or create controls remain. Profile offers GitHub OAuth without a workflow-scope checkbox.                                                                    |
| Client → API            | Component tests preserve typed dispatch and explicit confirmation, and verify read-only source rendering and removed Profile consent. Browser fixture browsing made only GET requests.                                                                               |
| API → provider/database | Fastify integration tests with PostgreSQL and local GitHub fakes reject both removed action names on preparation and execution, including a previously prepared version token, without mutations or receipts. The shared catalog no longer advertises either action. |
| Authorization           | Source viewing retains current repository write access, dispatch policy, tenant, identity and connection selection checks. A dispatch restriction denies YAML access. Existing role, replay and credential-revocation tests pass.                                    |
| Response → UI           | Read-only YAML, source permission errors and empty workflow lists were checked in Chromium. No page errors or document overflow at 1440px or 390px in either theme. YAML uses the existing scrollable code style and is keyboard focusable.                          |

Validation: ESLint, Prettier, both TypeScript checks, the web production build,
and all 101 test files / 1,136 tests passed. After applying the existing code
viewer style, the 46 focused UI/design-system tests and both typechecks passed
again. Browser checks use deterministic local API fixtures, not a live GitHub
account; server integration tests use PostgreSQL 16 and local provider fakes.

| Theme / width  | Workflows                             | Profile                              |
| -------------- | ------------------------------------- | ------------------------------------ |
| Light / 1440px | [Screenshot](workflow-light-1440.png) | [Screenshot](profile-light-1440.png) |
| Dark / 1440px  | [Screenshot](workflow-dark-1440.png)  | [Screenshot](profile-dark-1440.png)  |
| Light / 390px  | [Screenshot](workflow-light-390.png)  | [Screenshot](profile-light-390.png)  |
| Dark / 390px   | [Screenshot](workflow-dark-390.png)   | [Screenshot](profile-dark-390.png)   |
