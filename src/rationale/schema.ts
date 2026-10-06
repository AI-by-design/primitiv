import { Buffer } from "node:buffer"
import { z } from "zod"
import { isSafeNonEmptyIdentifier } from "../safe-identifier"
import type { ComponentAnnotation, GuidanceValidationResult, RationaleMap } from "../types"

export const GUIDANCE_LIMITS = {
  proseBytes: 8192,
  referenceBytes: 2048,
  entries: 32,
  annotationBytes: 65536,
  diagnostics: 100,
  messageBytes: 512,
  fieldPathSegments: 32,
  healthBytes: 262144
} as const

export const atomicLevelSchema = z.enum(["atom", "molecule", "organism", "template", "page"])
export const componentIntentSchema = z.enum(["navigation", "input", "feedback", "content-display", "call-to-action"])
const proseSchema = boundedText(GUIDANCE_LIMITS.proseBytes)
const identifierSchema = boundedText(GUIDANCE_LIMITS.referenceBytes).refine(
  (value) => isSafeNonEmptyIdentifier(value, GUIDANCE_LIMITS.referenceBytes),
  "must not contain control or bidirectional formatting code points"
)
export const componentClassificationSchema = z.object({
  atomicLevel: atomicLevelSchema.optional(),
  intents: z
    .array(componentIntentSchema)
    .transform((values) => [...new Set(values)].sort())
    .optional()
})
export const componentReferenceSchema = z.object({ componentId: identifierSchema })
export const avoidanceGuidanceSchema = z.object({
  condition: proseSchema,
  alternative: componentReferenceSchema.optional()
})
export const pairingGuidanceSchema = z.object({
  description: proseSchema,
  component: componentReferenceSchema.optional()
})
// Legacy prose is intentionally unbounded and may be empty.
export const rationaleSchema = z.object({
  why: z.string().optional(),
  when: z.string().optional(),
  deprecated: z.boolean().optional(),
  alternatives: z.array(z.string()).optional(),
  examples: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional()
})
export const componentRationaleSchema = rationaleSchema.extend({
  description: proseSchema.optional(),
  avoidWhen: z.array(avoidanceGuidanceSchema).max(GUIDANCE_LIMITS.entries).optional(),
  pairsWith: z.array(pairingGuidanceSchema).max(GUIDANCE_LIMITS.entries).optional()
})
export const componentAnnotationSchema = componentRationaleSchema
  .extend({ classification: componentClassificationSchema.optional() })
  .superRefine((value, ctx) => {
    const { description, avoidWhen, pairsWith, classification } = value
    if (jsonBytes({ description, avoidWhen, pairsWith, classification }) > GUIDANCE_LIMITS.annotationBytes) {
      ctx.addIssue({ code: "custom", message: "new annotation data exceeds UTF-8 byte budget" })
    }
  })
export const rationaleMapSchema = z.object({
  tokens: authoredRecord(rationaleSchema).optional(),
  components: authoredRecord(componentAnnotationSchema).optional()
})

export const guidanceDiagnosticCodeSchema = z.enum([
  "read-failed",
  "parse-failed",
  "invalid-field",
  "unknown-field",
  "duplicate-intent",
  "alias-conflict",
  "ambiguous-binding",
  "unbound-entry",
  "unresolved-reference",
  "incomplete-reference-evidence",
  "size-limit"
])
export const guidanceOriginSchema = z.object({
  sourceId: identifierSchema,
  sourceKind: z.enum(["sidecar", "inline"]),
  locator: identifierSchema.refine(isPortableLocator, "must be project-relative or an external: logical locator"),
  authoredKey: identifierSchema,
  binding: z.enum(["id", "unique-name"])
})
const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const guidanceSourceStateSchema = z
  .object({
    sourceId: identifierSchema,
    selection: z.enum(["default", "configured", "inline"]),
    readState: z.enum(["absent", "ok", "missing", "unreadable", "invalid"]),
    validEntries: countSchema,
    invalidEntries: countSchema,
    boundEntries: countSchema,
    unboundEntries: countSchema,
    complete: z.boolean()
  })
  .superRefine((value, ctx) => {
    if (
      value.boundEntries + value.unboundEntries > value.validEntries ||
      (value.complete && value.boundEntries + value.unboundEntries !== value.validEntries)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["complete"],
        message: "binding counts must cover valid entries when complete"
      })
    }
    if (value.readState === "absent" && value.selection !== "default") {
      ctx.addIssue({ code: "custom", path: ["readState"], message: "only a default source may be absent" })
    }
    if (!["ok", "absent"].includes(value.readState) && value.complete) {
      ctx.addIssue({ code: "custom", path: ["complete"], message: "failed reads cannot provide complete evidence" })
    }
    if (
      ["absent", "missing", "unreadable"].includes(value.readState) &&
      value.validEntries + value.invalidEntries !== 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["validEntries"],
        message: "an absent or unread source cannot contain entries"
      })
    }
  })
