import { isUnsafeIdentifierCodePoint } from "./safe-identifier"
import type { ConflictStructuredValue } from "./types"

const DEFAULT_DISPLAY_CHARS = 256

/** Render untrusted text without terminal control sequences or unbounded lines. */
export function safeDisplayText(value: string, maxChars: number = DEFAULT_DISPLAY_CHARS): string {
  const limit = Math.max(1, Math.floor(maxChars))
  let out = ""
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    const rendered = isUnsafeIdentifierCodePoint(codePoint)
      ? `\\u{${codePoint.toString(16).padStart(4, "0")}}`
      : character
    if (out.length + rendered.length > limit) return `${out.slice(0, Math.max(0, limit - 1))}…`
    out += rendered
  }
  return out
}

/** Canonical, type-preserving JSON text for bounded component evidence. */
export function structuredValueText(value: ConflictStructuredValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value)
  if (typeof value === "string") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(structuredValueText).join(",")}]`
  return `{${Object.keys(value)
    .sort(compareStrings)
    .map((key) => `${JSON.stringify(key)}:${structuredValueText(value[key])}`)
    .join(",")}}`
}

export function safeDisplayValue(value: ConflictStructuredValue, maxChars?: number): string {
  return safeDisplayText(structuredValueText(value), maxChars)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
