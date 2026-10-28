# GitHub Actions and Pages

First [copy and publish the demo](README.md). Use an empty public test repository
and a GitHub account/org where you can enable Actions and Pages.

For a local Afe instance without a public tunnel, follow the exact
[local polling setup](local-github.md) first.

## Connect Afe

1. Configure Afe's HTTPS public URL as described in the shared guide.
2. In Afe, open **Connections → GitHub**. Use **Create the GitHub App** if
   none is configured, approve its requested read permissions, then install it
   on the demo repository. Select the repository explicitly.
3. Confirm the account appears under Connections. If your org requires owner
   approval, finish that before testing. For a manual App or polling-only
   configuration, see [GitHub connector setup](../docs/connectors/github.md).

The demo workflow's `pages: write` and `id-token: write` permissions are for
publishing the demo, not permissions requested by Afe's read-only App.

## Deploy Version 1

In the demo repository, open **Settings → Pages → Build and deployment** and
choose **GitHub Actions** as Source. If an environment approval rule is present,
approve the `github-pages` deployment. Open **Actions → Afe demo Pages → Run
workflow**, choose `main`, and run. Open the URL in the deploy job and confirm
**Version 1**. No custom domain or personal access token is needed.

The workflow runs a small check on PRs and pushes. Only main/manual-main runs
publish: PRs from forks never receive deployment permissions.

## Deploy Version 2 and inspect Afe

From the standalone demo directory:

```sh
git switch -c demo/version-2
python3 -c 'from pathlib import Path; p=Path("site/index.html"); p.write_text(p.read_text().replace("Version 1", "Version 2"))'
git add site/index.html
git commit -s -m "Show Version 2"
git push -u origin demo/version-2
```

Open a PR on GitHub. Its check should pass without deploying. Merge it to
main and wait for the deployment. Reload the Pages URL and confirm Version 2.

In Afe's Timeline, filter **GitHub** and the demo repository. Expect workflow
run/job lifecycle events, a manual trigger for the initial dispatch, a push
trigger for the merged run, and deployment/status events where GitHub exposes
them. Compare the source commit SHA with the main commit, not just the PR head
(a squash/merge may have a different SHA). Open a journey when commit keys are
available. Pages runs in `github-pages`, not an environment called `production`.

For a repeatable failure, temporarily change the workflow's check from
`test -s site/index.html` to `test -s site/missing.html` on a new PR. The check
must fail and main must not deploy. Close/revert that test change afterward.

## Record repeatable acceptance evidence

After both deployments complete, retain their run IDs from the URLs
`https://github.com/OWNER/REPO/actions/runs/RUN_ID` and the GitHub connection ID
from Afe's connection details URL. Use a dedicated test Afe instance.

The verifier checks the real public GitHub API and Afe. It requires both
workflow runs to succeed on main, Version 1 and Version 2 in their respective
source commits, successful Pages deployment statuses linked to those runs,
and matching successful workflow/deployment events in Afe. It compares the
connection, repository, commit, run, deployment and status IDs. It never
creates events or treats a successful workflow alone as a deployment.

From the Afe checkout, with Python 3 installed:

```sh
export AFE_DEMO_URL=https://YOUR-TEST-AFE-HOST
# Set AFE_ADMIN_TOKEN privately through your secret manager/environment.
python3 examples/ci/github-afe.py --repository YOUR-ACCOUNT/afe-demo \
  --connection-id YOUR-AFE-CONNECTION-ID --run-ids VERSION-1-RUN-ID VERSION-2-RUN-ID
```

The Afe origin must be reachable from the machine running this command.
HTTPS is required except for HTTP on loopback during local testing.
The script waits up to ten minutes for observation and writes only whitelisted
source/event metadata to the gitignored `github-evidence/` directory. API
errors, missing evidence and timeouts fail the command; they do not count as
acceptance. Public GitHub API calls use the anonymous rate limit.

For cloud execution and browser evidence, the Afe repository includes the
manual **GitHub Pages Afe acceptance** workflow. Once that workflow is on the
default branch:

1. Set repository variable `AFE_DEMO_URL` to the dedicated test Afe HTTPS origin.
2. Set repository secret `AFE_DEMO_ADMIN_TOKEN` to that instance's admin token.
   Keep this out of workflow inputs, source files and issue comments.
3. Open Actions → GitHub Pages Afe acceptance → Run workflow. Supply the demo
   repository, Afe connection ID and the two successful Pages run IDs.
4. Download the `github-afe-evidence` artifact. Open `results.json`, the event
   screenshots and `recordings/github-events.webm`.

This recording shows Afe's verified event history and connection. Open the
Pages URL during each deployment to verify the live version separately; a
later recording cannot show the site's previous live state. The workflow
does not publish or delete the demo, configure Pages, register an App or
install it. Those account steps above remain prerequisites. The workflow
and browser capture must be exercised against the actual test accounts before
claiming hosted acceptance; preparing them does not complete that check.

## Troubleshooting and cleanup

- Pages setup/permission error: enable Pages Source = GitHub Actions, allow
  Actions in repository/org settings, and check environment approvals.
- Workflow passes but no Afe events: check App repository selection, Actions
  and Deployments read permissions, worker logs, webhook deliveries and the
  connection's reconciliation time. Allow several minutes for polling.
- Wrong site version: inspect the deploy job's commit and URL; wait for Pages
  propagation and hard-refresh.
- Cleanup: Settings → Pages → unpublish site; disable the demo workflow if
  keeping the repo. Disconnect the test GitHub connection in Afe, uninstall the
  test App (or remove just this repo from its installation), then delete the
  disposable repository if desired. Do not uninstall an App used by other tests.

Reference: [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
