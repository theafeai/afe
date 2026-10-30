#!/bin/sh
# Keeps credentials on the user's computer, outside source control.
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -ne 3 ]; then
  echo 'Usage: sh examples/configure-local-github.sh APP_ID APP_SLUG /path/to/downloaded.pem' >&2
  exit 1
fi
case "$1" in ''|*[!0-9]*) echo 'APP_ID must be numeric.' >&2; exit 1;; esac
case "$2" in ''|*[!a-zA-Z0-9-]*) echo 'APP_SLUG must be the slug from github.com/apps/SLUG.' >&2; exit 1;; esac
test -f .env && test -d secrets
test -f "$3"
if grep -q '^AFE_GITHUB_.*=' .env || [ -e secrets/github_app_private_key ] || [ -e secrets/github_webhook_secret ]; then
  echo 'GitHub settings already exist; refusing to overwrite them.' >&2
  exit 1
fi
openssl rsa -in "$3" -check -noout >/dev/null 2>&1 || {
  echo 'Expected a valid RSA private key downloaded from the GitHub App.' >&2
  exit 1
}
umask 077
cp "$3" secrets/github_app_private_key
openssl rand -hex 32 > secrets/github_webhook_secret
chmod 644 secrets/github_app_private_key secrets/github_webhook_secret
cat >> .env <<EOF

AFE_PUBLIC_URL=http://localhost:8080
AFE_GITHUB_APP_ID=$1
AFE_GITHUB_APP_SLUG=$2
AFE_GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github_app_private_key
AFE_GITHUB_WEBHOOK_SECRET_FILE=/run/secrets/github_webhook_secret
AFE_GITHUB_ADOPT_INSTALLATIONS=true
EOF
sh examples/start-local-afe.sh
echo 'App configured. Sign in at http://localhost:8080 and connect GitHub.'
echo 'Polling starts after the installation setup callback creates the connection.'
