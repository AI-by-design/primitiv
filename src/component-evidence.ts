import { z } from "zod"
import type { ComponentContextSection, DiscoveryIndex } from "./discovery/types"

const relationshipCountSchema = z.number().int().positive()
const propValueSchema = z.union([z.string(), z.number().finite(), z.boolean()])
const observedPropValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
export const propDefinitionSchema = z.object({
  type: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  values: z.array(propValueSchema).optional(),
  kind: z.enum(["boolean", "text", "variant", "instance-swap"]).optional(),
  preferredValues: z
    .array(
      z.object({
        type: z.enum(["component", "component-set"]),
        key: z.string().min(1)
      })
    )
    .optional()
})
export const apiFactsSchema = z.looseObject({
  // Parse each own key manually in validateApiFacts: z.record drops an own `__proto__`
  // property, but Figma property names are opaque data and must survive byte-for-byte.
  props: z.unknown().optional()
})
const usageProjectionSchema = z.looseObject({
  sites: relationshipCountSchema,
  props: z.record(z.string(), z.array(observedPropValueSchema)).optional(),
  truncatedProps: z.array(z.string()).optional()
})
export const usageFactsSchema = z.looseObject({ usage: usageProjectionSchema.optional() })
export const relationshipFactsSchema = z.looseObject({
  uses: z.record(z.string(), relationshipCountSchema).optional()
})
export type RelationshipFacts = z.infer<typeof relationshipFactsSchema>
export type ApiFacts = Record<string, z.infer<typeof propDefinitionSchema>>
export type UsageFacts = z.infer<typeof usageProjectionSchema>

const controlEvidenceSchema = z.looseObject({
  control: z.union([z.string(), z.literal(false)]).optional(),
  choices: z
    .array(
      z.looseObject({
        option: z.union([z.string(), z.number(), z.boolean()]),
        mappedValue: z.json().optional(),
        mappingUnresolved: z.boolean().optional()
      })
    )
    .optional(),
  unresolvedChoices: z.boolean().optional(),
  truncatedChoices: z.boolean().optional()
})
const storySchema = z.looseObject({
  id: z.string(),
  name: z.string().optional(),
  exportName: z.string().optional(),
  importPath: z.string().optional(),
  args: z.record(z.string(), z.json()).optional(),
  unresolvedArgs: z.array(z.string()).optional(),
  truncatedArgs: z.array(z.string()).optional(),
  hasUnresolvedArgsSpread: z.boolean().optional(),
  controls: z.record(z.string(), controlEvidenceSchema).optional()
})
const demonstratedFactsSchema = z
  .looseObject({
    title: z.string(),
    extraction: z.enum(["manifest-only", "source"]),
    storyCount: z.number().int().nonnegative(),
    incomplete: z.boolean().optional(),
    defaultArgs: z.record(z.string(), z.json()).optional(),
    unresolvedDefaultArgs: z.array(z.string()).optional(),
    truncatedDefaultArgs: z.array(z.string()).optional(),
    hasUnresolvedDefaultArgsSpread: z.boolean().optional(),
    controls: z.record(z.string(), controlEvidenceSchema).optional(),
    stories: z.array(storySchema).optional(),
    truncatedStories: z.boolean().optional()
  })
  .optional()

/** Optional evidence stays lazy for legacy compatibility; validate selected detail sections before projection. */
const relationshipValidity = new WeakMap<DiscoveryIndex, boolean>()
export function validComponentEvidence(
  index: DiscoveryIndex,
  id: string,
  sections: readonly ComponentContextSection[]
): boolean {
  const components = index.contract.components
  const component = components[id]
  if (sections.includes("api")) {
    if (
      !usageFactsSchema.safeParse(component).success ||
      !demonstratedFactsSchema.safeParse(component.demonstrated).success
    )
      return false
    if (!ownRecordValid(component.usage?.props, z.array(observedPropValueSchema))) return false
    if (!ownRecordValid(component.demonstrated?.controls, controlEvidenceSchema)) return false
    for (const story of component.demonstrated?.stories ?? []) {
      if (!ownRecordValid(story.controls, controlEvidenceSchema)) return false
    }
    const parsed = apiFactsSchema.safeParse(component)
    if (!parsed.success) return false
    if (parsed.data.props !== undefined) {
      if (!parsed.data.props || typeof parsed.data.props !== "object" || Array.isArray(parsed.data.props)) return false
      for (const prop of Object.values(parsed.data.props))
        if (!propDefinitionSchema.safeParse(prop).success) return false
    }
  }
  if (sections.includes("relationships")) {
    let valid = relationshipValidity.get(index)
    if (valid === undefined) {
      valid = Object.values(components).every(
        (record) =>
          relationshipFactsSchema.safeParse(record).success && ownRecordValid(record.uses, relationshipCountSchema)
      )
      relationshipValidity.set(index, valid)
    }
    if (!valid) return false
  }
  return true
}

// z.record can omit a canonical own '__proto__' entry. Inspect own values before
// projecting raw typed records so malformed opaque names cannot bypass validation.
function ownRecordValid(input: unknown, valueSchema: z.ZodType): boolean {
  if (input === undefined) return true
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  return Object.values(input).every((value) => valueSchema.safeParse(value).success)
}
