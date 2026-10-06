import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { parse } from "yaml"
import { primitivContractSchema } from "../types"
import {
  componentAnnotationSchema,
  componentReferenceSchema,
  GUIDANCE_LIMITS,
  guidanceHealthSchema,
  guidanceOriginSchema,
  guidanceSourceStateSchema,
  rationaleSchema,
  validateComponentAnnotation,
  validateRationaleMap
} from "./schema"

const source = {
  sourceId: "sidecar",
  selection: "default",
  readState: "ok",
  validEntries: 1,
  invalidEntries: 0,
  boundEntries: 1,
  unboundEntries: 0,
  complete: true
}
const diagnostic = {
  code: "invalid-field",
  severity: "error",
  sourceId: "sidecar",
  authoredKey: "components/ui/SearchField",
  fieldPath: ["classification", "atomicLevel"],
  message: "Invalid classification."
}
const health = {
  schemaVersion: 1,
  sources: [source],
  total: 1,
  byCode: { "invalid-field": 1 },
  items: [diagnostic],
  truncated: false
}

describe("authored guidance schema", () => {
  test("original JSON and YAML examples produce identical annotations with partial adoption", () => {
    const json = JSON.parse(readFileSync("examples/guidance/rationale.json", "utf8"))
    const yaml = parse(readFileSync("examples/guidance/rationale.yml", "utf8"))
    expect(validateRationaleMap(json)).toEqual(validateRationaleMap(yaml))
    const result = validateRationaleMap(json)
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.components?.["components/providers/SearchProvider"]).toEqual({})
  })
  test("preserves legacy empty prose and unbounded legacy fields", () => {
    const legacy = { why: "", when: "", alternatives: [""], examples: ["a".repeat(100000)], tags: [""] }
    expect(rationaleSchema.parse(legacy)).toEqual(legacy)
    expect(componentAnnotationSchema.parse(legacy)).toEqual(legacy)
    expect(componentAnnotationSchema.parse({})).toEqual({})
  })
  test("normalizes only intent sets; warns about all nested unknown authored fields", () => {
    const result = validateComponentAnnotation({
      classification: { atomicLevel: "atom", intents: ["navigation", "input", "input"], typo: true },
      pairsWith: [
        { description: "  Keep this prose.  ", component: { componentId: "storybook:Feedback/Count", typo: 2 } }
      ],
      typo: 1,
      examples: ["second", "first"]
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.classification?.intents).toEqual(["input", "navigation"])
    expect(result.data.examples).toEqual(["second", "first"])
    expect(result.data.pairsWith?.[0].description).toBe("  Keep this prose.  ")
    expect(result.warnings.map((notice) => notice.fieldPath)).toEqual([
      ["classification", "intents"],
      ["classification", "typo"],
      ["pairsWith", 0, "component", "typo"],
      ["typo"]
    ])
  })
  test("map warnings include authored scope and token unknown fields never activate", () => {
    const result = validateRationaleMap({
      components: { A: { classification: { atomicLevel: "atom", typo: 1 } } },
      tokens: { "colors.focus": { why: "ok", description: "unknown" } },
      typo: 1
    })
    expect(result.success).toBe(true)
    expect(result.warnings.map((warning) => warning.fieldPath)).toEqual([
      ["components", "A", "classification", "typo"],
      ["tokens", "colors.focus", "description"],
      ["typo"]
    ])
    if (result.success) expect(result.data.tokens?.["colors.focus"]).toEqual({ why: "ok" })
  })
  test("special own dictionary keys survive both parsers without prototype pollution", () => {
    const json = JSON.parse('{"components":{"__proto__":{"when":"use"},"constructor":{},"toString":{}}}')
    const yaml = parse("components:\n  __proto__:\n    when: use\n  constructor: {}\n  toString: {}\n")
    for (const input of [json, yaml]) {
      const result = validateRationaleMap(input)
      expect(result.success).toBe(true)
      if (result.success) {
        expect(Object.keys(result.data.components ?? {})).toEqual(["__proto__", "constructor", "toString"])
        expect(result.data.components?.__proto__).toEqual({ when: "use" })
        expect(Object.getPrototypeOf(result.data.components)).toBe(null)
      }
    }
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })
  test.each([
    [null, []],
    [{ classification: { atomicLevel: "widget" } }, ["classification", "atomicLevel"]],
    [{ classification: { intents: ["action"] } }, ["classification", "intents", 0]],
    [{ description: "  " }, ["description"]],
    [{ avoidWhen: [{ condition: "" }] }, ["avoidWhen", 0, "condition"]],
    [{ pairsWith: [{ description: null }] }, ["pairsWith", 0, "description"]]
  ])("invalid new values report exact paths", (input, path) => {
    const result = validateComponentAnnotation(input)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.issues[0].fieldPath).toEqual(path)
  })
  test("UTF-8 prose/reference bounds and aggregate escaping bounds reject rather than truncate", () => {
    expect(componentAnnotationSchema.safeParse({ description: "😀".repeat(2048) }).success).toBe(true)
    expect(componentAnnotationSchema.safeParse({ description: "😀".repeat(2049) }).success).toBe(false)
    const oversize = validateComponentAnnotation({ description: "😀".repeat(2049) })
    if (!oversize.success) expect(oversize.issues[0].code).toBe("size-limit")
    const oversizeMap = validateRationaleMap({ components: { A: { description: "😀".repeat(2049) } } })
    if (!oversizeMap.success) expect(oversizeMap.issues[0].code).toBe("size-limit")
    expect(componentReferenceSchema.safeParse({ componentId: "x".repeat(2048) }).success).toBe(true)
    expect(componentReferenceSchema.safeParse({ componentId: "é".repeat(1025) }).success).toBe(false)
    const entry = { condition: '"'.repeat(8192) }
    expect(componentAnnotationSchema.safeParse({ avoidWhen: Array(4).fill(entry) }).success).toBe(false)
    expect(componentAnnotationSchema.safeParse({ pairsWith: Array(33).fill({ description: "ok" }) }).success).toBe(
      false
    )
    expect(componentReferenceSchema.safeParse({ componentId: "storybook:Absent/Target" }).success).toBe(true)
    expect(componentReferenceSchema.safeParse({ componentId: "components/\nSecret" }).success).toBe(false)
  })
})

