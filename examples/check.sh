#!/bin/sh
set -eu
examples_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT HUP INT TERM
sh "$examples_dir/create-demo.sh" "$scratch/demo"
if sh "$examples_dir/create-demo.sh" "$scratch/demo" 2>/dev/null; then
  echo "Copy helper must refuse an existing destination" >&2
  exit 1
fi
python3 - "$scratch/demo" <<'PY'
import functools
import http.server
import json
import pathlib
import sys
import threading
import urllib.request

demo = pathlib.Path(sys.argv[1])
assert (demo / '.github/workflows/pages.yml').is_file()
assert not list(demo.rglob('*.tfstate*'))
assert not (demo / 'terraform/.terraform').exists()
assert not (demo / '.vercel').exists()
config = json.loads((demo / 'vercel.json').read_text())
assert config['framework'] is None and config['outputDirectory'] == 'site'
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(demo / 'site'))
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
try:
    url = f'http://127.0.0.1:{server.server_port}/'
    assert 'Version 1' in urllib.request.urlopen(url).read().decode()
    page = demo / 'site/index.html'
    page.write_text(page.read_text().replace('Version 1', 'Version 2'))
    assert 'Version 2' in urllib.request.urlopen(url).read().decode()
finally:
    server.shutdown()
    server.server_close()
    thread.join()
print('Standalone copy and real HTTP version-change checks passed.')
PY
