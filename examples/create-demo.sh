#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: sh examples/create-demo.sh /path/to/new-demo-directory" >&2
  exit 1
fi
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/demo" && pwd)
destination=$1
if [ -e "$destination" ] || [ -L "$destination" ]; then
  echo "Destination already exists; choose a new directory." >&2
  exit 1
fi
python3 - "$source_dir" "$destination" <<'PY'
import pathlib
import shutil
import sys

source = pathlib.Path(sys.argv[1]).resolve()
destination = pathlib.Path(sys.argv[2]).absolute()
if destination.resolve().is_relative_to(source):
    sys.exit('Choose a destination outside the sample source directory.')
# copytree creates the destination exclusively, also protecting concurrent runs.
# Copy sources and the provider lockfile, never local state or credentials.
shutil.copytree(source, destination, ignore=shutil.ignore_patterns(
    '.terraform', '.vercel', 'secrets', '*.tfstate*', '*.tfplan', '*.tfvars',
    '.env', '.env.*', '*.log',
))
PY
echo "Created demo in $destination. See examples/README.md in the Afe checkout."
