import { z } from "zod"
import {
  componentClassificationSchema,
  componentRationaleSchema,
  guidanceHealthSchema,
  guidanceOriginSchema,
  rationaleSchema
} from "../rationale/schema"
import type { PrimitivContract } from "../types"
import { primitivContractSchema, summarizeValidationIssues } from "../types"

const sourceSchema = z.looseObject({
  adapter: z.enum(["codebase", "figma", "storybook"]),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional()
})
const componentSchema = z.looseObject({
  name: z.string().min(1),
  displayName: z.string().min(1).optional(),
  kind: z.enum(["component", "screen", "provider", "icon", "other"]).optional(),
  scope: z.string().optional(),
  description: z.string().optional(),
  source: sourceSchema,
  classification: componentClassificationSchema.optional(),
  rationale: componentRationaleSchema.optional(),
  guidanceOrigin: guidanceOriginSchema.optional()
})
const tokenSchema = z.looseObject({
  name: z.string(),
  value: z.string(),
  source: sourceSchema,
  rationale: rationaleSchema.optional(),
  modes: z.record(z.string(), z.string()).optional(),
  modeSources: z.record(z.string(), sourceSchema).optional()
})
const sourceStatusSchema = z.looseObject({
  status: z.enum(["ok", "failed", "skipped"]),
  tokens: z.number().int().nonnegative().optional(),
  components: z.number().int().nonnegative().optional(),
  error: z.string().optional()
})
const healthSchema = z.looseObject({
  sourceRoot: z.string().optional(),
  configPath: z.string().optional(),
  sourceStatuses: z.record(z.string(), sourceStatusSchema).optional(),
  guidanceHealth: guidanceHealthSchema.optional()
})

/** Validate eager lookup facts; optional legacy API/usage/conflict evidence is validated on projection. */
export function importDiscoveryContract(input: unknown): PrimitivContract {
  validate(primitivContractSchema, input)
  validate(healthSchema, input)
  const contract = input as PrimitivContract
  for (const status of Object.values(contract.sourceStatuses ?? {})) validate(sourceStatusSchema, status)
  for (const component of Object.values(contract.components)) validate(componentSchema, component)
  for (const category of Object.values(contract.tokens)) {
    validate(z.record(z.string(), z.unknown()), category)
    for (const token of Object.values(category)) {
      validate(tokenSchema, token)
      // Inspect every own typed value: z.record may omit an opaque '__proto__' key.
      for (const mode of Object.values(token.modes ?? {})) validate(z.string(), mode)
      for (const source of Object.values(token.modeSources ?? {})) validate(sourceSchema, source)
    }
  }
  // Imported indexes are derived caches, never lookup authority. Rebuild from canonical own records.
  const componentNameIndex: Record<string, string[]> = Object.create(null)
  for (const id of Object.keys(contract.components).sort()) {
    const component = contract.components[id]
    const name = component.displayName ?? component.name
    componentNameIndex[name] ??= []
    componentNameIndex[name].push(id)
  }
  return { ...contract, componentNameIndex }
}

function validate(schema: z.ZodType, input: unknown): void {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new Error(`Invalid contract: ${summarizeValidationIssues(parsed.error)}`)
}
