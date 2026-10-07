import { describe, expect, test } from "bun:test"
import type { PrimitivContract } from "../types"
import { emptyTokenMap } from "../types"
import { importDiscoveryContract } from "./import"
import { createDiscoveryIndex, DISCOVERY_LIMITS, discoveryEnvelopeBytes, getComponentContext } from "./index"

function fixture(): PrimitivContract {
  return {
    version: "0.3.0",
    generatedAt: "2026-10-07T00:00:00Z",
    sources: ["codebase"],
    sourceRoot: "/project",
    configPath: "/project/primitiv.config.js",
    tokens: emptyTokenMap(),
    components: { Button: { name: "Button", source: { adapter: "codebase" } } },
    conflicts: []
  }
}
describe("discovery contract import", () => {
  test("opaque own prototype-like evidence keys cannot bypass optional detail validation", () => {
    const malformed = JSON.parse('{"__proto__":"bad"}')
    for (const evidence of [
      { uses: malformed },
      { usage: { sites: 1, props: malformed } },
      { demonstrated: { title: "Button", extraction: "source", storyCount: 1, controls: malformed } },
      {
        demonstrated: {
          title: "Button",
          extraction: "source",
          storyCount: 1,
          stories: [{ id: "button", controls: malformed }]
        }
      }
    ]) {
      const contract = fixture()
      Object.assign(contract.components.Button, evidence)
      const index = createDiscoveryIndex(importDiscoveryContract(contract))
      expect(
        getComponentContext(index, { id: "Button", snapshotId: index.snapshotId }).structuredContent
      ).toMatchObject({ error: { code: "invalid-record" } })
    }
    const contract = fixture()
    contract.components.Button.uses = JSON.parse('{"__proto__":2}')
    const index = createDiscoveryIndex(importDiscoveryContract(contract))
    const result = getComponentContext(index, {
      id: "Button",
      snapshotId: index.snapshotId,
      sections: ["relationships"]
    })
    expect(result.isError).toBeUndefined()
    expect(JSON.stringify(result.structuredContent)).toContain('"__proto__":2')
  })
  test("public importer, index and detail reject selected malformed optional evidence with bounded errors", () => {
    for (const evidence of [
      { props: { label: { required: "sometimes" } } },
      { usage: { sites: 0 } },
      { demonstrated: { stories: "bad" } },
      { uses: { Button: 0 } }
    ]) {
      const contract = fixture()
      Object.assign(contract.components.Button, evidence)
      const index = createDiscoveryIndex(importDiscoveryContract(contract))
      const guidance = getComponentContext(index, {
        id: "Button",
        snapshotId: index.snapshotId,
        sections: ["guidance"]
      })
      expect(guidance.isError).toBeUndefined()
      const result = getComponentContext(index, {
        id: "Button",
        snapshotId: index.snapshotId,
        sections: ["api", "relationships"]
      })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({
        snapshotId: index.snapshotId,
        error: { code: "invalid-record" }
      })
      expect(discoveryEnvelopeBytes(result)).toBeLessThan(DISCOVERY_LIMITS.detailBytes)
    }
  })
  test("rejects invalid eager component leaves and source health", () => {
    expect(() => importDiscoveryContract({ ...fixture(), sourceStatuses: JSON.parse('{"__proto__":null}') })).toThrow(
      "Invalid contract"
    )
    for (const extra of [
      { modes: JSON.parse('{"__proto__":null}') },
      { modeSources: JSON.parse('{"__proto__":null}') }
    ]) {
      expect(() =>
        importDiscoveryContract({
          ...fixture(),
          tokens: { colors: { primary: { name: "primary", value: "red", source: { adapter: "codebase" }, ...extra } } }
        })
      ).toThrow("Invalid contract")
    }
    for (const component of [
      null,
      2,
      { name: 3 },
      { name: "Button", source: null },
      { name: "Button", source: { adapter: "other" } },
      { name: "Button", source: { adapter: "codebase" }, classification: { intents: ["unknown"] } },
      { name: "Button", source: { adapter: "codebase" }, rationale: { when: 5 } }
    ]) {
      expect(() => importDiscoveryContract({ ...fixture(), components: { Button: component } })).toThrow(
        "Invalid contract"
      )
    }
    expect(() => importDiscoveryContract({ ...fixture(), sourceStatuses: { codebase: { status: "maybe" } } })).toThrow(
      "Invalid contract"
    )
    expect(() => importDiscoveryContract({ ...fixture(), guidanceHealth: { sources: null } })).toThrow(
      "Invalid contract"
    )
    expect(() => importDiscoveryContract({ ...fixture(), tokens: { colors: null } })).toThrow("Invalid contract")
  })

  test("preserves canonical own keys and fields while rederiving inconsistent indexes", () => {
    const contract = fixture()
    contract.components = Object.fromEntries([["__proto__", { name: "constructor", source: { adapter: "codebase" } }]])
    contract.componentNameIndex = { fake: ["absent"] }
    const imported = importDiscoveryContract(contract)
    expect(Object.keys(imported.components)).toEqual(["__proto__"])
    expect(imported.componentNameIndex?.constructor).toEqual(["__proto__"])
    expect(contract.componentNameIndex).toEqual({ fake: ["absent"] })
  })

  test("older contracts retain unbounded legacy rationale and no invented labels", () => {
    const contract = fixture()
    contract.components.Button.rationale = { why: "x".repeat(200000) }
    const imported = importDiscoveryContract(contract)
    expect(imported.components.Button.rationale?.why?.length).toBe(200000)
    expect(imported.components.Button.classification).toBeUndefined()
    expect(imported.guidanceHealth).toBeUndefined()
  })
})
