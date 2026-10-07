import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as YAML from "yaml"
import { buildContract } from "../index"
import type { PrimitivConfig, PrimitivContract, RationaleMap } from "../types"
import { emptyTokenMap } from "../types"
import { attachGuidance, loadGuidance } from "./ingestion"
import { guidanceHealthSchema } from "./schema"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-ingestion-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})
function config(rationale?: PrimitivConfig["rationale"]): PrimitivConfig {
  return {
    sources: { codebase: { root: ".", patterns: ["**/*.tsx"], ignore: [] } },
    governance: { sourceOfTruth: "codebase", onConflict: "warn" },
    output: { path: "contract.json" },
    rationale
  }
}
function contract(): PrimitivContract {
  return {
    version: "test",
    generatedAt: new Date().toISOString(),
    sourceRoot: root,
    configPath: "config.js",
    sources: ["codebase"],
    tokens: emptyTokenMap(),
    components: {
      "ui/Card": { name: "Card", description: "scan description", source: { adapter: "codebase", file: "Card.tsx" } },
      "ui/Button": { name: "Button", source: { adapter: "codebase" } }
    },
    conflicts: [],
    sourceStatuses: { codebase: { status: "ok" }, figma: { status: "skipped" }, storybook: { status: "skipped" } }
  }
}
function ingest(rationale?: PrimitivConfig["rationale"]): PrimitivContract {
  const result = contract()
  attachGuidance(result, loadGuidance(config(rationale), root))
  expect(guidanceHealthSchema.safeParse(result.guidanceHealth).success).toBe(true)
  return result
}
function sidecar(data: unknown) {
  fs.writeFileSync(path.join(root, "primitiv.rationale.yml"), YAML.stringify(data))
}

