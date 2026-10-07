import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type { Component, ComponentMap, PrimitivContract } from "../types"
import {
  type ComponentCatalog,
  type ComponentContext,
  type ComponentShortlist,
  createDiscoveryIndex,
  createSnapshotId,
  DISCOVERY_LIMITS,
  type DiscoveryEnvelope,
  discoveryEnvelopeBytes,
  findComponents,
  getComponentCatalog,
  getComponentContext
} from "./index"

function component(extra: Partial<Component> = {}): Component {
  return { name: "Button", source: { adapter: "codebase" }, ...extra }
}

function contract(components: ComponentMap = {}): PrimitivContract {
  return {
    version: "2.19.1",
    generatedAt: "2026-10-01T00:00:00.000Z",
    sourceRoot: "/private/tmp/checkout/src",
    configPath: "/private/tmp/checkout/primitiv.config.js",
    sources: ["codebase"],
    tokens: { colors: {}, spacing: {}, typography: {}, borderRadius: {}, shadows: {} },
    components,
    conflicts: []
  }
}

function payload<T>(result: DiscoveryEnvelope<T>): T {
  expect(result.isError).toBeUndefined()
  expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
  return result.structuredContent as T
}

function errorCode(result: DiscoveryEnvelope<unknown>): string {
  expect(result.isError).toBe(true)
  expect(discoveryEnvelopeBytes(result)).toBeLessThan(DISCOVERY_LIMITS.shortlistBytes)
  if (!("error" in (result.structuredContent as object))) throw new Error("Expected discovery error")
  return (result.structuredContent as { error: { code: string } }).error.code
}

const sample = () =>
  contract({
    "components/ui/Button": component({
      classification: { atomicLevel: "atom", intents: ["input", "call-to-action"] },
      description: "Source-provided description",
      rationale: { description: "Authored description", when: "Submit a form" }
    }),
    "components/checkout/Button": component({
      classification: { atomicLevel: "molecule", intents: ["call-to-action"] },
      scope: "app/checkout"
    }),
    "components/ui/Search": component({ name: "Search", classification: { intents: ["input"] } }),
    "components/ui/Legacy": component({
      name: "Legacy",
      rationale: { why: "Still useful", when: "Existing workflows" }
    }),
    "storybook:Feedback": component({
      name: "Feedback",
      kind: "component",
      source: { adapter: "storybook" },
      classification: { atomicLevel: "organism", intents: [] }
    }),
    "screens/Home": component({ name: "Home", kind: "screen" })
  })

