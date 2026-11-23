/**
 * Input schemas of the setup API (admin overrides). Values are checked per
 * field, so a stored override always has the shape its field needs.
 */
import { z } from "zod";
import { MAPPING_ID_PATTERN } from "../mapping/validate.ts";
import { BATCHING_VALUES, GATING_VALUES, OVERRIDE_FIELDS, type OverrideField } from "./types.ts";

const noControl = (s: string) => ![...s].some((c) => c.charCodeAt(0) < 0x20 || c === "\u007f");

/** The value schema of each overridable field. */
export const OVERRIDE_VALUE_SCHEMAS: Record<OverrideField, z.ZodType> = {
  name: z.string().trim().min(1).max(128).refine(noControl, { message: "no control characters" }),
  order: z.number().int().min(0).max(1_000_000),
  productionLike: z.boolean(),
  gating: z.enum(GATING_VALUES),
  batching: z.enum(BATCHING_VALUES),
  included: z.boolean(),
};

const change = z.strictObject({
  environment: z.string().regex(MAPPING_ID_PATTERN, "unknown environment"),
  field: z.enum(OVERRIDE_FIELDS),
  /** Set this value. */
  value: z.unknown().optional(),
  /** Remove the override ("Use Afe's guess"). */
  clear: z.literal(true).optional(),
  /** Keep the current value against Afe's current guess ("Keep yours"). */
  keep: z.literal(true).optional(),
});

export const setupChangesSchema = z
  .strictObject({ changes: z.array(change).min(1).max(100) })
  .superRefine((input, ctx) => {
    const seen = new Set<string>();
    for (const [i, c] of input.changes.entries()) {
      const modes = [c.value !== undefined, c.clear === true, c.keep === true].filter(Boolean);
      if (modes.length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["changes", i],
          message: "give exactly one of value, clear or keep",
        });
        continue;
      }
      const key = `${c.environment}\u0000${c.field}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: ["changes", i],
          message: "one change per environment and field",
        });
      }
      seen.add(key);
      if (c.value !== undefined) {
        const r = OVERRIDE_VALUE_SCHEMAS[c.field].safeParse(c.value);
        if (!r.success) {
          ctx.addIssue({
            code: "custom",
            path: ["changes", i, "value"],
            message: `invalid ${c.field}: ${r.error.issues[0]?.message ?? "bad value"}`,
          });
        }
      }
    }
  });
export type SetupChangesInput = z.output<typeof setupChangesSchema>;
export type SetupChange = SetupChangesInput["changes"][number];
