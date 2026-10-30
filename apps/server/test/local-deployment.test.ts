import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Exercise the real entrypoint in isolated checkouts. Docker is replaced only
// at the process boundary, so these tests never touch a developer's local stack.
const source = resolve(import.meta.dirname, "../../..");
let root: string;
let env: NodeJS.ProcessEnv;
function start(...args: string[]) {
  return spawnSync("sh", [join(root, "examples/start-local-afe.sh"), ...args], {
    cwd: tmpdir(), // Also verify invocation from outside the checkout.
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}
function snapshot() {
  const read = (path: string) => readFileSync(join(root, path), "utf8");
  return [
    read(".env"),
    read("secrets/afe_encryption_key"),
    read("secrets/afe_admin_token"),
  ] as const;
}
function calls(): string[][] {
  return readFileSync(join(root, "docker-calls"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "afe-local-test-"));
  mkdirSync(join(root, "examples"));
  mkdirSync(join(root, "bin"));
  for (const path of [
    ".env.example",
    "docker-compose.yml",
    "docker-compose.local.yml",
    "examples/start-local-afe.sh",
    "examples/local_afe.py",
    "examples/local-github-compose.yml",
  ]) {
    copyFileSync(join(source, path), join(root, path));
  }
  writeFileSync(
    join(root, "bin/docker"),
    `#!/usr/bin/env python3
import json, os, sys
with open(os.environ['DOCKER_CALLS'], 'a') as out:
    out.write(json.dumps(sys.argv[1:]) + '\\n')
if 'up' in sys.argv and os.environ.get('FAIL_UP'):
    sys.exit(1)
`,
  );
  chmodSync(join(root, "bin/docker"), 0o755);
  env = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    DOCKER_CALLS: join(root, "docker-calls"),
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("local Docker workflow", () => {
  it("creates private settings once, preserving all credentials and edits on rebuild", () => {
    const first = start();
    expect(first.status, first.stderr).toBe(0);
    const initial = snapshot();
    expect(initial[0]).toMatch(/POSTGRES_PASSWORD=[a-f0-9]{48}/);
    expect(Buffer.from(initial[1].trim(), "base64")).toHaveLength(32);
    expect(initial[2].trim()).toMatch(/^[a-f0-9]{64}$/);
    expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, "secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, "secrets/afe_encryption_key")).mode & 0o777).toBe(0o644);
    writeFileSync(join(root, ".env"), initial[0] + "\nAFE_HTTP_PORT=8081\n");
    const before = snapshot();
    const second = start();
    expect(second.status, second.stderr).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(first.stdout + second.stdout).not.toContain(initial[2].trim());
    const launches = calls().filter((args) => args.includes("up"));
    expect(launches).toHaveLength(4);
    for (const args of launches) {
      expect(args).toContain("afe-demo-local");
      expect(args).toContain(join(root, "docker-compose.local.yml"));
      if (args.includes("--wait")) {
        expect(args.at(-1)).toBe("afe-server");
        expect(args).not.toContain("afe-worker");
      } else {
        expect(args).toContain("--build");
        expect(args).toContain("--force-recreate");
        expect(args.slice(-2)).toEqual(["afe-server", "afe-worker"]);
      }
      expect(args).not.toContain("-v");
    }
  });

  it("keeps existing demo settings and custom passwords byte-for-byte", () => {
    expect(start("setup").status).toBe(0);
    writeFileSync(
      join(root, "secrets/afe_admin_token"),
      "my-persistent-local-passphrase-123456789\n",
    );
    const before = snapshot();
    expect(start().status).toBe(0);
    expect(snapshot()).toEqual(before);
    expect(start("password").stdout.trim()).toBe(before[2].trim());
  });

  it("keeps settings after a failed build/start and supports retry", () => {
    env.FAIL_UP = "1";
    expect(start().status).toBe(1);
    const before = snapshot();
    delete env.FAIL_UP;
    expect(start().status).toBe(0);
    expect(snapshot()).toEqual(before);
  });

  it.each([".env", "secrets/afe_encryption_key", "secrets/afe_admin_token"])(
    "refuses to replace missing persistent state: %s",
    (missing) => {
      expect(start("setup").status).toBe(0);
      rmSync(join(root, missing));
      const result = start();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Restore");
      expect(existsSync(join(root, missing))).toBe(false);
      expect(calls().some((args) => args.includes("up"))).toBe(false);
    },
  );

  it("does not replace an empty key", () => {
    expect(start("setup").status).toBe(0);
    writeFileSync(join(root, "secrets/afe_encryption_key"), "");
    expect(start().status).toBe(1);
    expect(readFileSync(join(root, "secrets/afe_encryption_key"), "utf8")).toBe("");
  });

  it("retains configured GitHub secret mounts for every lifecycle command", () => {
    expect(start("setup").status).toBe(0);
    writeFileSync(
      join(root, ".env"),
      snapshot()[0] + "\nAFE_GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/github_app_private_key\n",
    );
    for (const command of ["up", "stop", "down", "status", "logs"]) {
      expect(start(command).status).toBe(0);
    }
    for (const args of calls().filter((args) => args.includes("--project-name"))) {
      expect(args).toContain(join(root, "examples/local-github-compose.yml"));
      expect(args).not.toContain("-v");
      expect(args).not.toContain("--volumes");
    }
  });

  it.each([
    {
      answers: ["a-memorable-local-password-123456789", "a-memorable-local-password-123456789"],
      valid: true,
    },
    { answers: ["short", "short"], valid: false },
    { answers: ["a-memorable-local-password-123456789", "does-not-match"], valid: false },
  ])("validates interactive password changes ($valid, $answers)", ({ answers, valid }) => {
    expect(start("setup").status).toBe(0);
    const before = snapshot();
    // Supply answers at the terminal boundary without exposing them as CLI args.
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import getpass, json, runpy, sys
from unittest.mock import patch
sys.argv = [${JSON.stringify(join(root, "examples/local_afe.py"))}, 'password', '--set']
with patch.object(getpass, 'getpass', side_effect=json.loads(sys.stdin.readline())):
    runpy.run_path(sys.argv[0], run_name='__main__')
`,
      ],
      { env, encoding: "utf8", input: JSON.stringify(answers) + "\n", timeout: 5_000 },
    );
    expect(result.status, result.stderr).toBe(valid ? 0 : 1);
    expect(snapshot()[0]).toBe(before[0]);
    expect(snapshot()[1]).toBe(before[1]);
    expect(snapshot()[2]).toBe(valid ? answers[0] + "\n" : before[2]);
    expect(result.stdout + result.stderr).not.toContain(answers[0]);
  });

  it("setup and password retrieval work without invoking Docker", () => {
    expect(start("setup").status).toBe(0);
    expect(start("setup").status).toBe(0);
    expect(start("password").status).toBe(0);
    expect(existsSync(join(root, "docker-calls"))).toBe(false);
  });
});
