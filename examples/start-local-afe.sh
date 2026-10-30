#!/bin/sh
# Run from any directory on macOS/Linux or WSL2. State survives every rerun.
set -eu
command -v python3 >/dev/null 2>&1 || {
  echo 'Python 3 is required. Install it, then rerun this command.' >&2
  exit 1
}
exec python3 "$(dirname "$0")/local_afe.py" "$@"
