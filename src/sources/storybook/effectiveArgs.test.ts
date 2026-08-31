import { describe, expect, test } from "bun:test"
import { deriveEffectiveStoryArgs } from "./effectiveArgs"

describe("deriveEffectiveStoryArgs", () => {
  test("inherits meta values and lets final story evidence win", () => {
    expect(
      deriveEffectiveStoryArgs(
        { args: { label: "Meta", size: "md" }, unresolvedArgs: ["tone"] },
        { args: { label: "Story", tone: null }, unresolvedArgs: ["size"] }
      )
    ).toEqual({
      args: { label: "Story", tone: null },
      unresolvedArgs: ["size"]
    })
  })

  test("an unresolved story spread suppresses inheritance but keeps proven later properties", () => {
    expect(
      deriveEffectiveStoryArgs(
        { args: { inherited: true }, truncatedArgs: ["large"] },
        { args: { explicitAfterSpread: 1 }, hasUnresolvedArgsSpread: true }
      )
    ).toEqual({
      args: { explicitAfterSpread: 1 },
      hasUnresolvedArgsSpread: true
    })
  })
})
