import type { PropDefinition } from "../../types"
import { parseStorybookSource } from "./csf"

/**
 * Compatibility entry point for callers that only need declared prop metadata.
 * Structural CSF parsing lives in `csf.ts`; controls are deliberately excluded.
 */
export function parseArgTypes(source: string): Record<string, PropDefinition> {
  try {
    return parseStorybookSource(source).props
  } catch {
    return Object.create(null) as Record<string, PropDefinition>
  }
}
