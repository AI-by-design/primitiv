import { z } from "zod"
import { primitivContractSchema } from "../types"

// Internal schema dependencies precede the exported schemas they initialize eagerly at module load.
const sourceAdapterSchema = z.enum(["codebase", "figma", "storybook"])

const validTimestampSchema = z.string().refine((value) => Number.isFinite(new Date(value).getTime()), {
  message: "must be a valid timestamp"
})

function ownRecordSchema(valueSchema: z.ZodType): z.ZodType<Record<string, unknown>> {
  return z.unknown().superRefine((value, ctx) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      ctx.addIssue({ code: "custom", message: "must be an object" })
      return
    }
    for (const key of Object.keys(value)) {
      const parsed = valueSchema.safeParse((value as Record<string, unknown>)[key])
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          ctx.addIssue({ code: "custom", path: [key, ...issue.path], message: issue.message })
        }
      }
    }
  }) as z.ZodType<Record<string, unknown>>
}

const conflictSchema = z
  .looseObject({
    resolution: z.enum(["auto", "manual", "pending"]).optional(),
    // Identity/remediation are rendered only for pending conflicts. Keep them
    // opaque for other states rather than defining a complete conflict schema here.
    type: z.unknown().optional(),
    name: z.unknown().optional(),
    suggestedFix: z.unknown().optional(),
    fieldPath: z.unknown().optional(),
    componentIds: z.unknown().optional()
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
    if (
      conflict.fieldPath !== undefined &&
      (!Array.isArray(conflict.fieldPath) ||
        conflict.fieldPath.length > 64 ||
        conflict.fieldPath.some((segment) => typeof segment !== "string" || segment.length > 4096))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fieldPath"],
        message: "must be a bounded string path when present on a pending conflict"
      })
    }
    if (
      conflict.type === "component" &&
      conflict.componentIds !== undefined &&
      (!Array.isArray(conflict.componentIds) ||
        conflict.componentIds.length > 10_000 ||
        conflict.componentIds.some((id) => typeof id !== "string" || id.length > 4096))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["componentIds"],
        message: "must be a bounded string array when present on a pending component conflict"
      })
    }
  })

// Fields reached by both verification modes after the public envelope check.
export const verifySharedContractSchema = z.looseObject({
  generatedAt: validTimestampSchema,
  conflicts: z.array(conflictSchema),
  componentNameIndex: ownRecordSchema(z.array(z.string())).optional(),
  comparisonDiagnostics: primitivContractSchema.shape.comparisonDiagnostics
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

const positiveRelationshipCountSchema = z.number().int().positive()

const demonstratedValueSchema = z.unknown().superRefine((root, ctx) => {
  const pending: Array<{ value: unknown; path: Array<string | number>; depth: number }> = [
    { value: root, path: [], depth: 0 }
  ]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    const value = current.value
    if (current.depth > 64) {
      ctx.addIssue({ code: "custom", path: current.path, message: "must contain at most 64 nested levels" })
      continue
    }
    if (value === null || typeof value === "boolean") continue
    if (typeof value === "number") {
      if (!Number.isFinite(value)) ctx.addIssue({ code: "custom", path: current.path, message: "must be finite" })
      continue
    }
    if (typeof value === "string") continue
    if (Array.isArray(value)) {
      for (const [index, child] of value.entries()) {
        pending.push({ value: child, path: [...current.path, index], depth: current.depth + 1 })
      }
      continue
    }
    if (typeof value === "object") {
      for (const key of Object.keys(value)) {
        pending.push({
          value: (value as Record<string, unknown>)[key],
          path: [...current.path, key],
          depth: current.depth + 1
        })
      }
      continue
    }
    ctx.addIssue({ code: "custom", path: current.path, message: "must contain only JSON-compatible values" })
  }
})

const propValueSchema = z.union([z.string(), z.number().finite(), z.boolean()])
const propSchema = z.looseObject({
  type: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  values: z.array(propValueSchema).optional(),
  kind: z.enum(["boolean", "text", "variant", "instance-swap"]).optional(),
  preferredValues: z.array(z.looseObject({ type: z.enum(["component", "component-set"]), key: z.string() })).optional(),
  incompleteFields: z.array(z.literal("values")).optional(),
  unsupportedFields: z.array(z.literal("type")).optional()
})

const controlSchema = z.looseObject({
  control: z.union([z.string(), z.literal(false)]).optional(),
  choices: z
    .array(
      z.looseObject({
        option: propValueSchema,
        mappedValue: demonstratedValueSchema.optional(),
        mappingUnresolved: z.boolean().optional()
      })
    )
    .optional(),
  unresolvedChoices: z.boolean().optional(),
  truncatedChoices: z.boolean().optional()
})

const demonstratedStorySchema = z.looseObject({
  id: z.string(),
  args: ownRecordSchema(demonstratedValueSchema).optional(),
  unresolvedArgs: z.array(z.string()).optional(),
  truncatedArgs: z.array(z.string()).optional(),
  hasUnresolvedArgsSpread: z.boolean().optional(),
  controls: ownRecordSchema(controlSchema).optional()
})

const demonstratedSchema = z.looseObject({
  title: z.string(),
  extraction: z.enum(["manifest-only", "source"]),
  storyCount: z.number().int().nonnegative(),
  defaultArgs: ownRecordSchema(demonstratedValueSchema).optional(),
  unresolvedDefaultArgs: z.array(z.string()).optional(),
  truncatedDefaultArgs: z.array(z.string()).optional(),
  hasUnresolvedDefaultArgsSpread: z.boolean().optional(),
  controls: ownRecordSchema(controlSchema).optional(),
  stories: z.array(demonstratedStorySchema).optional(),
  truncatedStories: z.boolean().optional(),
  incomplete: z.boolean().optional()
})

const verifyComponentSchema = z.looseObject({
  name: z.string(),
  displayName: z.string().optional(),
  source: z.looseObject({
    adapter: sourceAdapterSchema,
    file: z.string().optional()
  }),
  props: ownRecordSchema(propSchema).optional(),
  demonstrated: demonstratedSchema.optional(),
  uses: ownRecordSchema(positiveRelationshipCountSchema).optional(),
  usage: z
    .looseObject({
      sites: positiveRelationshipCountSchema,
      props: ownRecordSchema(z.array(z.union([propValueSchema, z.null()]))).optional(),
      truncatedProps: z.array(z.string()).optional()
    })
    .optional()
})

const verifySourceStatusSchema = z.looseObject({
  status: z.enum(["ok", "failed", "skipped"]),
  error: z.string().optional()
})

// Reached only by default verification's structural comparison with a fresh build.
export const verifyDefaultContractSchema = z.looseObject({
  tokens: z.record(z.string(), z.record(z.string(), verifyTokenSchema)),
  components: ownRecordSchema(verifyComponentSchema),
  sourceStatuses: ownRecordSchema(verifySourceStatusSchema).optional()
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
  sourceStatuses: ownRecordSchema(verifySourceStatusSchema).optional(),
  violations: z.array(verifyViolationSchema).optional()
})
