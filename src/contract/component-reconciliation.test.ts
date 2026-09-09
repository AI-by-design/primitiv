import { describe, expect, test } from "bun:test"
import type { Component, ComponentMap, PrimitivConfig } from "../types"
import {
  type ComponentReconciliationGroup,
  componentReconciliationGroups,
  reconcileComponentFields,
  reconcileComponentFieldsWithDiagnostics
} from "./component-reconciliation"

function config(sourceOfTruth: PrimitivConfig["governance"]["sourceOfTruth"] = "codebase"): PrimitivConfig {
  return {
    sources: {},
    governance: { sourceOfTruth, onConflict: "warn" },
    output: { path: "./primitiv.contract.json" }
  }
}

function component(
  adapter: Component["source"]["adapter"],
  props?: Component["props"],
  extra: Partial<Component> = {}
): Component {
  return { name: "Button", displayName: "Button", source: { adapter }, ...(props ? { props } : {}), ...extra }
}

function groups(
  components: ComponentMap,
  mappings: PrimitivConfig["reconciliation"] = {}
): ComponentReconciliationGroup[] {
  const nameIndex = {
    Button: Object.keys(components).sort()
  }
  return componentReconciliationGroups(components, nameIndex, mappings.componentMappings)
}

describe("component field association", () => {
  test("uses a complete same-source consensus without inventing a candidate pairing", () => {
    const components = {
      "code/marketing/Button": component("codebase", { size: { default: "md" } }),
      "code/product/Button": component("codebase", { size: { default: "md" } }),
      "figma:button": component("figma", { size: { default: "lg" } })
    }
    const conflicts = reconcileComponentFields({ groups: groups(components), config: config() })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].fieldPath).toEqual(["props", "size", "default"])
    expect(conflicts[0].sources.map((source) => source.componentId)).toEqual([
      "code/marketing/Button",
      "code/product/Button",
      "figma:button"
    ])
  })

  test("omits only a field whose same-source candidates differ or lack complete evidence", () => {
    const components = {
      "code/marketing/Button": component("codebase", {
        tone: { default: "light" },
        size: { default: "sm" },
        disabled: { required: false }
      }),
      "code/product/Button": component("codebase", {
        tone: { default: "light" },
        size: { default: "lg" }
      }),
      "figma:button": component("figma", {
        tone: { default: "dark" },
        size: { default: "lg" },
        disabled: { required: true }
      })
    }
    const conflicts = reconcileComponentFields({ groups: groups(components), config: config() })

    expect(conflicts.map((conflict) => conflict.fieldPath)).toEqual([["props", "tone", "default"]])
  })

  test("an explicit durable mapping selects candidates before name consensus", () => {
    const components = {
      "code/marketing/Button": component("codebase", { size: { default: "sm" } }),
      "code/product/Button": component("codebase", { size: { default: "lg" } }),
      "figma:button": component("figma", { size: { default: "lg" } })
    }
    const mappings = {
      componentMappings: [{ codebase: "code/marketing/Button", figma: "figma:button" }]
    }
    const conflicts = reconcileComponentFields({ groups: groups(components, mappings), config: config() })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].componentIds).toEqual(["code/marketing/Button", "figma:button"])
  })

  test("rejects missing, wrong-adapter, and multiply-mapped durable IDs", () => {
    const components = {
      "code/Button": component("codebase"),
      "figma:button": component("figma"),
      "storybook:Button": component("storybook")
    }
    const nameIndex = { Button: Object.keys(components) }

    expect(() =>
      componentReconciliationGroups(components, nameIndex, [{ codebase: "missing", figma: "figma:button" }])
    ).toThrow(/does not exist/)
    expect(() =>
      componentReconciliationGroups(components, nameIndex, [
        { codebase: "figma:button", storybook: "storybook:Button" }
      ])
    ).toThrow(/belongs to 'figma'/)
    expect(() =>
      componentReconciliationGroups(components, nameIndex, [
        { codebase: "code/Button", figma: "figma:button" },
        { codebase: "code/Button", storybook: "storybook:Button" }
      ])
    ).toThrow(/more than one mapping/)
  })

  test("keeps mappings reserved when an optional adapter is unavailable", () => {
    const components = {
      "code/Button": component("codebase", { size: { default: "sm" } }),
      "storybook:Button": component("storybook", { size: { default: "lg" } })
    }
    const result = componentReconciliationGroups(
      components,
      { Button: Object.keys(components) },
      [{ codebase: "code/Button", figma: "figma:button" }],
      { codebase: { status: "ok" }, figma: { status: "failed" }, storybook: { status: "ok" } }
    )

    expect(result).toEqual([])
  })
})

