#!/usr/bin/env python3
"""Human-facing local Docker workflow; invoked by start-local-afe.sh."""

import argparse
import base64
import getpass
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
PROJECT = "afe-demo-local"  # Keep the original helper's database volume.


def fail(message):
    raise RuntimeError(message)


def write_new(path, value, mode):
    # Exclusive creation: setup must never truncate an existing key or config.
    with path.open("x") as out:
        out.write(value)
    path.chmod(mode)


def setup():
    env = ROOT / ".env"
    directory = ROOT / "secrets"
    key = directory / "afe_encryption_key"
    token = directory / "afe_admin_token"
    if env.is_symlink() or directory.is_symlink():
        fail(".env and secrets must be regular local files/directories, not symlinks.")
    if env.exists() or directory.exists():
        # Missing state might belong to a populated database. Generating a new
        # key/password here would make existing connections/data inaccessible.
        for path in (env, key, token):
            if not path.is_file() or not path.read_text().strip():
                fail(f"Missing or empty {path.relative_to(ROOT)}. Restore it from your "
                     "existing local setup/backup; refusing to replace persistent credentials.")
        print("Reusing .env, encryption key and login password.")
        return

    os.umask(0o077)
    directory.mkdir(mode=0o700)
    write_new(key, base64.b64encode(secrets.token_bytes(32)).decode() + "\n", 0o644)
    write_new(token, secrets.token_hex(32) + "\n", 0o644)
    config = (ROOT / ".env.example").read_text()
    config = config.replace("POSTGRES_PASSWORD=\n", f"POSTGRES_PASSWORD={secrets.token_hex(24)}\n")
    write_new(env, config, 0o600)
    print("Created local settings once. Keep .env and secrets/ across rebuilds.")


def compose_args():
    args = ["docker", "compose", "--project-name", PROJECT,
            "--env-file", str(ROOT / ".env"), "-f", str(ROOT / "docker-compose.yml"),
            "-f", str(ROOT / "docker-compose.local.yml")]
    # The GitHub helper stores file references in .env. Always retain their
    # mounts when recreating containers, including after a source rebuild.
    config = (ROOT / ".env").read_text()
    if any(line.startswith(("AFE_GITHUB_APP_PRIVATE_KEY_FILE=", "AFE_GITHUB_WEBHOOK_SECRET_FILE="))
           for line in config.splitlines()):
        args += ["-f", str(ROOT / "examples/local-github-compose.yml")]
    return args


def run(args):
    subprocess.run(args, cwd=ROOT, check=True)


def main():
    parser = argparse.ArgumentParser(
        description="Run Afe locally without replacing settings, passwords or connections.")
    parser.add_argument("command", nargs="?", default="up",
                        choices=["up", "setup", "stop", "down", "logs", "status", "password"])
    parser.add_argument("--set", action="store_true", help="choose a login password (password command only)")
    args = parser.parse_args()
    if args.set and args.command != "password":
        parser.error("--set is only supported with password")

    if args.command in ("setup", "up"):
        if args.command == "up":
            if not shutil.which("docker"):
                fail("Docker is required. Install Docker Desktop or Docker Engine with Compose.")
            run(["docker", "compose", "version"])
            run(["docker", "info", "--format", "{{.ServerVersion}}"])
        setup()
    elif not (ROOT / ".env").is_file():
        fail("No local setup found. Run: sh examples/start-local-afe.sh setup")

    if args.command == "setup":
        return
    if args.command == "password":
        path = ROOT / "secrets/afe_admin_token"
        if args.set:
            password = getpass.getpass("New local login password (at least 32 characters, no whitespace): ")
            if len(password) < 32 or len(password) > 1024 or any(c.isspace() for c in password):
                fail("Use 32–1024 characters with no whitespace (a long passphrase with hyphens works).")
            if password != getpass.getpass("Confirm password: "):
                fail("Passwords do not match; existing password kept.")
            if not path.is_file() or path.is_symlink():
                fail("Restore secrets/afe_admin_token before changing the password.")
            path.write_text(password + "\n")
            print("Password saved. Run sh examples/start-local-afe.sh to apply it; existing sessions will end.")
        else:
            # Explicit local terminal request only; never print it on startup.
            print(path.read_text().strip())
        return

    compose = compose_args()
    if args.command == "up":
        # Compose cannot --wait on the worker: its HTTP healthcheck is disabled.
        # Recreate the app roles to reload edited secret files even when the
        # image is cached. PostgreSQL keeps running as their dependency.
        run(compose + ["up", "-d", "--build", "--force-recreate", "afe-server", "afe-worker"])
        run(compose + ["up", "-d", "--wait", "--wait-timeout", "180", "afe-server"])
        run(compose + ["ps"])
        print("Afe is ready. The host port is AFE_HTTP_PORT in .env (default http://localhost:8080).")
        print("Show your saved login password: sh examples/start-local-afe.sh password")
    elif args.command == "logs":
        run(compose + ["logs", "--follow", "--tail", "100", "afe-server", "afe-worker"])
    elif args.command == "status":
        run(compose + ["ps"])
    else:
        run(compose + [args.command])
        print("Stopped. Database, .env and secrets are retained; run sh examples/start-local-afe.sh to resume.")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError) as error:
        print(f"Local Afe: {error}", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as error:
        print("Local Afe: Docker command failed. Check Docker Desktop/Engine is running, "
              "the port in .env is available, and inspect logs with "
              "sh examples/start-local-afe.sh logs. Your settings and secrets were kept.", file=sys.stderr)
        sys.exit(error.returncode)
    except KeyboardInterrupt:
        sys.exit(130)
