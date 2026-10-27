# GitHub Actions and Pages

First [copy and publish the demo](README.md). Use an empty public test repository
and a GitHub account/org where you can enable Actions and Pages.

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