describe("pure discovery navigation", () => {
  test("legacy inventory remains useful without inventing classification, kind, or guidance health", () => {
    const index = createDiscoveryIndex(
      contract({ Legacy: component({ rationale: { why: "Existing reusable control" } }) })
    )
    const catalog = payload<ComponentCatalog>(getComponentCatalog(index))
    expect(catalog.total).toBe(1)
    expect(catalog.coverage).toEqual({
      total: 1,
      withLevel: 0,
      withIntents: 0,
      complete: 0,
      missingLevel: 1,
      missingIntents: 1,
      missingEither: 1
    })
    expect(catalog.health.guidance).toEqual({ state: "unknown" })
    expect(catalog.counts.kind.unknown).toBe(1)
    expect("items" in catalog).toBe(false)
    expect(payload<ComponentShortlist>(findComponents(index)).items).toEqual([
      { id: "Legacy", name: "Button", kind: "unknown", preview: true }
    ])
    const detail = payload<ComponentContext>(getComponentContext(index, { id: "Legacy", snapshotId: index.snapshotId }))
    expect(detail.sections?.guidance).toMatchObject({ rationale: { why: "Existing reusable control" }, origin: null })
  })

  test("ANDs dimensions, supports any/all intents, and preserves honest unclassified coverage", () => {
    const index = createDiscoveryIndex(sample())
    const any = payload<ComponentShortlist>(findComponents(index, { intents: ["input", "call-to-action"] }))
    expect(any.total).toBe(3)
    const all = payload<ComponentShortlist>(
      findComponents(index, { intents: ["input", "call-to-action"], intentMatch: "all", level: "atom" })
    )
    expect(all.items.map((item) => item.id)).toEqual(["components/ui/Button"])
    expect(all.coverage.missingEither).toBe(4)
    expect(all.excluded).toBe(5)
    expect(payload<ComponentShortlist>(findComponents(index, { intents: [] })).total).toBe(6)
    expect(payload<ComponentShortlist>(findComponents(index, { unclassified: "missing-level" })).total).toBe(3)
    expect(payload<ComponentShortlist>(findComponents(index, { unclassified: "missing-intents" })).total).toBe(3)
    expect(payload<ComponentShortlist>(findComponents(index, { unclassified: "either" })).total).toBe(4)
    const empty = payload<ComponentShortlist>(findComponents(index, { level: "page", kind: "component" }))
    expect(empty.total).toBe(0)
    expect(empty.coverage.missingEither).toBe(4)
    expect(payload<ComponentShortlist>(findComponents(index, { kind: "component" })).total).toBe(1)
    expect(
      payload<ComponentShortlist>(findComponents(index, { level: "atom", unclassified: "missing-level" })).total
    ).toBe(0)
  })

  test("scope follows existing segment containment and explicit overrides without resolving name ambiguity", () => {
    const index = createDiscoveryIndex(sample())
    expect(
      payload<ComponentShortlist>(findComponents(index, { scope: "/project/app/checkout/page.tsx" })).items.map(
        (item) => item.id
      )
    ).toEqual(["components/checkout/Button"])
    expect(payload<ComponentShortlist>(findComponents(index, { scope: "src/components/ui/Form.tsx" })).total).toBe(3)
    expect(payload<ComponentShortlist>(findComponents(index, { scope: "components/uikit/Form.tsx" })).total).toBe(0)
    expect(
      payload<ComponentShortlist>(findComponents(index)).items.filter((item) => item.name === "Button")
    ).toHaveLength(2)
  })

  test("derives indexes from canonical records, isolates mutations, and safely retains special own keys", () => {
    const source = sample()
    source.componentNameIndex = { invented: ["not-there"] }
    Object.defineProperty(source.components, "__proto__", { enumerable: true, value: component({ name: "Special" }) })
    const index = createDiscoveryIndex(source)
    source.components["components/ui/Button"].rationale = { when: "Changed later" }
    source.components.Other = component()
    expect(Object.isFrozen(index)).toBe(true)
    expect(Object.isFrozen(index.contract.components)).toBe(true)
    expect(index.ids).toContain("__proto__")
    expect(payload<ComponentShortlist>(findComponents(index)).total).toBe(7)
    expect(
      payload<ComponentShortlist>(findComponents(index)).items.find((item) => item.id === "components/ui/Button")?.usage
    ).toEqual({ text: "Submit a form", complete: true })
    expect(
      payload<ComponentContext>(getComponentContext(index, { id: "__proto__", snapshotId: index.snapshotId })).name
    ).toBe("Special")
    expect(errorCode(getComponentContext(index, { id: "toString", snapshotId: index.snapshotId }))).toBe("not-found")
  })

  test("sorts and pages IDs, binds normalized filters, and rejects malformed or changed-revision cursors", () => {
    const index = createDiscoveryIndex(sample())
    const first = payload<ComponentShortlist>(findComponents(index, { limit: 1, intents: ["input", "call-to-action"] }))
    const second = payload<ComponentShortlist>(
      findComponents(index, { limit: 1, intents: ["call-to-action", "input", "input"], cursor: first.nextCursor })
    )
    expect(first.items[0].id < second.items[0].id).toBe(true)
    expect(errorCode(findComponents(index, { limit: 1, intents: ["input"], cursor: first.nextCursor }))).toBe(
      "invalid-cursor"
    )
    expect(errorCode(findComponents(index, { cursor: "%%%not-json" }))).toBe("invalid-cursor")
    const changed = sample()
    changed.components["components/ui/Button"].description = "New revision"
    const next = createDiscoveryIndex(changed)
    expect(
      errorCode(findComponents(next, { limit: 1, intents: ["input", "call-to-action"], cursor: first.nextCursor }))
    ).toBe("snapshot-changed")
    expect(errorCode(getComponentContext(next, { id: first.items[0].id, snapshotId: first.snapshotId }))).toBe(
      "snapshot-changed"
    )
    const forged = JSON.parse(Buffer.from(first.nextCursor ?? "", "base64url").toString())
    forged.position = 999999
    const { checksum: _, ...body } = forged
    forged.checksum = createHash("sha256").update(JSON.stringify(body)).digest("hex")
    expect(
      errorCode(
        findComponents(index, {
          limit: 1,
          intents: ["input", "call-to-action"],
          cursor: Buffer.from(JSON.stringify(forged)).toString("base64url")
        })
      )
    ).toBe("invalid-cursor")
  })

  test("invalid filters and large malicious input yield compact errors without reflecting input", () => {
    const index = createDiscoveryIndex(sample())
    for (const query of [
      { level: "widget" },
      { intentMatch: "maybe" },
      { intents: ["other"] },
      { limit: 0 },
      { limit: 51 },
      { unknown: "x".repeat(100000) },
      { scope: ".." },
      { unclassified: "none" }
    ]) {
      expect(errorCode(findComponents(index, query as never))).toBe("invalid-query")
    }
    expect(
      errorCode(getComponentContext(index, { id: "x", snapshotId: index.snapshotId, sections: ["unknown"] } as never))
    ).toBe("invalid-query")
  })
})

