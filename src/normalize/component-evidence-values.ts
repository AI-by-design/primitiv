/** Primitive values captured from component APIs and their static usages. */
export type PrimitiveValue = string | number | boolean | null

/** The fixed bound used when retaining primitive values as evidence. */
export const MAX_PRIMITIVE_VALUES = 20

/** Return a type-preserving key suitable for deduplicating primitive values. */
export function primitiveValueKey(value: PrimitiveValue): string {
  return value === null ? "null" : `${typeof value}:${String(value)}`
}

/**
 * Compare primitive values deterministically: booleans, numbers, strings, then null.
 * Values within a type use their natural ordering.
 */
export function comparePrimitiveValues(a: PrimitiveValue, b: PrimitiveValue): number {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  const rank = (value: string | number | boolean): number =>
    typeof value === "boolean" ? 0 : typeof value === "number" ? 1 : 2
  const aRank = rank(a)
  const bRank = rank(b)
  if (aRank !== bRank) return aRank - bRank
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
  if (typeof a === "number" && typeof b === "number") return a - b
  return a < b ? -1 : a > b ? 1 : 0
}

/** Deduplicate and sort primitive values using the canonical comparator. */
export function sortPrimitiveValues<T extends PrimitiveValue>(values: readonly T[]): T[] {
  const unique = new Map<string, T>()
  for (const value of values) unique.set(primitiveValueKey(value), value)
  return [...unique.values()].sort(comparePrimitiveValues)
}

/**
 * Deduplicate values and retain at most `limit` comparator-smallest values.
 * `truncated` reports whether unique input values exceeded the requested bound.
 */
export function retainSmallestPrimitiveValues<T extends PrimitiveValue>(
  values: readonly T[],
  limit: number = MAX_PRIMITIVE_VALUES
): { values: T[]; truncated: boolean } {
  const sorted = sortPrimitiveValues(values)
  const boundedLimit = Math.max(0, Math.floor(limit))
  return {
    values: sorted.slice(0, boundedLimit),
    truncated: sorted.length > boundedLimit
  }
}
