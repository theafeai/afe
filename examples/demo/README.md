# Afe demo application

One static page, no dependencies or build step. Change `Version 1` in
`site/index.html`, commit and deploy to recognize the new version.

- **GitHub Actions/Pages:** enable Settings → Pages → Source → GitHub Actions,
  then push `main`. `.github/workflows/pages.yml` checks PRs and deploys main.
- **Vercel:** import this repository, use its root, select Other as the
  framework and keep the `vercel.json` settings. Push a branch for a preview;
  merge to main for production.
- **ArgoCD:** use this repository root as a Kustomize source. The manifests
  serve the same page in a cluster.
- **Terraform:** run `terraform -chdir=terraform init`, then
  `terraform -chdir=terraform apply` with local Docker running. Visit
  <http://127.0.0.1:8092/>. Clean up with `terraform -chdir=terraform destroy`.

For local-only preview: `python3 -m http.server 8090 --bind 127.0.0.1 --directory site`.

The full [Afe example guides](https://github.com/theafeai/afe/tree/main/examples)
cover account setup, connecting Afe, expected observations, changes and cleanup.
Terraform observation is not implemented yet (AFE-34); running this sample does
not create Terraform events in Afe. A workflow that runs Terraform may still
appear as a GitHub Actions run.

Examples use disposable resources. Keep Terraform state local and uncommitted;
destroy its container before deleting state. Terraform uploads the static page
into the container; no host bind mount or permissive checkout file modes are needed.
