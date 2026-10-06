import { componentAnnotationSchema, validateComponentAnnotation } from "@ai-by-design/primitiv"
import type { AtomicLevel, ComponentAnnotation, GuidanceValidationResult } from "@ai-by-design/primitiv"

const atomicLevel: AtomicLevel = "molecule"
const annotation: ComponentAnnotation = {
  classification: { atomicLevel, intents: ["input"] },
  description: "Search"
}
const result: GuidanceValidationResult<ComponentAnnotation> = validateComponentAnnotation(annotation)
componentAnnotationSchema.parse(annotation)
void result

// @ts-expect-error Invalid public values must remain rejected under strict checking.
const invalidAtomicLevel: AtomicLevel = "unknown"
void invalidAtomicLevel