describe("generated guidance evidence schema", () => {
  test("portable origin names binding without claiming target existence", () => {
    const origin = {
      sourceId: "inline",
      sourceKind: "inline",
      locator: "primitiv.config.js",
      authoredKey: "SearchField",
      binding: "unique-name"
    }
    expect(guidanceOriginSchema.parse(origin)).toEqual(origin)
    for (const locator of [
      "/tmp/private.yml",
      "../private.yml",
      "C:\\private.yml",
      "external:/tmp/private.yml",
      "file\n.yml"
    ]) {
      expect(guidanceOriginSchema.safeParse({ ...origin, locator }).success).toBe(false)
    }
    expect(guidanceOriginSchema.safeParse({ ...origin, locator: "external:reviewed-guidance" }).success).toBe(true)
  })
  test("health totals and per-code retained counts remain truthful under truncation", () => {
    expect(guidanceHealthSchema.safeParse(health).success).toBe(true)
    expect(guidanceHealthSchema.safeParse({ ...health, items: [], truncated: true }).success).toBe(true)
    for (const change of [
      { total: 2 },
      { truncated: true },
      { byCode: { "unknown-field": 1 } },
      { sources: [source, source] }
    ]) {
      expect(guidanceHealthSchema.safeParse({ ...health, ...change }).success).toBe(false)
    }
    expect(
      guidanceHealthSchema.safeParse({
        ...health,
        total: 101,
        byCode: { "invalid-field": 101 },
        items: Array(100).fill(diagnostic),
        truncated: true
      }).success
    ).toBe(true)
    expect(
      guidanceHealthSchema.safeParse({
        ...health,
        total: 101,
        byCode: { "invalid-field": 101 },
        items: Array(101).fill(diagnostic)
      }).success
    ).toBe(false)
  })
  test("coverage completeness is separate from invalid entries and retained diagnostic completeness", () => {
    expect(guidanceSourceStateSchema.safeParse({ ...source, invalidEntries: 1 }).success).toBe(true)
    expect(guidanceSourceStateSchema.safeParse({ ...source, boundEntries: 0 }).success).toBe(false)
    expect(guidanceSourceStateSchema.safeParse({ ...source, boundEntries: 0, complete: false }).success).toBe(true)
    expect(guidanceSourceStateSchema.safeParse({ ...source, readState: "unreadable" }).success).toBe(false)
    expect(guidanceSourceStateSchema.safeParse({ ...source, readState: "missing", complete: false }).success).toBe(
      false
    )
    expect(validateRationaleMap({ components: new Date() }).success).toBe(false)
    expect(
      guidanceSourceStateSchema.safeParse({ ...source, readState: "absent", validEntries: 0, boundEntries: 0 }).success
    ).toBe(true)
    expect(
      guidanceSourceStateSchema.safeParse({ ...source, selection: "configured", readState: "absent" }).success
    ).toBe(false)
    const bounded = guidanceHealthSchema.parse({ ...health, items: [], truncated: true })
    expect(bounded.total).toBe(1)
    expect(bounded.sources[0].complete).toBe(true)
    // No retained item proves which winner failed; consumers must keep that scope unknown.
    expect(bounded.truncated).toBe(true)
  })
  test("aggregate health byte bound includes escaped messages and field paths", () => {
    const huge = { ...diagnostic, message: '"'.repeat(512), fieldPath: Array(32).fill("é".repeat(1024)) }
    expect(
      guidanceHealthSchema.safeParse({
        ...health,
        total: 4,
        byCode: { "invalid-field": 4 },
        items: Array(4).fill(huge)
      }).success
    ).toBe(false)
    expect(
      Buffer.byteLength(
        JSON.stringify({
          ...health,
          total: 100,
          byCode: { "invalid-field": 100 },
          items: Array(100).fill({ ...diagnostic, message: '"'.repeat(512) })
        }),
        "utf8"
      )
    ).toBeLessThan(GUIDANCE_LIMITS.healthBytes)
  })
  test("legacy outer contracts preserve opaque extension data and have unknown health", () => {
    const old = {
      version: "2.19.1",
      generatedAt: "now",
      sources: [],
      tokens: {},
      components: { A: { future: { value: true } } },
      conflicts: []
    }
    expect(primitivContractSchema.parse(old)).toEqual(old)
    expect(primitivContractSchema.parse(old).guidanceHealth).toBeUndefined()
    expect(primitivContractSchema.parse({ ...old, guidanceHealth: { future: true } }).guidanceHealth).toEqual({
      future: true
    })
  })
})
