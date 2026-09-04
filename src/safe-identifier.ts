export const DEFAULT_MAX_IDENTIFIER_CHARS = 4_096
export const MAX_IDENTIFIER_PATH_SEGMENTS = 64

/** Whether a code point is unsafe in an opaque machine identifier or terminal text. */
export function isUnsafeIdentifierCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  )
}

/** Detect control and bidirectional formatting code points without rewriting the value. */
export function hasUnsafeIdentifierCodePoint(value: string): boolean {
  for (const character of value) {
    if (isUnsafeIdentifierCodePoint(character.codePointAt(0) ?? 0)) return true
  }
  return false
}

/**
 * Check the shared safety and length policy for opaque IDs and path segments.
 *
 * This intentionally performs no normalization and places no restrictions on
 * punctuation. Callers that require a non-empty value must enforce that
 * separately as part of their field's structural schema.
 */
export function isSafeIdentifier(value: string, maxChars: number = DEFAULT_MAX_IDENTIFIER_CHARS): boolean {
  if (!Number.isFinite(maxChars) || maxChars < 0) return false
  return value.length <= Math.floor(maxChars) && !hasUnsafeIdentifierCodePoint(value)
}

/** Validate one non-empty opaque ID without changing its bytes or code points. */
export function isSafeNonEmptyIdentifier(value: string, maxChars: number = DEFAULT_MAX_IDENTIFIER_CHARS): boolean {
  return value.length > 0 && isSafeIdentifier(value, maxChars)
}

/** Validate a bounded path whose segments follow the opaque identifier policy. */
export function isSafeIdentifierPath(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_PATH_SEGMENTS &&
    value.every((segment) => typeof segment === "string" && isSafeNonEmptyIdentifier(segment))
  )
}
