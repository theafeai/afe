import type { CanonicalEventInputLike } from "../src/index.ts";

export const SHA = "4f2c9b8e1d7a6b5c3e2f1a0b9c8d7e6f5a4b3c2d";

/** A realistic GitHub deployment event input. */
export function deploymentInput(
  overrides: Partial<CanonicalEventInputLike> = {},
): CanonicalEventInputLike {
  return {
    source: "github",
    sourceEventId: "deployment:1234567:created",
    connectionId: "conn_gh_1",
    action: "deployment.created",
    actor: {
      type: "user",
      id: "583231",
      login: "octocat",
      name: "The Octocat",
      email: null,
      onBehalfOf: null,
      triggeredBy: { type: "bot", id: "41898282", login: "github-actions[bot]" },
    },
    target: {
      type: "environment",
      id: "acme/api:production",
      name: "production",
      repository: "acme/api",
      environment: "production",
      ref: "refs/heads/main",
    },
    trigger: { type: "upstream", sourceValue: "workflow_run" },
    outcome: "pending",
    occurredAt: "2026-10-01T12:00:00.123456+02:00",
    observedAt: new Date("2026-10-01T10:00:01.500Z"),
    observation: { method: "webhook", deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958" },
    correlation: {
      commitShas: [SHA.toUpperCase(), SHA],
      refs: ["refs/heads/main"],
      repositories: ["github.com/Acme/API"],
      environments: ["Production"],
      deploymentIds: ["github:1234567"],
    },
    data: { task: "deploy", payload: { n: 1 } },
    rawPayload: { contentType: "application/json", body: '{"deployment":{"id":1234567}}' },
    ...overrides,
  };
}
