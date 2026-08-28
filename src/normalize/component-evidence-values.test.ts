import { describe, expect, test } from "bun:test"
import {
  comparePrimitiveValues,
  MAX_PRIMITIVE_VALUES,
  primitiveValueKey,
  retainSmallestPrimitiveValues,
  sortPrimitiveValues
} from "./component-evidence-values"

describe("primitive value ordering and capping", () => {
  test("orders booleans, numbers, strings, and null deterministically", () => {
    expect([null, "z", 2, false, "a", -1, true].sort(comparePrimitiveValues)).toEqual([
      false,
      true,
      -1,
      2,
      "a",
      "z",
      null
    ])
  })

  test("deduplicates mixed types without prototype-key collisions", () => {
    const values = ["__proto__", "constructor", "toString", 1, "1", 1, "__proto__"] as const
    expect(sortPrimitiveValues(values)).toEqual([1, "1", "__proto__", "constructor", "toString"])
    expect(primitiveValueKey("__proto__")).toBe("string:__proto__")
    expect(primitiveValueKey(null)).toBe("null")
  })

  test(`retains the ${MAX_PRIMITIVE_VALUES} comparator-smallest values`, () => {
    const values = [
      null,
      "z",
      true,
      ...Array.from({ length: MAX_PRIMITIVE_VALUES + 1 }, (_, index) => MAX_PRIMITIVE_VALUES - index),
      false
    ]
    const result = retainSmallestPrimitiveValues(values)

    expect(result.truncated).toBe(true)
    expect(result.values).toEqual([false, true, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
  })
})
