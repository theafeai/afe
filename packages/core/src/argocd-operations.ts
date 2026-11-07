import { z } from "zod";

export { ARGOCD_OPERATIONS, ARGOCD_SYNC_OPTIONS } from "./argocd-catalog.ts";
import { type ARGOCD_OPERATIONS, ARGOCD_SYNC_OPTIONS } from "./argocd-catalog.ts";
export type ArgoCdOperation = (typeof ARGOCD_OPERATIONS)[number][0];
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,252}$/);
const group = z.string().regex(/^[a-zA-Z0-9.-]{0,253}$/);
const revision = z
  .string()
  .min(1)
  .max(256)
  .regex(/^\S+$/)
  .refine(
    (value) =>
      [...value].every((c) => {
        const n = c.codePointAt(0)!;
        return n >= 32 && n !== 127 && (n < 0xd800 || n > 0xdfff);
      }),
    "Revision contains invalid characters",
  );
export const argoCdResourceSchema = z
  .object({
    group,
    kind: name,
    namespace: name.or(z.literal("")),
    name,
  })
  .strict();
export type ArgoCdResource = z.infer<typeof argoCdResourceSchema>;
const schemas = {
  "argocd.refresh": z.object({}).strict(),
  "argocd.hard_refresh": z.object({}).strict(),
  "argocd.sync": z
    .object({
      revision: revision.optional(),
      revisions: z.array(revision).min(1).max(20).optional(),
      resources: z.array(argoCdResourceSchema).min(1).max(100).optional(),
      prune: z.boolean().default(false),
      dryRun: z.boolean().default(false),
      force: z.boolean().default(false),
      syncOptions: z.array(z.enum(ARGOCD_SYNC_OPTIONS)).max(11).default([]),
    })
    .strict()
    .refine((p) => !(p.revision && p.revisions), "Select revision or revisions, not both"),
  "argocd.rollback": z
    .object({ id: z.number().int().nonnegative().safe(), prune: z.boolean().default(false) })
    .strict(),
  "argocd.terminate": z.object({}).strict(),
  "argocd.resource_action": z.object({ resource: argoCdResourceSchema, name }).strict(),
  "argocd.sync_policy": z
    .object({
      automated: z.boolean(),
      prune: z.boolean(),
      selfHeal: z.boolean(),
      allowEmpty: z.boolean(),
    })
    .strict()
    .refine(
      (p) => p.automated || !(p.prune || p.selfHeal || p.allowEmpty),
      "Automatic sync options require automatic sync",
    ),
  "argocd.delete": z
    .object({ cascade: z.boolean(), propagationPolicy: z.enum(["foreground", "background"]) })
    .strict(),
};
export function parseArgoCdOperation(action: unknown, params: unknown) {
  if (typeof action !== "string" || !Object.hasOwn(schemas, action))
    throw new Error("Unknown ArgoCD operation.");
  return schemas[action as ArgoCdOperation].parse(params);
}
export function argoCdOperationSchema(action: ArgoCdOperation): Record<string, unknown> {
  return z.toJSONSchema(schemas[action]);
}
export interface ArgoCdApplicationChoice {
  connectionId: string;
  connectionName: string;
  application: string;
  appNamespace: string;
  transport: "direct" | "agent";
}
export interface ArgoCdCapability {
  action: ArgoCdOperation;
  label: string;
  destructive: boolean;
  enabled: boolean;
  reason: string | null;
  paramsSchema: Record<string, unknown>;
}
export interface ArgoCdApplicationView {
  context: ArgoCdApplicationChoice & { uid: string; operationId: string | null };
  sourceUrl: string;
  sync: string;
  health: string;
  revision: string;
  operation: string;
  history: { id: number; revision: string; deployedAt: string | null }[];
  resources: (ArgoCdResource & { status: string; health: string })[];
  capabilities: ArgoCdCapability[];
  actionsEnabled: boolean;
}
export interface ArgoCdPreparedOperation {
  action: ArgoCdOperation;
  version: string;
  summary: string;
  context: ArgoCdApplicationView["context"];
}
export interface ArgoCdOperationReceipt {
  requestId: string;
  action: ArgoCdOperation;
  state: "requested" | "accepted" | "rejected" | "unknown" | "released";
  message: string;
  createdAt: string;
}