describe("comparison diagnostics", () => {
  test("explains withheld comparisons when neither adapter can form a consensus", () => {
    const components = {
      "code/a/Button": component("codebase", { size: { default: "sm" } }),
      "code/b/Button": component("codebase", { size: { default: "lg" } }),
      "figma:a": component("figma", { size: { default: "sm" } }),
      "figma:b": component("figma", { size: { default: "md" } })
    }
    const result = reconcileComponentFieldsWithDiagnostics({ groups: groups(components), config: config() })

    expect(result.conflicts).toEqual([])
    expect(result.comparisonDiagnostics?.byReason).toEqual({ "within-adapter-disagreement": 2 })

    const partial = {
      ...components,
      "code/b/Button": component("codebase"),
      "figma:b": component("figma")
    }
    expect(
      reconcileComponentFieldsWithDiagnostics({ groups: groups(partial), config: config() }).comparisonDiagnostics
        ?.byReason
    ).toEqual({ "ambiguous-identity": 1 })
  })

  test("reports ambiguous identity only when it prevents a directional comparison", () => {
    const ambiguous = {
      "code/a/Button": component(
        "codebase",
        { size: { values: ["sm"] } },
        { usage: { sites: 1, props: { size: ["xl"] } } }
      ),
      "code/b/Button": component("codebase", { size: { values: ["sm"] } }),
      "figma:button": component("figma", { size: { values: ["sm"] } })
    }
    const completeConsensus = {
      "code/a/Button": component("codebase", { size: { default: "sm" } }),
      "code/b/Button": component("codebase", { size: { default: "sm" } }),
      "figma:button": component("figma", { size: { default: "sm" } })
    }

    expect(
      reconcileComponentFieldsWithDiagnostics({ groups: groups(ambiguous), config: config() }).comparisonDiagnostics
        ?.items
    ).toEqual([
      {
        type: "could-not-compare",
        reason: "ambiguous-identity",
        name: "Button",
        adapters: ["codebase", "figma"],
        componentIds: ["code/a/Button", "code/b/Button", "figma:button"]
      }
    ])
    expect(
      reconcileComponentFieldsWithDiagnostics({ groups: groups(completeConsensus), config: config() })
        .comparisonDiagnostics
    ).toBeUndefined()
  })

  test("reports proven same-adapter disagreement even when another candidate omits the field", () => {
    const components = {
      "code/a/Button": component("codebase", { size: { default: "sm" } }),
      "code/b/Button": component("codebase", { size: { default: "lg" } }),
      "code/c/Button": component("codebase"),
      "figma:button": component("figma", { size: { default: "md" } })
    }
    const diagnostics = reconcileComponentFieldsWithDiagnostics({
      groups: groups(components),
      config: config()
    }).comparisonDiagnostics

    expect(diagnostics?.items).toContainEqual({
      type: "could-not-compare",
      reason: "within-adapter-disagreement",
      name: "Button",
      adapters: ["codebase"],
      componentIds: ["code/a/Button", "code/b/Button"],
      fieldPath: ["props", "size", "default"]
    })
  })

  test("reports ambiguous identity when partial candidate evidence withholds a formal comparison", () => {
    const components = {
      "code/a/Button": component("codebase", { size: { type: "string" } }),
      "code/b/Button": component("codebase"),
      "figma:button": component("figma", { size: { type: "boolean" } })
    }

    expect(
      reconcileComponentFieldsWithDiagnostics({ groups: groups(components), config: config() }).comparisonDiagnostics
        ?.items
    ).toContainEqual({
      type: "could-not-compare",
      reason: "ambiguous-identity",
      name: "Button",
      adapters: ["codebase", "figma"],
      componentIds: ["code/a/Button", "code/b/Button", "figma:button"]
    })
  })

  test("reports explicit incomplete and unsupported Figma field evidence", () => {
    const components = {
      "code/Button": component("codebase", { size: { type: "string", values: ["sm"] } }),
      "figma:button": component("figma", {
        size: { kind: "variant", incompleteFields: ["values"] }
      })
    }
    const diagnostics = reconcileComponentFieldsWithDiagnostics({
      groups: groups(components),
      config: config()
    }).comparisonDiagnostics

    expect(diagnostics?.byReason).toEqual({
      "incomplete-formal-evidence": 1,
      "unsupported-type-vocabulary": 1
    })
    expect(diagnostics?.items.map((item) => item.fieldPath)).toEqual([
      ["props", "size", "values"],
      ["props", "size", "type"]
    ])
  })

  test("does not report supported primitive types merely because a prop also has a source kind", () => {
    const components = {
      "code/Button": component("codebase", { size: { type: "boolean" } }),
      "figma:button": component("figma", { size: { type: "string", kind: "variant" } })
    }
    const result = reconcileComponentFieldsWithDiagnostics({ groups: groups(components), config: config() })

    expect(result.conflicts).toHaveLength(1)
    expect(result.comparisonDiagnostics).toBeUndefined()
  })

  test("does not diagnose ordinary missing or explicitly unresolved observations", () => {
    const components = {
      "code/Button": component("codebase", { size: { values: ["sm"] } }),
      "storybook:Button": component("storybook", undefined, {
        demonstrated: {
          title: "Button",
          extraction: "source",
          storyCount: 1,
          unresolvedDefaultArgs: ["size"],
          hasUnresolvedDefaultArgsSpread: true
        }
      })
    }

    expect(
      reconcileComponentFieldsWithDiagnostics({ groups: groups(components), config: config() }).comparisonDiagnostics
    ).toBeUndefined()
  })

  test("sorts and caps diagnostics while preserving complete counts", () => {
    const diagnosticGroups = Array.from({ length: 124 }, (_, index): ComponentReconciliationGroup => {
      const name = `Button${String(index).padStart(3, "0")}`
      return {
        name,
        explicitlyMapped: false,
        members: [
          { id: `code/a/${name}`, component: component("codebase", { size: { default: "sm" } }, { name }) },
          { id: `code/b/${name}`, component: component("codebase", { size: { default: "lg" } }, { name }) },
          { id: `figma:${name}`, component: component("figma", { size: { default: "md" } }, { name }) }
        ]
      }
    })
    const result = reconcileComponentFieldsWithDiagnostics({
      groups: [...diagnosticGroups].reverse(),
      config: config()
    }).comparisonDiagnostics

    expect(result?.total).toBe(124)
    expect(result?.items).toHaveLength(100)
    expect(result?.truncated).toBe(true)
    expect(result?.byReason).toEqual({ "within-adapter-disagreement": 124 })
    expect(result).toEqual(
      reconcileComponentFieldsWithDiagnostics({ groups: diagnosticGroups, config: config() }).comparisonDiagnostics
    )
  })
})