describe("bounded projections", () => {
  test("effective description origins and preview completeness are explicit", () => {
    const source = sample()
    source.components["components/ui/Button"].rationale = { description: "💡".repeat(1000), when: "用".repeat(1000) }
    const index = createDiscoveryIndex(source)
    const item = payload<ComponentShortlist>(findComponents(index, { level: "atom" })).items[0]
    expect(item.description?.origin).toBe("authored")
    expect(item.description?.complete).toBe(false)
    expect(item.usage?.complete).toBe(false)
    const detail = payload<ComponentContext>(
      getComponentContext(index, { id: item.id, snapshotId: index.snapshotId, sections: ["guidance"] })
    )
    expect(detail.sections?.guidance).toMatchObject({ description: { text: "💡".repeat(1000), origin: "authored" } })
    const sourceOnly = createDiscoveryIndex(contract({ Source: component({ description: "Published description" }) }))
    expect(payload<ComponentShortlist>(findComponents(sourceOnly)).items[0].description?.origin).toBe("source")
  })

  test("shrinks actual duplicated UTF-8 shortlist envelopes at 1k and 10k components without losing pages", () => {
    for (const size of [1000, 10000]) {
      const components: ComponentMap = {}
      for (let i = size - 1; i >= 0; i--) {
        components[`components/${String(i).padStart(5, "0")}`] = component({
          name: `項目${i}`,
          description: '\\"\n漢字💡'.repeat(512),
          rationale: { when: '\\"\n漢字💡'.repeat(512) }
        })
      }
      const index = createDiscoveryIndex(contract(components))
      const result = findComponents(index, { limit: 50 })
      const first = payload<ComponentShortlist>(result)
      expect(discoveryEnvelopeBytes(result)).toBeLessThanOrEqual(DISCOVERY_LIMITS.shortlistBytes)
      expect(first.total).toBe(size)
      expect(first.returned).toBeGreaterThan(0)
      expect(first.returned).toBeLessThan(50)
      const second = payload<ComponentShortlist>(findComponents(index, { limit: 50, cursor: first.nextCursor }))
      expect(second.items[0].id).toBe(index.ids[first.returned])
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(
        first.returned + second.returned
      )
    }
  })

  test("complete detail distinguishes declared API, observed data, demonstrated evidence and advisory pairings", () => {
    const index = createDiscoveryIndex(
      contract({
        Button: component({
          props: { size: { type: '"sm" | "lg"', values: ["sm", "lg"], incompleteFields: ["required"] } },
          usage: { sites: 3, props: { size: ["sm"] }, truncatedProps: ["label"] },
          demonstrated: { title: "Button", extraction: "manifest-only", storyCount: 1 },
          uses: { Icon: 2 },
          rationale: { pairsWith: [{ description: "Often shown beside icon", component: { componentId: "Icon" } }] }
        }),
        Icon: component({ kind: "icon" })
      })
    )
    const detail = payload<ComponentContext>(getComponentContext(index, { id: "Button", snapshotId: index.snapshotId }))
    expect(detail.complete).toBe(true)
    expect(detail.sections?.api).toMatchObject({
      declared: { props: { size: { incompleteFields: ["required"] } } },
      observed: { sites: 3, truncatedProps: ["label"] },
      demonstrated: { extraction: "manifest-only" }
    })
    expect(detail.sections?.guidance).toMatchObject({ pairings: "advisory" })
    const icon = payload<ComponentContext>(
      getComponentContext(index, { id: "Icon", snapshotId: index.snapshotId, sections: ["relationships"] })
    )
    expect(icon.sections?.relationships).toMatchObject({
      uses: {},
      usedBy: { Button: 2 },
      evidence: "static-jsx-sites"
    })
  })

  test("giant multilingual escape-heavy legacy guidance is fully recoverable through bounded section fragments", () => {
    const rationale = { why: '\\"\n漢字💡'.repeat(15000), examples: ["second", "first"] }
    const index = createDiscoveryIndex(contract({ Giant: component({ rationale }) }))
    const sections: Record<string, unknown> = {}
    let text = ""
    let cursor: string | undefined
    let pages = 0
    do {
      const result = getComponentContext(index, { id: "Giant", snapshotId: index.snapshotId, cursor })
      expect(discoveryEnvelopeBytes(result)).toBeLessThanOrEqual(DISCOVERY_LIMITS.detailBytes)
      const page = payload<ComponentContext>(result)
      Object.assign(sections, page.sections)
      if (page.continuation) {
        expect(page.continuation.offset).toBe(text.length)
        expect(page.continuation.assembly).toBe("concatenate-then-json-parse")
        text += page.continuation.text
        if (page.continuation.sectionComplete) sections[page.continuation.section] = JSON.parse(text)
      }
      cursor = page.nextCursor
      expect(page.complete).toBe(cursor === undefined)
      pages++
      expect(pages).toBeLessThan(100)
    } while (cursor)
    expect(pages).toBeGreaterThan(3)
    expect(sections.guidance).toMatchObject({ rationale })
    expect(sections).toHaveProperty("api")
    expect(sections).toHaveProperty("relationships")
    expect(sections).toHaveProperty("source")
  })

  test("detail cursors bind exact IDs and section sets; reload health travels on successes and errors", () => {
    const index = createDiscoveryIndex(
      contract({ A: component({ rationale: { why: "漢".repeat(100000) } }), B: component() })
    )
    const reload = { state: "reload-failed" as const, stale: true }
    const page = payload<ComponentContext>(
      getComponentContext(index, { id: "A", snapshotId: index.snapshotId, sections: ["guidance"] }, reload)
    )
    expect(page.reload).toEqual(reload)
    expect(page.nextCursor).toBeDefined()
    expect(
      errorCode(
        getComponentContext(index, {
          id: "B",
          snapshotId: index.snapshotId,
          sections: ["guidance"],
          cursor: page.nextCursor
        })
      )
    ).toBe("invalid-cursor")
    expect(
      errorCode(
        getComponentContext(index, {
          id: "A",
          snapshotId: index.snapshotId,
          sections: ["api"],
          cursor: page.nextCursor
        })
      )
    ).toBe("invalid-cursor")
    const missing = getComponentContext(index, { id: "Missing", snapshotId: index.snapshotId }, reload)
    expect((missing.structuredContent as { reload: unknown }).reload).toEqual(reload)
    expect(payload<ComponentCatalog>(getComponentCatalog(index, reload)).reload).toEqual(reload)
    expect(payload<ComponentShortlist>(findComponents(index, {}, reload)).reload).toEqual(reload)
  })

  test("an individual oversized identity returns an explicit bounded error", () => {
    const index = createDiscoveryIndex(contract({ Huge: component({ name: "巨".repeat(100000) }) }))
    expect(errorCode(findComponents(index))).toBe("record-too-large")
    expect(errorCode(getComponentContext(index, { id: "Huge", snapshotId: index.snapshotId }))).toBe("record-too-large")
  })
})