export const guidanceDiagnosticSchema = z.object({
  code: guidanceDiagnosticCodeSchema,
  severity: z.enum(["warning", "error"]),
  sourceId: identifierSchema,
  authoredKey: identifierSchema.optional(),
  componentId: identifierSchema.optional(),
  targetId: identifierSchema.optional(),
  fieldPath: z.array(z.union([identifierSchema, countSchema])).max(GUIDANCE_LIMITS.fieldPathSegments),
  message: boundedText(GUIDANCE_LIMITS.messageBytes)
})
export const guidanceHealthSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(guidanceSourceStateSchema),
    total: countSchema,
    byCode: z.partialRecord(guidanceDiagnosticCodeSchema, countSchema),
    items: z.array(guidanceDiagnosticSchema).max(GUIDANCE_LIMITS.diagnostics),
    truncated: z.boolean()
  })
  .superRefine((value, ctx) => {
    const sum = Object.values(value.byCode).reduce((total, count) => total + count, 0)
    if (!Number.isSafeInteger(sum) || sum !== value.total)
      ctx.addIssue({ code: "custom", path: ["byCode"], message: "counts must sum to total" })
    if (value.items.length > value.total || value.truncated !== value.items.length < value.total) {
      ctx.addIssue({ code: "custom", path: ["truncated"], message: "must describe omitted diagnostics truthfully" })
    }
    const retained = new Map<string, number>()
    for (const item of value.items) retained.set(item.code, (retained.get(item.code) ?? 0) + 1)
    for (const [code, count] of retained) {
      if (count > (value.byCode[code as z.infer<typeof guidanceDiagnosticCodeSchema>] ?? 0)) {
        ctx.addIssue({ code: "custom", path: ["byCode", code], message: "count cannot be less than retained items" })
      }
    }
    const ids = value.sources.map((source) => source.sourceId)
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["sources"], message: "source IDs must be unique" })
    for (const [index, item] of value.items.entries()) {
      if (!ids.includes(item.sourceId))
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "sourceId"],
          message: "diagnostic source must be present"
        })
    }
    if (jsonBytes(value) > GUIDANCE_LIMITS.healthBytes)
      ctx.addIssue({ code: "custom", message: "health exceeds UTF-8 envelope budget" })
  })

/** Validate authored input, retaining known fields and surfacing unknown keys and normalization. */
export function validateComponentAnnotation(input: unknown): GuidanceValidationResult<ComponentAnnotation> {
  const warnings: GuidanceValidationResult<ComponentAnnotation>["warnings"] = []
  inspectObject({ input, path: [], warnings })
  const result = componentAnnotationSchema.safeParse(input)
  return result.success
    ? { success: true, data: result.data, warnings }
    : {
        success: false,
        issues: result.error.issues.map((issue) => ({
          code:
            issue.code === "too_big" || issue.message.includes("budget") || issue.message.includes("UTF-8 bytes")
              ? "size-limit"
              : "invalid-field",
          fieldPath: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
          message: issue.message
        })),
        warnings
      }
}

