/**
 * Input validation for mapping configuration (API and storage).
 */
import { z } from "zod";
import { isMappingField } from "./fields.ts";
import { compileMatcher } from "./resolve.ts";
import { ENVIRONMENT_KINDS, MATCH_TYPES, RULE_KINDS, type MappingRule } from "./types.ts";

export const MAPPING_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** Upper bounds that keep resolution cheap and the UI usable. */
export const MAPPING_LIMITS = { services: 500, environments: 50, rulesPerKind: 500 } as const;

const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(noControl, { message: "must not contain control characters" });

export const mappingIdSchema = z
  .string()
  .regex(MAPPING_ID_PATTERN, "id must be lower case letters, digits, - and _ (max 64)");

/** Derives a slug id from a display name ("Payments API" → "payments-api"). */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return s || "item";
}

export const serviceInputSchema = z.strictObject({
  id: mappingIdSchema.optional(),
  name: text(128),
  description: text(1024).nullish(),
});
export type ServiceInput = z.output<typeof serviceInputSchema>;

export const environmentInputSchema = z.strictObject({
  id: mappingIdSchema.optional(),
  name: text(128),
  kind: z.enum(ENVIRONMENT_KINDS).default("other"),
  order: z.number().int().min(0).max(1_000_000).optional(),
});
export type EnvironmentInput = z.output<typeof environmentInputSchema>;

export const ruleInputSchema = z
  .strictObject({
    kind: z.enum(RULE_KINDS),
    field: z
      .string()
      .max(300)
      .refine(isMappingField, { message: "unknown field (see MAPPING_FIELDS or argocd.label:<key>)" }),
    match: z.enum(MATCH_TYPES),
    pattern: z.string().min(1).max(256).refine(noControl, {
      message: "must not contain control characters",
    }),
    caseSensitive: z.boolean().default(false),
    priority: z.number().int().min(0).max(1_000_000_000).optional(),
    targetId: mappingIdSchema,
    enabled: z.boolean().default(true),
    note: text(512).nullish(),
  })
  .superRefine((r, ctx) => {
    try {
      compileMatcher(r);
    } catch (err) {
      ctx.addIssue({ code: "custom", path: ["pattern"], message: (err as Error).message });
    }
  });
export type RuleInput = z.output<typeof ruleInputSchema>;

/** A rule as proposed in a preview (an id is optional; new rules get a placeholder). */
export const proposedRuleSchema = z.intersection(
  ruleInputSchema,
  z.object({ id: z.string().max(64).optional() }),
);

export const reorderInputSchema = z.strictObject({
  kind: z.enum(RULE_KINDS),
  ids: z.array(z.string().max(64)).max(MAPPING_LIMITS.rulesPerKind),
});

export const builtinToggleSchema = z.strictObject({ enabled: z.boolean() });

/** First validation issue as a single readable message. */
export function describeIssues(err: z.ZodError): string {
  const i = err.issues[0];
  if (!i) return "invalid input";
  const path = i.path.length ? `${i.path.join(".")}: ` : "";
  return `${path}${i.message}`;
}

/** Normalised rule (from validated input) for storage or preview. */
export function toRule(id: string, input: RuleInput, priority: number): MappingRule {
  return {
    id,
    kind: input.kind,
    field: input.field as MappingRule["field"],
    match: input.match,
    pattern: input.pattern,
    caseSensitive: input.caseSensitive,
    priority: input.priority ?? priority,
    targetId: input.targetId,
    enabled: input.enabled,
    note: input.note ?? null,
  };
}
