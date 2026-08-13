import { z } from "zod"

const sourceAdapterSchema = z.enum(["codebase", "figma", "storybook"])

const validTimestampSchema = z.string().refine((value) => Number.isFinite(new Date(value).getTime()), {
  message: "must be a valid timestamp"
})

const conflictSchema = z
  .looseObject({
    resolution: z.enum(["auto", "manual", "pending"]).optional(),
    // Identity/remediation are rendered only for pending conflicts. Keep them
    // opaque for other states rather than defining a complete conflict schema here.
    type: z.unknown().optional(),
    name: z.unknown().optional(),
    suggestedFix: z.unknown().optional()
  })
  .superRefine((conflict, ctx) => {
    if (conflict.resolution !== "pending") return
    if (conflict.type !== "token" && conflict.type !== "component") {
      ctx.addIssue({
        code: "custom",
        path: ["type"],
        message: 'must be "token" or "component" for a pending conflict'
      })
    }
    if (typeof conflict.name !== "string") {
      ctx.addIssue({ code: "custom", path: ["name"], message: "must be a string for a pending conflict" })
    }
    if (conflict.suggestedFix !== undefined && typeof conflict.suggestedFix !== "string") {
      ctx.addIssue({
        code: "custom",
        path: ["suggestedFix"],
        message: "must be a string when present on a pending conflict"
      })
    }
  })

// Fields reached by both verification modes after the public envelope check.
export const verifySharedContractSchema = z.looseObject({
  generatedAt: validTimestampSchema,
  conflicts: z.array(conflictSchema),
  componentNameIndex: z.record(z.string(), z.array(z.string())).optional()
})

// Token provenance is deliberately optional here: default verify already treats
// its absence as unknown for failed-source suppression. When present, its reached
// adapter must be safe to use as a source-status identity.
const optionalTokenProvenanceSchema = z.looseObject({
  adapter: sourceAdapterSchema.optional()
})

const verifyTokenSchema = z.looseObject({
  value: z.string(),
  source: optionalTokenProvenanceSchema.optional(),
  modes: z.record(z.string(), z.string()).optional(),
  modeSources: z.record(z.string(), optionalTokenProvenanceSchema).optional()
})

const verifyComponentSchema = z.looseObject({
  name: z.string(),
  displayName: z.string().optional(),
  source: z.looseObject({
    adapter: sourceAdapterSchema,
    file: z.string().optional()
  })
})

// Reached only by default verification's structural comparison with a fresh build.
export const verifyDefaultContractSchema = z.looseObject({
  tokens: z.record(z.string(), z.record(z.string(), verifyTokenSchema)),
  components: z.record(z.string(), verifyComponentSchema)
})

const verifySourceStatusSchema = z.looseObject({
  status: z.enum(["ok", "failed", "skipped"]),
  error: z.string().optional()
})

const verifyViolationSchema = z.looseObject({
  type: z.literal("token-misuse"),
  category: z.enum(["colors", "spacing"]),
  found: z.string(),
  context: z.string(),
  source: z.looseObject({
    file: z.string(),
    line: z.number().finite(),
    column: z.number().finite()
  }),
  suggestion: z
    .looseObject({
      token: z.string(),
      category: z.string(),
      value: z.string()
    })
    .optional()
})

// Reached only by --fast, which trusts committed scan health and violations
// instead of rebuilding them. Contribution counts remain loose because fast
// verification neither dereferences nor returns those fields.
export const verifyFastContractSchema = z.looseObject({
  sourceStatuses: z.record(z.string(), verifySourceStatusSchema).optional(),
  violations: z.array(verifyViolationSchema).optional()
})