describe("selected guidance ingestion", () => {
  test("ordinary absence is complete, configured missing and unreadable files are failures", () => {
    expect(ingest().guidanceHealth?.sources[0]).toMatchObject({
      selection: "default",
      readState: "absent",
      complete: true
    })
    expect(ingest({ path: "missing.json" }).guidanceHealth?.sources[0]).toMatchObject({
      selection: "configured",
      readState: "missing",
      complete: false
    })
    fs.mkdirSync(path.join(root, "directory"))
    expect(ingest({ path: "directory" }).guidanceHealth?.sources[0]).toMatchObject({
      readState: "unreadable",
      complete: false
    })
  })
  test("duplicate mapping keys and malformed maps preserve the inventory", () => {
    fs.writeFileSync(path.join(root, "primitiv.rationale.yml"), "components:\n  Card: {}\n  Card: {}\n")
    expect(ingest().guidanceHealth?.byCode["parse-failed"]).toBe(1)
    sidecar({ components: [], tokens: { "colors.primary": { why: "legacy" } } })
    const result = ingest()
    expect(result.components["ui/Card"].rationale).toBeUndefined()
    expect(result.guidanceHealth?.sources[0].complete).toBe(false)
    expect(Object.keys(result.components)).toHaveLength(2)
  })
  test("YAML and explicitly selected ordinary JSON produce equivalent canonical fields", () => {
    const data = {
      components: {
        Card: {
          classification: { atomicLevel: "molecule", intents: ["input", "feedback"] },
          description: "authored",
          why: "legacy",
          avoidWhen: [{ condition: "Use the other control", alternative: { componentId: "ui/Button" } }]
        }
      }
    }
    sidecar(data)
    fs.writeFileSync(path.join(root, "guidance.json"), JSON.stringify(data))
    const yaml = ingest().components["ui/Card"]
    const json = ingest({ path: "guidance.json" }).components["ui/Card"]
    expect(yaml.classification).toEqual(json.classification)
    expect(yaml.rationale).toEqual(json.rationale)
    expect(yaml.description).toBe("scan description")
    expect(yaml.source).toEqual({ adapter: "codebase", file: "Card.tsx" })
  })
  for (const reverse of [false, true])
    test(`exact ID wins and reports aliases independent of insertion order (${reverse})`, () => {
      const entries = [
        ["Card", { why: "alias" }],
        ["ui/Card", { classification: { atomicLevel: "atom" }, why: "exact" }]
      ]
      sidecar({ components: Object.fromEntries(reverse ? entries.reverse() : entries) })
      const result = ingest()
      expect(result.components["ui/Card"].rationale).toEqual({ why: "exact" })
      expect(result.components["ui/Card"].guidanceOrigin?.binding).toBe("id")
      expect(result.guidanceHealth?.byCode["alias-conflict"]).toBe(1)
    })
  test("inline alias beats sidecar ID and an empty inline entry clears every authored field", () => {
    sidecar({ components: { "ui/Card": { why: "sidecar", classification: { atomicLevel: "atom" } } } })
    expect(ingest({ inline: { components: { Card: { when: "inline" } } } }).components["ui/Card"].rationale).toEqual({
      when: "inline"
    })
    const empty = ingest({ inline: { components: { Card: {} } } }).components["ui/Card"]
    expect(empty.rationale).toEqual({})
    expect(empty.classification).toBeUndefined()
    expect(empty.guidanceOrigin?.sourceKind).toBe("inline")
  })
  test("invalid winner is withheld atomically without fallback while independent valid entries survive", () => {
    sidecar({ components: { Card: { why: "sidecar" } } })
    const inline = {
      components: { Card: { why: "invalid", classification: { atomicLevel: "not-an-atom" } }, Button: { why: "valid" } }
    } as unknown as RationaleMap
    const result = ingest({ inline })
    expect(result.components["ui/Card"].rationale).toBeUndefined()
    expect(result.components["ui/Card"].guidanceOrigin).toBeUndefined()
    expect(result.components["ui/Button"].rationale).toEqual({ why: "valid" })
    expect(result.guidanceHealth?.sources[1]).toMatchObject({
      validEntries: 1,
      invalidEntries: 1,
      boundEntries: 1,
      complete: true
    })
  })
  test("invalid lower-priority entry does not erase valid inline winner evidence", () => {
    sidecar({ components: { Card: { classification: { atomicLevel: "invalid" } } } })
    const result = ingest({ inline: { components: { Card: { why: "valid" } } } })
    expect(result.components["ui/Card"].rationale).toEqual({ why: "valid" })
    expect(result.components["ui/Card"].guidanceOrigin?.sourceKind).toBe("inline")
    expect(result.guidanceHealth?.sources[0].invalidEntries).toBe(1)
  })
  test("ambiguous names do not fan out or propagate through mapped implementations", () => {
    const result = contract()
    result.components["figma:card"] = { name: "Card", source: { adapter: "figma" } }
    sidecar({ components: { Card: { why: "ambiguous" }, "ui/Card": { why: "exact" } } })
    attachGuidance(result, loadGuidance(config(), root))
    expect(result.components["figma:card"].rationale).toBeUndefined()
    expect(result.components["ui/Card"].rationale).toEqual({ why: "exact" })
    expect(result.guidanceHealth?.byCode["ambiguous-binding"]).toBe(1)
  })
  test("special own keys bind safely", () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      const result = contract()
      result.components["ui/Special"] = { name, source: { adapter: "codebase" } }
      attachGuidance(result, loadGuidance(config({ inline: { components: { [name]: { why: name } } } }), root))
      expect(result.components["ui/Special"].rationale?.why).toBe(name)
      expect(guidanceHealthSchema.safeParse(result.guidanceHealth).success).toBe(true)
    }
  })
  test("references resolve exact IDs and absent targets remain unknown with failed or missing coverage", () => {
    sidecar({
      components: {
        Card: {
          pairsWith: [
            { description: "available", component: { componentId: "ui/Button" } },
            { description: "missing", component: { componentId: "ui/Moved" } }
          ]
        }
      }
    })
    expect(ingest().guidanceHealth?.byCode["unresolved-reference"]).toBe(1)
    for (const statuses of [
      undefined,
      {
        codebase: { status: "ok" as const },
        figma: { status: "failed" as const },
        storybook: { status: "skipped" as const }
      }
    ]) {
      const result = contract()
      result.sourceStatuses = statuses
      attachGuidance(result, loadGuidance(config(), root))
      expect(result.guidanceHealth?.byCode["incomplete-reference-evidence"]).toBe(1)
      expect(result.guidanceHealth?.sources[0].complete).toBe(false)
      expect(result.components["ui/Card"].rationale?.pairsWith?.[1].component?.componentId).toBe("ui/Moved")
    }
  })
  test("diagnostics retain truthful counts under both item and byte limits", () => {
    const entries = Object.fromEntries(Array.from({ length: 140 }, (_, index) => [`Missing${index}`, {}]))
    sidecar({ components: entries })
    const result = ingest()
    expect(result.guidanceHealth).toMatchObject({ total: 140, truncated: true, byCode: { "unbound-entry": 140 } })
    expect(result.guidanceHealth?.items).toHaveLength(100)
    expect(result.guidanceHealth?.sources[0]).toMatchObject({ validEntries: 140, unboundEntries: 140, boundEntries: 0 })
  })
  test("unsafe and oversized UTF-8 authored keys never produce invalid generated evidence", () => {
    for (const key of ["   ", "😀".repeat(600), "\u202eunsafe"]) {
      const result = ingest({ inline: { components: { [key]: { why: "authored" } } } })
      expect(result.guidanceHealth?.sources[1].invalidEntries).toBe(1)
      expect(result.guidanceHealth?.sources[1].boundEntries).toBe(0)
    }
  })
  test("aggregate diagnostic envelope can truncate before the item cap", () => {
    const result = contract()
    const entries: Record<string, object> = {}
    const longField = "x".repeat(2000)
    for (let index = 0; index < 100; index++) {
      const id = `${index}-${"😀".repeat(490)}`
      result.components[id] = { name: `Special${index}`, source: { adapter: "codebase" } }
      entries[id] = { [longField]: true }
    }
    attachGuidance(result, loadGuidance(config({ inline: { components: entries } }), root))
    expect(result.guidanceHealth?.total).toBe(100)
    expect(result.guidanceHealth?.items.length).toBeLessThan(100)
    expect(result.guidanceHealth?.truncated).toBe(true)
    expect(guidanceHealthSchema.safeParse(result.guidanceHealth).success).toBe(true)
  })
  test("public silent builds serialize durable health while preserving valid scan output", async () => {
    fs.writeFileSync(path.join(root, "Card.tsx"), "export const Card = () => <div />")
    fs.writeFileSync(
      path.join(root, "primitiv.config.js"),
      `module.exports = ${JSON.stringify(config({ path: "missing.json" }))}`
    )
    const result = await buildContract(undefined, { silent: true, cwd: root })
    expect(result.components.Card).toBeDefined()
    expect(JSON.parse(JSON.stringify(result)).guidanceHealth.sources[0].readState).toBe("missing")
  })
})
