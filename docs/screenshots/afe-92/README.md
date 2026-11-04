# AFE-92 Operation confirmation dialogs

Local Chromium renders the real Vite UI against intercepted, local GitHub API
fixtures. The selected workflow run is Deploy 110 in `acme/app`, attempt 2.
No real GitHub workflow or connected-tool operation was executed.

| Theme | Desktop (1440px)                   | Mobile (390px)                    |
| ----- | ---------------------------------- | --------------------------------- |
| Light | [Screenshot](rerun-light-1440.png) | [Screenshot](rerun-light-390.png) |
| Dark  | [Screenshot](rerun-dark-1440.png)  | [Screenshot](rerun-dark-390.png)  |

Verified with the sidebar theme switch at both widths:

- The dialog overlays the selected run without inserting a panel into the list.
- Scroll position and the selected row's position and width are identical before
  opening, while open, and after closing.
- Initial focus is Cancel. Background controls are inert, Tab stays out of the
  background, and closing returns focus to the original Re-run all jobs button.
- Cancel, Escape and backdrop dismissal do not submit an operation.
- The repository, run, attempt, consequences and debug-logging option are shown
  in the dialog. The submitted inputs can be inspected before confirming.
- Dialog contents and actions fit the viewport in both themes and at both widths.
- Preparation failures disable confirmation and offer an in-dialog retry.
- Execution errors stay inside the dialog. A deliberate retry preserves the
  request ID and submitted inputs; dismissal is blocked while submitting.
- No browser page errors.

Component regressions additionally cover duplicate submission, source-version
preservation, selected-run context, GitHub event run controls, uncertain-request
recovery and disconnect confirmations for GitHub, ArgoCD, Vercel and Terraform.
The full repository test suite exercises the existing server authorization,
validation, request locks and execution behavior using local fakes and PostgreSQL.