describe("versioned snapshot identity", () => {
  test("ignores generated timestamps, object insertion order, derived indexes, and explicit temporary root relocation", () => {
    const first = sample()
    const second = JSON.parse(JSON.stringify(first)) as PrimitivContract
    second.generatedAt = "2026-10-06T00:00:00.000Z"
    second.components = Object.fromEntries(Object.entries(second.components).reverse())
    second.componentNameIndex = { wrong: ["not-there"] }
    second.sourceRoot = "/private/tmp/new-checkout/src"
    second.configPath = "/private/tmp/new-checkout/primitiv.config.js"
    const roots = { temporaryRoots: ["/private/tmp/checkout", "/private/tmp/new-checkout"] }
    expect(createSnapshotId(first, roots)).toBe(createSnapshotId(second, roots))
    expect(createSnapshotId(first)).not.toBe(createSnapshotId(second))
    const reordered = sample()
    reordered.components["components/ui/Button"].classification = {
      atomicLevel: "atom",
      intents: ["call-to-action", "input", "input"]
    }
    expect(createSnapshotId(first)).toBe(createSnapshotId(reordered))
  })

  test("retains guidance order, origins, source health, lookup governance, remote timestamps and prose paths", () => {
    const first = sample()
    const variations: Array<(value: PrimitivContract) => void> = [
      (value) => {
        value.components["components/ui/Button"].rationale = { examples: ["first", "second"] }
      },
      (value) => {
        value.components["components/ui/Button"].description = "/private/tmp/new-checkout/prose"
      },
      (value) => {
        value.sourceStatuses = { codebase: { status: "failed", error: "Failed scan" } }
      },
      (value) => {
        value.componentNameResolutions = { Button: "components/ui/Button" }
      },
      (value) => {
        value.components["components/ui/Button"].source.metadata = { observedAt: "2026-10-06" }
      },
      (value) => {
        value.components["components/ui/Button"].guidanceOrigin = {
          sourceId: "inline",
          sourceKind: "inline",
          locator: "primitiv.config.js",
          authoredKey: "Button",
          binding: "unique-name"
        }
      },
      (value) => {
        value.guidanceHealth = { schemaVersion: 1, sources: [], total: 0, byCode: {}, items: [], truncated: false }
      }
    ]
    for (const change of variations) {
      const second = sample()
      change(second)
      expect(createSnapshotId(first)).not.toBe(createSnapshotId(second))
    }
    const a = sample()
    const b = sample()
    a.components["components/ui/Button"].rationale = { examples: ["first", "second"] }
    b.components["components/ui/Button"].rationale = { examples: ["second", "first"] }
    expect(createSnapshotId(a)).not.toBe(createSnapshotId(b))
    a.components["components/ui/Button"].description = "/private/tmp/checkout/prose"
    b.components["components/ui/Button"].description = "/private/tmp/new-checkout/prose"
    const roots = { temporaryRoots: ["/private/tmp/checkout", "/private/tmp/new-checkout"] }
    expect(createSnapshotId(a, roots)).not.toBe(createSnapshotId(b, roots))
  })
})
