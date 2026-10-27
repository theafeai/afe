import type { JsonObject } from "@afe/core";
import { checkPermissions } from "./permissions.ts";
import type {
  GitHubAccount,
  GitHubInstallation,
  GitHubInstallationRepository,
  GitHubUser,
} from "./types.ts";

/** Headers GitHub sends with every delivery. */
export const GITHUB_HEADERS = {
  event: "x-github-event",
  delivery: "x-github-delivery",
  signature: "x-hub-signature-256",
  hookInstallationTargetId: "x-github-hook-installation-target-id",
} as const;

export interface DeliveryHeaders {
  event: string;
  deliveryId: string;
}

/** Extracts event name and delivery id; null if missing or malformed. */
export function readDeliveryHeaders(
  headers: Record<string, string | string[] | undefined>,
): DeliveryHeaders | null {
  const event = headers[GITHUB_HEADERS.event];
  const deliveryId = headers[GITHUB_HEADERS.delivery];
  if (typeof event !== "string" || !/^[a-z_]{1,64}$/.test(event)) return null;
  if (typeof deliveryId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(deliveryId)) return null;
  return { event, deliveryId };
}

// --- Lifecycle payloads -------------------------------------------------------
// https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation
// https://docs.github.com/en/webhooks/webhook-events-and-payloads#installation_repositories

export type InstallationAction =
  "created" | "deleted" | "suspend" | "unsuspend" | "new_permissions_accepted";

export interface InstallationEventPayload {
  action: InstallationAction | string;
  installation: GitHubInstallation;
  /** Present on `created` when repository_selection is "selected" (and sometimes "all"). */
  repositories?: GitHubInstallationRepository[];
  sender?: GitHubUser;
}

export interface InstallationRepositoriesEventPayload {
  action: "added" | "removed" | string;
  installation: GitHubInstallation;
  repository_selection: "all" | "selected";
  repositories_added: GitHubInstallationRepository[];
  repositories_removed: GitHubInstallationRepository[];
  sender?: GitHubUser;
}

/** Installation id of any App webhook payload (`installation.id`), if present. */
export function installationIdOf(payload: unknown): number | null {
  const id = (payload as { installation?: { id?: unknown } } | null)?.installation?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

// --- Connection config ------------------------------------------------------

export interface RepoRef {
  id: number;
  fullName: string;
}

/**
 * Non-secret config stored on the shared `connections` row of an installation
 * (`externalId` = installation id, `name` = account login).
 */
export interface GitHubConnectionConfig {
  installationId: number;
  appId: number;
  account: { id: number; login: string; type: string };
  repositorySelection: "all" | "selected";
  /** "all" when every repository is selected, otherwise the selected ones. */
  repositories: "all" | RepoRef[];
  permissions: Record<string, string>;
  events: string[];
  permissionCheck: {
    ok: boolean;
    missing: string[];
    writable: string[];
    extra: string[];
    /** Optional features that are off (AFE-21); absent on configs stored earlier. */
    optionalMissing?: string[];
  };
  suspendedAt: string | null;
}

export function repoRefs(repos: { id: number; full_name: string }[]): RepoRef[] {
  const byId = new Map<number, RepoRef>();
  for (const r of repos) byId.set(r.id, { id: r.id, fullName: r.full_name });
  return [...byId.values()].sort((a, b) => a.fullName.localeCompare(b.fullName) || a.id - b.id);
}

export function accountName(account: GitHubAccount | null | undefined, installationId: number) {
  return account?.login ?? `installation-${installationId}`;
}

/** Builds the connection config from an installation (and its repos when selected). */
export function connectionConfig(
  installation: GitHubInstallation,
  repositories: { id: number; full_name: string }[] | null,
): GitHubConnectionConfig {
  const selection = installation.repository_selection === "all" ? "all" : "selected";
  return {
    installationId: installation.id,
    appId: installation.app_id,
    account: {
      id: installation.account?.id ?? 0,
      login: accountName(installation.account, installation.id),
      type: installation.account?.type ?? installation.target_type ?? "unknown",
    },
    repositorySelection: selection,
    repositories: selection === "all" ? "all" : repoRefs(repositories ?? []),
    permissions: { ...(installation.permissions ?? {}) },
    events: [...(installation.events ?? [])].sort(),
    permissionCheck: checkPermissions(installation.permissions),
    suspendedAt: installation.suspended_at ?? null,
  };
}

/** Applies an `installation_repositories` change to the stored repository list. */
export function applyRepositoryChange(
  current: GitHubConnectionConfig["repositories"] | undefined,
  payload: InstallationRepositoriesEventPayload,
): GitHubConnectionConfig["repositories"] {
  if (payload.repository_selection === "all") return "all";
  const base = current === "all" || current === undefined ? [] : current;
  const removed = new Set((payload.repositories_removed ?? []).map((r) => r.id));
  const kept = base.filter((r) => !removed.has(r.id));
  return repoRefs([
    ...kept.map((r) => ({ id: r.id, full_name: r.fullName })),
    ...(payload.repositories_added ?? []),
  ]);
}

export function toJson(config: GitHubConnectionConfig): JsonObject {
  return JSON.parse(JSON.stringify(config)) as JsonObject;
}

// --- Job boundary with AFE-7 ---------------------------------------------------

/** Queue name for non-lifecycle deliveries. AFE-7 implements the processing. */
export const GITHUB_WEBHOOK_JOB = "github.webhook";

/**
 * Payload of a `github.webhook` job: one verified, de-duplicated delivery for
 * one connection. Contains no credentials. `rawBody` is the exact delivery
 * text, so the worker can store the byte-exact body in raw_payloads.
 */
export interface GitHubWebhookJob {
  tenantId: string;
  connectionId: string;
  installationId: number;
  deliveryId: string;
  event: string;
  action: string | null;
  receivedAt: string;
  payload: JsonObject;
  rawBody: string;
}
