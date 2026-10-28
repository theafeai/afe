import { z } from "zod";
import { repositoryKey, type CanonicalEventInputLike, type Connection } from "@afe/core";

export const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const connectionInput = z.strictObject({
  workspace: identifier,
  environment: identifier.optional(),
  repository: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
    .max(256)
    .optional(),
});

/** No arbitrary objects, resource values, state, plan contents, outputs or logs. */
export const reportSchema = z
  .strictObject({
    version: z.literal(1),
    runId: z.uuid(),
    operation: z.enum(["plan", "apply", "destroy"]),
    phase: z.enum(["started", "completed"]),
    sentAt: z.iso.datetime({ offset: true }),
    occurredAt: z.iso.datetime({ offset: true }),
    exitCode: z.number().int().min(0).max(255).optional(),
    actor: identifier.optional(),
    commitSha: z
      .string()
      .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/)
      .optional(),
    githubRunId: z
      .string()
      .regex(/^[1-9][0-9]{0,19}$/)
      .optional(),
    repository: connectionInput.shape.repository,
    trigger: z
      .enum(["cli", "push", "pull_request", "manual", "schedule", "api", "unknown"])
      .default("cli"),
  })
  .superRefine((r, ctx) => {
    if ((r.phase === "completed") !== (r.exitCode !== undefined)) {
      ctx.addIssue({ code: "custom", message: "Only completed reports require an exit code" });
    }
  });
export type TerraformReport = z.infer<typeof reportSchema>;

export function reportKey(r: TerraformReport): string {
  return `${r.runId.toLowerCase()}:${r.operation}:${r.phase}`;
}

export function terraformEvent(
  connection: Connection,
  report: TerraformReport,
  receivedAt: Date,
): CanonicalEventInputLike {
  const config = connectionInput.parse(connection.config);
  const code = report.exitCode;
  const outcome =
    report.phase === "started"
      ? "in_progress"
      : code === 130 || code === 143
        ? "cancelled"
        : code === 0 || (report.operation === "plan" && code === 2)
          ? "succeeded"
          : "failed";
  return {
    source: "terraform",
    sourceEventId: `${connection.externalId}:${reportKey(report)}`,
    connectionId: connection.id,
    action: `terraform.${report.operation}.${report.phase}`,
    actor: report.actor ? { type: "user", login: report.actor } : { type: "unknown" },
    target: {
      type: "workflow_run",
      id: `${connection.externalId}/${report.runId.toLowerCase()}`,
      name: `${config.workspace}: ${report.operation}`,
      project: config.workspace,
      environment: config.environment,
      repository: config.repository,
    },
    trigger: { type: report.trigger, sourceValue: "runner_report" },
    outcome,
    occurredAt: report.occurredAt,
    observedAt: receivedAt,
    observation: {
      method: "webhook",
      deliveryId: `${connection.externalId}:${reportKey(report)}`,
      detail: "Runner-reported Terraform CLI metadata; not verified against Terraform state.",
    },
    correlation: {
      repositories: config.repository ? [repositoryKey(config.repository)] : undefined,
      commitShas: report.commitSha ? [report.commitSha.toLowerCase()] : undefined,
      runIds: [
        `terraform:${connection.externalId}:${report.runId.toLowerCase()}`,
        ...(report.githubRunId && config.repository ? [`github:${report.githubRunId}`] : []),
      ],
      environments: config.environment ? [config.environment] : undefined,
    },
    data: {
      workspace: config.workspace,
      operation: report.operation,
      phase: report.phase,
      exitCode: code ?? null,
      changesPresent:
        report.operation === "plan" && report.phase === "completed" && (code === 0 || code === 2)
          ? code === 2
          : null,
      attribution: "runner_reported",
      gitAttribution: report.commitSha ? "runner_reported" : "unavailable",
    },
  };
}
