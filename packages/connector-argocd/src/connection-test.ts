import type { ArgoCdClient } from "./client.ts";
import { ArgoCdError } from "./errors.ts";

/**
 * Write capabilities Afe must not have (docs/connectors/argocd.md). Checked
 * with `can-i` against wildcard objects and against a sample of real
 * applications. `exec` is checked because it gives a shell in workloads.
 */
export const WRITE_CAPABILITY_CHECKS: readonly { resource: string; action: string }[] = [
  { resource: "applications", action: "sync" },
  { resource: "applications", action: "override" },
  { resource: "applications", action: "update" },
  { resource: "applications", action: "delete" },
  { resource: "applications", action: "create" },
  { resource: "exec", action: "create" },
];

/** Read capabilities Afe does not need and that may expose sensitive data. */
export const SENSITIVE_READ_CHECKS: readonly { resource: string; action: string }[] = [
  { resource: "logs", action: "get" },
];

export interface ReadOnlyCheck {
  /** "verified": no write capability found; "write_capable": at least one found; "unavailable": can-i not usable. */
  status: "verified" | "write_capable" | "unavailable";
  /** e.g. `applications/sync on default/guestbook`. */
  writeCapabilities: string[];
  /** e.g. `logs/get on *`: allowed but not needed. */
  sensitiveReadCapabilities: string[];
  /** Objects checked (wildcards and sample applications). */
  objectsChecked: string[];
}

export interface ConnectionTestResult {
  version: string | null;
  username: string;
  issuer: string | null;
  /** Number of applications visible to the token (the token can read something). */
  applicationCount: number;
  readOnly: ReadOnlyCheck;
  warnings: string[];
}

export interface TestConnectionOptions {
  /** Max applications to run `can-i` against individually; default 5. */
  sampleApplications?: number;
}

/**
 * Verifies a connection: the server answers (`/api/version`), the token is a
 * valid logged-in account (`/session/userinfo`), it can list applications, and
 * it is read-only as far as ArgoCD's `can-i` reports.
 *
 * The read-only check is a guard against obviously over-privileged tokens
 * (admin, `role:admin`, roles with `sync`), not a proof: `can-i` evaluates
 * concrete objects, and a policy limited to objects we do not sample would not
 * be detected. The documented RBAC policy is the actual control.
 */
export async function testArgoCdConnection(
  client: ArgoCdClient,
  options: TestConnectionOptions = {},
): Promise<ConnectionTestResult> {
  const warnings: string[] = [];
  const version = await client.getVersion();
  const user = await client.getUserInfo();
  if (!user.loggedIn || !user.username) {
    throw new ArgoCdError(
      "unauthorized",
      "token rejected: ArgoCD reports the session is not logged in",
    );
  }
  const list = await client.listApplications({
    fields: ["items.metadata.name", "items.metadata.namespace", "items.spec.project"],
  });
  const apps = list.items ?? [];

  const objects = ["*", "*/*"];
  for (const app of apps.slice(0, options.sampleApplications ?? 5)) {
    const name = app.metadata?.name;
    const project = app.spec?.project;
    if (name && project) objects.push(`${project}/${name}`);
  }

  const readOnly: ReadOnlyCheck = {
    status: "verified",
    writeCapabilities: [],
    sensitiveReadCapabilities: [],
    objectsChecked: objects,
  };
  try {
    for (const check of [...WRITE_CAPABILITY_CHECKS, ...SENSITIVE_READ_CHECKS]) {
      const write = WRITE_CAPABILITY_CHECKS.includes(check);
      for (const obj of objects) {
        if (await client.canI(check.resource, check.action, obj)) {
          const label = `${check.resource}/${check.action} on ${obj}`;
          (write ? readOnly.writeCapabilities : readOnly.sensitiveReadCapabilities).push(label);
          break;
        }
      }
    }
  } catch (e) {
    if (
      !(e instanceof ArgoCdError) ||
      !["not_found", "forbidden", "unexpected_status"].includes(e.kind)
    ) {
      throw e;
    }
    readOnly.status = "unavailable";
    warnings.push(
      "could not verify that the token is read-only (account/can-i is unavailable on this ArgoCD version); check the RBAC policy manually",
    );
  }
  if (readOnly.writeCapabilities.length > 0) readOnly.status = "write_capable";
  if (readOnly.sensitiveReadCapabilities.length > 0) {
    warnings.push(
      `the token can read ${readOnly.sensitiveReadCapabilities.join(", ")}; Afe does not need this, remove it from the role`,
    );
  }
  if (apps.length === 0) {
    warnings.push("the token cannot see any application; check the role's applications policy");
  }

  return {
    version: version.Version ?? null,
    username: user.username,
    issuer: user.iss ?? null,
    applicationCount: apps.length,
    readOnly,
    warnings,
  };
}
