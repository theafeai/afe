# Terraform with local Docker

This sample creates one
local container serving the shared page. No cloud account, remote state or
HCP Terraform subscription is needed.

Requirements: Terraform 1.5+ (below 2.0), local Docker Engine/Desktop and `curl`.
The configuration pins the Docker provider to the 4.6 patch series; commit
the generated `.terraform.lock.hcl` in your standalone demo repository.

## Deploy, change and destroy

After [copying the demo](README.md), run from its root:

```sh
terraform -chdir=terraform init
terraform -chdir=terraform validate
terraform -chdir=terraform plan
terraform -chdir=terraform apply
curl --retry 10 --retry-all-errors --retry-delay 1 -fsS http://127.0.0.1:8092/
```

Review and approve the local image/container resources when prompted. The page
should show Version 1. Terraform downloads its provider/image on first use.
The container binds only to loopback. If port 8092 is busy, pass
`-var=port=8093` to **every** plan/apply/destroy command (or put it in a local,
ignored `.tfvars` file). Do not use a remote/shared production Docker daemon.

Change the page to a new version:

```sh
python3 -c 'from pathlib import Path; p=Path("site/index.html"); p.write_text(p.read_text().replace("Version 1", "Version 2"))'
terraform -chdir=terraform plan
terraform -chdir=terraform apply
curl --retry 10 --retry-all-errors --retry-delay 1 -fsS http://127.0.0.1:8092/
```

The content hash is in the container environment, so the changed page causes a
real replacement in the Terraform plan. Confirm the page now shows Version 2
(or choose a fresh version if another guide already changed it).

```sh
terraform -chdir=terraform destroy
```

Review and approve destruction. The container is removed; the downloaded image
is retained for reuse. The URL should no longer respond. **Destroy before
deleting state**. Keep `.terraform/`, state, plans and variable files out of Git.

## Observe the real commands in Afe

Start Afe, open **Connections → Terraform** and create a connection with
workspace `afe-demo`, environment `development`, and your GitHub repository
if you want commit correlation. Save the reporter secret and endpoint shown
once on that screen. Follow the [reporter setup](../docs/connectors/terraform.md)
to configure `AFE_TERRAFORM_REPORT_URL` and `AFE_TERRAFORM_SECRET` (or its `_FILE`
variant) privately. Both the Terraform working directory and secret stay on
your machine. Only small lifecycle reports leave the runner.

From the standalone demo directory, set `REPORTER` to the absolute path of
`tools/terraform-report.py` in your Afe checkout. Report around each command:

```sh
REPORTER=/absolute/path/to/afe/tools/terraform-report.py
RUN_ID=$(python3 -c 'import uuid; print(uuid.uuid4())')
python3 "$REPORTER" --run-id "$RUN_ID" --operation apply --phase started
set +e
terraform -chdir=terraform apply
TF_EXIT=$?
set -e
python3 "$REPORTER" --run-id "$RUN_ID" --operation apply --phase completed --exit-code "$TF_EXIT"
```

Use a new UUID for each plan/apply/destroy attempt. Set `--operation plan`
around `terraform -chdir=terraform plan -detailed-exitcode`; exit 2 means
changes, not failure. Use `--operation destroy` around destruction. Preserve
the actual exit code immediately after each command; do not replace it with
the reporter's exit status. Optional `--commit FULL-SHA --repository OWNER/REPO`
adds runner-reported correlation; the repository must match the connection.

In **Events → Terraform**, expect start/completion pairs for the actual
commands, with workspace/environment and the reported outcome. Try
`terraform -chdir=terraform plan -var=port=1` as a real validation failure;
report its actual nonzero exit code and confirm a failed plan event appears.
Then destroy normally. Duplicate completion reports with the same run UUID
must not create another event. With Git metadata, journey events appear in
the config stage. These reports never claim an application is live in the
environment matrix or expose resource-level state/plan details.

The connector observes authenticated **runner reports**, not Terraform's
internal history: commands you do not report are invisible. No state, plan
contents, outputs or logs are ingested. Connection health becomes observed
after report processing; idle time cannot establish runner reachability.

## Troubleshooting

- Docker connection denied: start local Docker and use its supported access
  configuration. Set `DOCKER_HOST` when required by your local engine; do not
  expose an unauthenticated Docker TCP socket.
- Page missing: inspect the container upload and source `site/index.html`.
  Terraform uploads the page with explicit read permissions, so a restrictive
  local umask does not stop nginx from reading it. The page is also in local
  Terraform state; it must contain no secrets.
- Port conflict: use a different `port` value consistently.
- State was lost: do not blindly create another container with the same name;
  inspect Docker for `afe-demo-terraform` and restore/import state or remove
  only that disposable container deliberately.

References: [Terraform Docker provider](https://registry.terraform.io/providers/kreuzwerker/docker/latest/docs),
[provider container resource](https://github.com/kreuzwerker/terraform-provider-docker/blob/v4.6.0/docs/resources/container.md).
