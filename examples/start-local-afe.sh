#!/bin/sh
# Run from a fresh Afe checkout on the user's computer (Docker must be running).
set -eu
cd "$(dirname "$0")/.."
command -v docker >/dev/null
command -v openssl >/dev/null
command -v python3 >/dev/null
docker compose version >/dev/null
docker info >/dev/null
if [ -e .env ] || [ -L .env ] || [ -e secrets ] || [ -L secrets ]; then
  echo 'Use a fresh checkout: refusing to replace .env or secrets.' >&2
  exit 1
fi
umask 077
mkdir secrets
cp .env.example .env
openssl rand -base64 32 > secrets/afe_encryption_key
openssl rand -hex 32 > secrets/afe_admin_token
# The runtime user must be able to read the bind-mounted Compose secrets.
# The parent directory stays accessible only to the local account.
chmod 644 secrets/afe_encryption_key secrets/afe_admin_token
password=$(openssl rand -hex 24)
python3 - "$password" <<'PY'
import pathlib, sys
p = pathlib.Path('.env')
p.write_text(p.read_text().replace('POSTGRES_PASSWORD=\n', 'POSTGRES_PASSWORD=' + sys.argv[1] + '\n')
             .replace('AFE_VERSION=latest', 'AFE_VERSION=demo') + '\nAFE_IMAGE=afe-demo-local\n')
PY
docker build -t afe-demo-local:demo .
docker compose -p afe-demo-local up -d
docker compose -p afe-demo-local up -d --wait --wait-timeout 180 afe-server
echo 'Afe is ready at http://localhost:8080 .'
echo 'Read secrets/afe_admin_token locally to sign in; do not post it in chat.'