describe("component field comparison", () => {
  test("validates each codebase component's retained usage against its own finite domain", () => {
    const components = {
      "code/marketing/Button": component(
        "codebase",
        { size: { values: ["sm", "md"] } },
        { usage: { sites: 3, props: { size: ["xl", "sm", "xl"] } } }
      ),
      "code/product/Button": component(
        "codebase",
        { size: { values: ["sm", "md"] } },
        { usage: { sites: 1, props: { size: ["md"] } } }
      )
    }

    const conflicts = reconcileComponentFields({ groups: [], components, config: config() })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      type: "component",
      scope: "within-source",
      name: "Button",
      componentIds: ["code/marketing/Button"],
      fieldPath: ["props", "size", "values"],
      comparison: "subset",
      resolution: "pending",
      actionable: true,
      evidenceTotal: 2
    })
    expect(conflicts[0].fieldResolution).toBeUndefined()
    expect(conflicts[0].sources.map((source) => source.factPath)).toEqual([
      ["props", "size", "values"],
      ["usage", "props", "size"]
    ])
    expect(conflicts[0].suggestedFix).toContain("Align the JSX usage or widen the declared domain.")
  })

  test("makes no local claim for broad, missing, or explicitly incomplete domains", () => {
    const components = {
      "code/Broad": component("codebase", { size: { type: "string" } }, { usage: { sites: 1 } }),
      "code/Missing": component(
        "codebase",
        { size: { type: "string" } },
        { usage: { sites: 1, props: { size: ["xl"] } } }
      ),
      "code/Incomplete": component(
        "codebase",
        { size: { values: ["sm"], incompleteFields: ["values"] } },
        { usage: { sites: 1, props: { size: ["xl"] } } }
      )
    }

    expect(reconcileComponentFields({ groups: [], components, config: config() })).toEqual([])
    expect(
      reconcileComponentFieldsWithDiagnostics({ groups: [], components, config: config() }).comparisonDiagnostics?.items
    ).toEqual([
      {
        type: "could-not-compare",
        reason: "incomplete-formal-evidence",
        name: "Button",
        adapters: ["codebase"],
        componentIds: ["code/Incomplete"],
        fieldPath: ["props", "size", "values"]
      }
    ])
  })

  test("preserves primitive types and ignores demonstrated or truncated in-domain evidence", () => {
    const components = {
      "code/Typed": component(
        "codebase",
        { value: { values: [1, "1", true] } },
        { usage: { sites: 5, props: { value: [1, "1", true, false, null] } } }
      ),
      "code/Truncated": component(
        "codebase",
        { size: { values: ["sm", "md"] } },
        { usage: { sites: 30, props: { size: ["sm", "md"] }, truncatedProps: ["size"] } }
      ),
      "code/Demonstrated": component(
        "codebase",
        { size: { values: ["sm"] } },
        {
          demonstrated: {
            title: "Demonstrated",
            extraction: "source",
            storyCount: 1,
            stories: [{ id: "demonstrated--default", args: { size: "xl" } }]
          }
        }
      )
    }

    const conflicts = reconcileComponentFields({ groups: [], components, config: config() })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].componentIds).toEqual(["code/Typed"])
    expect(conflicts[0].sources.map((source) => source.structuredValue)).toEqual([[true, 1, "1"], false, null])
  })

  test("retains a deterministic bounded proof for aggregated local offenders", () => {
    const offenders = Array.from({ length: 101 }, (_, index) => `unexpected-${String(index).padStart(3, "0")}`)
    const makeComponents = (values: string[]): ComponentMap => ({
      "code/Button": component(
        "codebase",
        { size: { values: ["allowed"] } },
        { usage: { sites: values.length, props: { size: values }, truncatedProps: ["size"] } }
      )
    })
    const first = reconcileComponentFields({ groups: [], components: makeComponents(offenders), config: config() })[0]
    const second = reconcileComponentFields({
      groups: [],
      components: makeComponents([...offenders].reverse()),
      config: config()
    })[0]

    expect(first).toEqual(second)
    expect(first.sources).toHaveLength(100)
    expect(first.sources.some((source) => Array.isArray(source.structuredValue))).toBe(true)
    expect(first.sources.some((source) => source.structuredValue === "unexpected-000")).toBe(true)
    expect(first.evidenceTotal).toBe(102)
    expect(first.evidenceTruncated).toBe(true)
  })

  test("keeps local and cross-source subset findings separate when both are proven", () => {
    const components = {
      "code/Button": component(
        "codebase",
        { size: { values: ["sm"] } },
        { usage: { sites: 1, props: { size: ["xl"] } } }
      ),
      "figma:button": component("figma", { size: { values: ["sm"] } }),
      "storybook:Button": component("storybook", undefined, {
        demonstrated: {
          title: "Button",
          extraction: "source",
          storyCount: 1,
          stories: [{ id: "button--default", args: { size: "2xl" } }]
        }
      })
    }
    const conflicts = reconcileComponentFields({ groups: groups(components), components, config: config() })

    expect(conflicts.filter((conflict) => conflict.comparison === "subset").map((conflict) => conflict.scope)).toEqual([
      "cross-source",
      "within-source"
    ])
    expect(conflicts.filter((conflict) => conflict.scope === "within-source")).toHaveLength(1)
  })

  test("aggregates three source values once and serializes identically across input permutations", () => {
    const entries = [
      ["storybook:Button", component("storybook", { size: { values: ["md", "sm"], default: "md" } })],
      ["code/Button", component("codebase", { size: { values: ["sm", "md"], default: "sm" } })],
      ["figma:button", component("figma", { size: { values: ["lg", "sm"], default: "lg" } })]
    ] as const
    const forward = Object.fromEntries(entries) as ComponentMap
    const reverse = Object.fromEntries([...entries].reverse()) as ComponentMap

    const first = reconcileComponentFields({ groups: groups(forward), config: config() })
    const second = reconcileComponentFields({ groups: groups(reverse), config: config() })

    expect(first).toEqual(second)
    expect(first).toHaveLength(2)
    expect(first.map((conflict) => conflict.fieldPath)).toEqual([
      ["props", "size", "default"],
      ["props", "size", "values"]
    ])
    expect(first[0].sources).toHaveLength(3)
  })

  test("treats formal value arrays as type-preserving sets", () => {
    const components = {
      "code/Button": component("codebase", { size: { values: [1, "1", true] } }),
      "figma:button": component("figma", { size: { values: [true, "1", 1] } })
    }
    expect(reconcileComponentFields({ groups: groups(components), config: config() })).toEqual([])

    components["figma:button"].props = { size: { values: [true, 1] } }
    const conflicts = reconcileComponentFields({ groups: groups(components), config: config() })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].comparison).toBe("exact")
  })

  test("compares only the shared conservative primitive type vocabulary", () => {
    const components = {
      "code/Button": component("codebase", { size: { type: '"sm" | "lg"', values: ["sm", "lg"] } }),
      "storybook:Button": component("storybook", { size: { type: "enum", values: ["lg", "sm"] } })
    }
    expect(reconcileComponentFields({ groups: groups(components), config: config() })).toEqual([])

    components["code/Button"].props = { size: { type: "string" } }
    components["storybook:Button"].props = { size: { type: "boolean" } }
    expect(reconcileComponentFields({ groups: groups(components), config: config() })[0].fieldPath).toEqual([
      "props",
      "size",
      "type"
    ])
  })

  test("finds known observed and demonstrated values outside a complete formal domain", () => {
    const components = {
      "code/Button": component(
        "codebase",
        { size: { values: ["sm", "md"] } },
        { usage: { sites: 1, props: { size: ["xl"] } } }
      ),
      "storybook:Button": component(
        "storybook",
        { size: { values: ["md", "sm"] } },
        {
          demonstrated: {
            title: "Button",
            extraction: "source",
            storyCount: 1,
            controls: { size: { choices: [{ option: "2xl" }] } },
            stories: [{ id: "button--default", args: { size: "sm" } }]
          }
        }
      )
    }
    const conflicts = reconcileComponentFields({ groups: groups(components), config: config() })
    const subset = conflicts.find((conflict) => conflict.comparison === "subset")

    expect(subset?.fieldPath).toEqual(["props", "size", "values"])
    expect(subset?.sources.some((source) => source.structuredValue === "xl")).toBe(true)
    expect(subset?.sources.some((source) => source.structuredValue === "2xl")).toBe(true)
    expect(subset?.sources.some((source) => source.structuredValue === "sm" && source.factPath?.includes("args"))).toBe(
      false
    )
  })

  test("retains an accepting authoritative domain in a subset conflict", () => {
    const components = {
      "code/Button": component("codebase", { size: { values: ["a", "b"] } }),
      "figma:button": component("figma", { size: { values: ["a"] } }),
      "storybook:Button": component("storybook", undefined, {
        demonstrated: {
          title: "Button",
          extraction: "source",
          storyCount: 1,
          stories: [{ id: "button--default", args: { size: "b" } }]
        }
      })
    }
    const subset = reconcileComponentFields({ groups: groups(components), config: config() }).find(
      (conflict) => conflict.comparison === "subset"
    )

    expect(subset?.componentIds).toEqual(["code/Button", "figma:button", "storybook:Button"])
    expect(subset?.fieldResolution?.componentIds).toEqual(["code/Button"])
    expect(subset?.sources.map((source) => source.source.adapter)).toEqual(["codebase", "figma", "storybook"])
  })

  test("does not run directional checks across an unmapped multi-candidate group", () => {
    const components = {
      "code/a/Button": component(
        "codebase",
        { size: { values: ["sm"] } },
        { usage: { sites: 1, props: { size: ["xl"] } } }
      ),
      "code/b/Button": component("codebase", { size: { values: ["sm"] } }),
      "figma:button": component("figma", { size: { values: ["sm"] } })
    }
    expect(reconcileComponentFields({ groups: groups(components), config: config() })).toEqual([])
  })

  test("does not turn a same-adapter usage contradiction into a cross-source subset conflict", () => {
    const components = {
      "code/Button": component(
        "codebase",
        { size: { values: ["sm"] } },
        { usage: { sites: 1, props: { size: ["xl"] } } }
      ),
      "storybook:Button": component("storybook")
    }

    const conflicts = reconcileComponentFields({ groups: groups(components), config: config() })

    expect(conflicts.filter((conflict) => conflict.comparison === "subset")).toEqual([])
  })

  test("keeps opaque prop names as one structured path segment", () => {
    const codeProps = Object.create(null) as NonNullable<Component["props"]>
    const figmaProps = Object.create(null) as NonNullable<Component["props"]>
    codeProps["__proto__.size"] = { default: "sm" }
    figmaProps["__proto__.size"] = { default: "lg" }
    const components = {
      "code/Button": component("codebase", codeProps),
      "figma:button": component("figma", figmaProps)
    }
    const conflict = reconcileComponentFields({ groups: groups(components), config: config() })[0]
    expect(conflict.fieldPath).toEqual(["props", "__proto__.size", "default"])
  })

  test("treats facts from a failed authoritative source as unavailable", () => {
    const components = {
      "code/Button": component("codebase", { size: { default: "sm" } }),
      "figma:button": component("figma", { size: { default: "lg" } })
    }
    const conflicts = reconcileComponentFields({
      groups: groups(components),
      config: config(),
      sourceStatuses: { codebase: { status: "failed" }, figma: { status: "ok" } }
    })
    expect(conflicts).toEqual([])
  })

  test("reconciles thousands of components and props with bounded deterministic output", () => {
    const components = Object.create(null) as ComponentMap
    const nameIndex: Record<string, string[]> = Object.create(null)
    const componentCount = 1_000
    const propsPerComponent = 5
    for (let index = 0; index < componentCount; index += 1) {
      const name = `Component${String(index).padStart(4, "0")}`
      const codeId = `code/${name}`
      const figmaId = `figma:${name}`
      const codeProps: NonNullable<Component["props"]> = Object.create(null)
      const figmaProps: NonNullable<Component["props"]> = Object.create(null)
      for (let prop = 0; prop < propsPerComponent; prop += 1) {
        codeProps[`prop${prop}`] = { default: `code-${prop}` }
        figmaProps[`prop${prop}`] = { default: `figma-${prop}` }
      }
      components[codeId] = component("codebase", codeProps, { name, displayName: name })
      components[figmaId] = component("figma", figmaProps, { name, displayName: name })
      nameIndex[name] = [figmaId, codeId]
    }

    const startedAt = performance.now()
    const result = reconcileComponentFields({
      groups: componentReconciliationGroups(components, nameIndex),
      config: config()
    })
    const elapsedMs = performance.now() - startedAt

    expect(result).toHaveLength(componentCount * propsPerComponent)
    expect(elapsedMs).toBeLessThan(10_000)
    expect(JSON.stringify(result).length).toBeLessThan(10 * 1024 * 1024)
    expect(result[0].name).toBe("Component0000")
    expect(result.at(-1)?.name).toBe("Component0999")
  })

  test("retains all exact evidence at the 100-row boundary", () => {
    const components = Object.create(null) as ComponentMap
    for (let index = 0; index < 99; index += 1) {
      components[`code/${index}/Button`] = component("codebase", { tone: { default: "light" } })
    }
    components["figma:button"] = component("figma", { tone: { default: "dark" } })

    const conflict = reconcileComponentFields({ groups: groups(components), config: config() })[0]

    expect(conflict.sources).toHaveLength(100)
    expect(conflict.componentIds).toHaveLength(100)
    expect(conflict.evidenceTotal).toBe(100)
    expect(conflict.evidenceTruncated).toBeUndefined()
    expect(new Set(conflict.sources.map((source) => source.source.adapter))).toEqual(new Set(["codebase", "figma"]))
  })

  test("retains a bounded proof when complete consensus evidence exceeds the projection bound", () => {
    const components = Object.create(null) as ComponentMap
    for (let index = 0; index < 100; index += 1) {
      components[`code/${index}/Button`] = component("codebase", { tone: { default: "light" } })
    }
    components["figma:button"] = component("figma", { tone: { default: "dark" } })

    const conflict = reconcileComponentFields({ groups: groups(components), config: config() })[0]

    expect(conflict.sources).toHaveLength(100)
    expect(conflict.sources.some((source) => source.source.adapter === "figma")).toBe(true)
    expect(conflict.componentIds).toHaveLength(101)
    expect(conflict.componentIds).toContain("code/99/Button")
    expect(conflict.sources.some((source) => source.componentId === "code/99/Button")).toBe(false)
    expect(conflict.evidenceTotal).toBe(101)
    expect(conflict.evidenceTruncated).toBe(true)
    expect(conflict.scope).toBe("cross-source")
    expect(conflict.fieldResolution?.componentIds).toHaveLength(100)
  })

  test("serializes oversized exact evidence identically across input permutations", () => {
    const entries: Array<[string, Component]> = []
    for (let index = 0; index < 100; index += 1) {
      entries.push([`code/${index}/Button`, component("codebase", { tone: { default: "light" } })])
    }
    entries.push(["figma:button", component("figma", { tone: { default: "dark" } })])

    const forward = Object.fromEntries(entries) as ComponentMap
    const reverse = Object.fromEntries([...entries].reverse()) as ComponentMap

    expect(reconcileComponentFields({ groups: groups(forward), config: config() })).toEqual(
      reconcileComponentFields({ groups: groups(reverse), config: config() })
    )
  })

  test("retains formal domains and bounded offenders when subset evidence has more than 100 distinct values", () => {
    const offenders = Array.from({ length: 101 }, (_, index) => `unexpected-${String(index).padStart(3, "0")}`)
    const components = {
      "code/Button": component(
        "codebase",
        { size: { values: ["allowed"] } },
        { usage: { sites: offenders.length, props: { size: offenders } } }
      ),
      "figma:button": component("figma", { size: { values: ["allowed"] } })
    }

    const conflict = reconcileComponentFields({ groups: groups(components), config: config() }).find(
      (candidate) => candidate.comparison === "subset"
    )

    expect(conflict?.sources).toHaveLength(100)
    expect(conflict?.sources.filter((source) => Array.isArray(source.structuredValue))).toHaveLength(2)
    expect(conflict?.sources.some((source) => source.structuredValue === "unexpected-000")).toBe(true)
    expect(conflict?.evidenceTotal).toBe(103)
    expect(conflict?.evidenceTruncated).toBe(true)
    expect(conflict?.scope).toBe("cross-source")
  })

  test("handles a large ambiguous group with disjoint fields without a quadratic path scan", () => {
    const components = Object.create(null) as ComponentMap
    for (let index = 0; index < 2_000; index += 1) {
      components[`code/${index}/Button`] = component("codebase", {
        [`prop${index}`]: { default: String(index) }
      })
    }
    components["figma:button"] = component("figma", { common: { default: "figma" } })

    const startedAt = performance.now()
    const result = reconcileComponentFields({ groups: groups(components), config: config() })
    expect(result).toEqual([])
    expect(performance.now() - startedAt).toBeLessThan(5_000)
  })
})
