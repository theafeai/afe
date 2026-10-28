# Terraform with local Docker

This sample works **before Afe's Terraform connector exists**. It creates one
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

## What appears in Afe today

Nothing from a local Terraform CLI run: AFE-34 is still pending. Do not expect
Terraform plan/apply resources or Terraform-specific journey stages in Afe.
If you later execute Terraform via a connected GitHub Actions workflow, its
workflow lifecycle can be observed as GitHub activity; that is not Terraform
resource-level observation. This local sample requires no fake event injection.

Once AFE-34 defines its supported execution path, connect it and use the same
plan/apply/change/destroy cycle as a real connector acceptance test.

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