/** Whole authored map validation; dictionaries retain special own keys safely. */
export function validateRationaleMap(input: unknown): GuidanceValidationResult<RationaleMap> {
  const warnings: GuidanceValidationResult<RationaleMap>["warnings"] = []
  if (input && typeof input === "object" && !Array.isArray(input)) {
    for (const [key, entries] of Object.entries(input)) {
      if (key !== "tokens" && key !== "components") {
        warnings.push({ code: "unknown-field", fieldPath: [key], message: "unknown authored field" })
      } else if (entries && typeof entries === "object" && !Array.isArray(entries)) {
        for (const [name, entry] of Object.entries(entries)) {
          const notices = key === "components" ? validateComponentAnnotation(entry).warnings : legacyWarnings(entry)
          warnings.push(...notices.map((notice) => ({ ...notice, fieldPath: [key, name, ...notice.fieldPath] })))
        }
      }
    }
  }
  const result = rationaleMapSchema.safeParse(input)
  return result.success
    ? { success: true, data: result.data, warnings }
    : {
        success: false,
        warnings,
        issues: result.error.issues.map((issue) => ({
          code:
            issue.code === "too_big" || issue.message.includes("budget") || issue.message.includes("UTF-8 bytes")
              ? "size-limit"
              : "invalid-field",
          fieldPath: issue.path.map((part) => (typeof part === "number" ? part : String(part))),
          message: issue.message
        }))
      }
}

function authoredRecord<T>(schema: z.ZodType<T>) {
  return z.unknown().transform((input, ctx): Record<string, T> => {
    const output: Record<string, T> = Object.create(null)
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      (Object.getPrototypeOf(input) !== null && Object.getPrototypeOf(input) !== Object.prototype)
    ) {
      ctx.addIssue({ code: "custom", message: "must be an authored dictionary" })
      return output
    }
    for (const [key, entry] of Object.entries(input)) {
      const result = schema.safeParse(entry)
      if (result.success) output[key] = result.data
      else for (const issue of result.error.issues) ctx.addIssue({ ...issue, path: [key, ...issue.path] })
    }
    return output
  })
}
function legacyWarnings(input: unknown): GuidanceValidationResult<RationaleMap>["warnings"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return []
  const known = ["why", "when", "deprecated", "alternatives", "examples", "tags"]
  return Object.keys(input)
    .filter((key) => !known.includes(key))
    .map((key) => ({
      code: "unknown-field",
      fieldPath: [key],
      message: "unknown authored field"
    }))
}

function boundedText(bytes: number) {
  return z
    .string()
    .refine((value) => value.trim().length > 0, "must be nonblank")
    .refine((value) => Buffer.byteLength(value, "utf8") <= bytes, `must be at most ${bytes} UTF-8 bytes`)
}
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}
function isPortableLocator(value: string): boolean {
  if (value.startsWith("external:")) return /^[a-zA-Z0-9._-]+$/.test(value.slice(9))
  return (
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/^[a-zA-Z]:/.test(value) &&
    value.split("/").every((part) => part !== ".." && part !== "." && part.length > 0)
  )
}
function inspectObject(opts: {
  input: unknown
  path: (string | number)[]
  warnings: GuidanceValidationResult<ComponentAnnotation>["warnings"]
}): void {
  const { input, path, warnings } = opts
  if (!input || typeof input !== "object" || Array.isArray(input)) return
  const shapes: Record<string, readonly string[]> = {
    "": [
      "why",
      "when",
      "deprecated",
      "alternatives",
      "examples",
      "tags",
      "description",
      "avoidWhen",
      "pairsWith",
      "classification"
    ],
    classification: ["atomicLevel", "intents"],
    avoidWhen: ["condition", "alternative"],
    pairsWith: ["description", "component"],
    reference: ["componentId"]
  }
  const label =
    path.length === 0 ? "" : path.includes("alternative") || path.includes("component") ? "reference" : String(path[0])
  const known = shapes[label] ?? []
  for (const [key, value] of Object.entries(input)) {
    const fieldPath = [...path, key]
    if (!known.includes(key)) warnings.push({ code: "unknown-field", fieldPath, message: "unknown authored field" })
    else if (key === "intents" && Array.isArray(value) && new Set(value).size < value.length) {
      warnings.push({ code: "duplicate-intent", fieldPath, message: "duplicate intents normalized as a sorted set" })
    } else if (Array.isArray(value) && (key === "avoidWhen" || key === "pairsWith")) {
      for (const [index, entry] of value.entries())
        inspectObject({ ...opts, input: entry, path: [...fieldPath, index] })
    } else if (["classification", "alternative", "component"].includes(key)) {
      inspectObject({ ...opts, input: value, path: fieldPath })
    }
  }
}
