import { describe, expect, test } from "bun:test"
import { emptyTokenMap, primitivContractSchema } from "./types"
import { verifySharedContractSchema } from "./verify/contract-schema"

function contract(comparisonDiagnostics?: unknown) {
  return {
    version: "0.3.0",
    generatedAt: "2026-09-08T12:00:00.000Z",
    sources: [],
    tokens: emptyTokenMap(),
    components: {},
    conflicts: [],
    ...(comparisonDiagnostics === undefined ? {} : { comparisonDiagnostics })
  }
}

const diagnostic = {
  type: "could-not-compare",
  reason: "ambiguous-identity",
  name: "Button",
  adapters: ["codebase", "figma"],
  componentIds: ["code/Button", "figma:button"]
}

function collection(overrides: Record<string, unknown> = {}) {
  return {
    total: 1,
    truncated: false,
    byReason: { "ambiguous-identity": 1 },
    items: [diagnostic],
    ...overrides
  }
}

describe("comparison diagnostic contract boundaries", () => {
  for (const [name, schema] of [
    ["public", primitivContractSchema],
    ["verify", verifySharedContractSchema]
  ] as const) {
    test(`${name} accepts legacy, empty, and sparse reason counts`, () => {
      expect(schema.safeParse(contract()).success).toBe(true)
      expect(schema.safeParse(contract(collection())).success).toBe(true)
      expect(schema.safeParse(contract(collection({ total: 0, byReason: {}, items: [] }))).success).toBe(true)
      expect(
        schema.safeParse(contract(collection({ total: 124, truncated: true, byReason: { "ambiguous-identity": 124 } })))
          .success
      ).toBe(true)
    })

    test(`${name} rejects inconsistent counts and truncation`, () => {
      for (const invalid of [
        collection({ total: 2 }),
        collection({ truncated: true }),
        collection({ byReason: { "unsupported-type-vocabulary": 1 } }),
        collection({ total: -1 }),
        collection({ byReason: { "ambiguous-identity": 0 } })
      ]) {
        expect(schema.safeParse(contract(invalid)).success).toBe(false)
      }
    })

    test(`${name} rejects raw values, invalid identifiers, duplicate participants, and oversized item lists`, () => {
      for (const item of [
        { ...diagnostic, value: "remote source text" },
        { ...diagnostic, componentIds: ["code/Button\n"] },
        { ...diagnostic, fieldPath: ["props", "size\u202e", "type"] },
        { ...diagnostic, fieldPath: [] },
        { ...diagnostic, adapters: ["figma", "figma"] },
        { ...diagnostic, componentIds: ["code/Button", "code/Button"] }
      ]) {
        expect(schema.safeParse(contract(collection({ items: [item] }))).success).toBe(false)
      }
      expect(
        schema.safeParse(
          contract(
            collection({
              total: 101,
              byReason: { "ambiguous-identity": 101 },
              items: Array.from({ length: 101 }, (_, index) => ({ ...diagnostic, componentIds: [`code/${index}`] }))
            })
          )
        ).success
      ).toBe(false)
    })

    test(`${name} rejects equivalent duplicate diagnostics despite participant order`, () => {
      expect(
        schema.safeParse(
          contract(
            collection({
              total: 2,
              byReason: { "ambiguous-identity": 2 },
              items: [
                diagnostic,
                {
                  ...diagnostic,
                  adapters: [...diagnostic.adapters].reverse(),
                  componentIds: [...diagnostic.componentIds].reverse()
                }
              ]
            })
          )
        ).success
      ).toBe(false)
    })
  }
})
