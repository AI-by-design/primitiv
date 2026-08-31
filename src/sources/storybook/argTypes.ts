import type { PropDefinition } from "../../types"

/**
 * Parse `argTypes` from a Storybook CSF (Component Story Format) source file.
 * Returns an empty map if the file has no argTypes block, is malformed, or uses
 * a pattern this parser doesn't recognize.
 *
 * Known limitations:
 * - Only the first `argTypes: { ... }` block is parsed. Stories sometimes define
 *   argTypes per-story on top of the meta-level block; those are skipped.
 * - argTypes imported from another module (e.g. `import { argTypes } from "./meta"`)
 *   are not followed.
 * - The type we emit for each prop is derived from Storybook's `control` hint,
 *   which is a usage hint rather than a full TypeScript type.
 */
export function parseArgTypes(source: string): Record<string, PropDefinition> {
  const header = source.match(/argTypes\s*:\s*\{/)
  if (!header) return {}

  const braceOpenIdx = (header.index ?? 0) + header[0].length - 1
  const braceCloseIdx = findMatchingBrace(source, braceOpenIdx)
  if (braceCloseIdx === -1) return {}

  const block = source.slice(braceOpenIdx + 1, braceCloseIdx)
  // Arg names are authored input. A null prototype keeps names such as
  // `__proto__` inert instead of letting them mutate the result object's shape.
  const props = Object.create(null) as Record<string, PropDefinition>

  for (const { name, body } of topLevelEntries(block)) {
    const controlMatch = body.match(/control\s*:\s*["']([\w-]+)["']/)
    const controlShorthand = body.match(/control\s*:\s*\{\s*type\s*:\s*["']([\w-]+)["']/)
    const required = /required\s*:\s*true/.test(body)
    const control = controlMatch?.[1] ?? controlShorthand?.[1] ?? "unknown"
    props[name] = {
      type: controlToType(control),
      required
    }
  }

  return props
}

/**
 * Iterate the top-level `key: { ... }` entries inside a balanced-brace block.
 * Handles strings and nested braces so we don't split on punctuation inside values.
 */
function* topLevelEntries(block: string): IterableIterator<{ name: string; body: string }> {
  const keyRegex = /(\w+)\s*:\s*\{/g
  let cursor = 0
  while (cursor < block.length) {
    keyRegex.lastIndex = cursor
    const match = keyRegex.exec(block)
    if (!match) return
    // Confirm the key sits at the current top level (i.e. not inside a nested object we already skipped).
    if (match.index < cursor) return
    const openIdx = match.index + match[0].length - 1
    const closeIdx = findMatchingBrace(block, openIdx)
    if (closeIdx === -1) return
    yield { name: match[1], body: block.slice(openIdx + 1, closeIdx) }
    cursor = closeIdx + 1
  }
}

function findMatchingBrace(source: string, openIdx: number): number {
  if (source[openIdx] !== "{") return -1
  let depth = 1
  let i = openIdx + 1
  let quote: string | null = null
  while (i < source.length && depth > 0) {
    const ch = source[i]
    if (quote) {
      if (ch === "\\") {
        i += 2
        continue
      }
      if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
    } else if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
    }
    i++
  }
  return depth === 0 ? i - 1 : -1
}

function controlToType(control: string): string {
  switch (control) {
    case "text":
    case "color":
    case "date":
    case "file":
      return "string"
    case "boolean":
    case "check":
      return "boolean"
    case "number":
    case "range":
      return "number"
    case "select":
    case "radio":
    case "multi-select":
    case "inline-radio":
    case "inline-check":
      return "enum"
    case "object":
      return "object"
    default:
      return control || "unknown"
  }
}
