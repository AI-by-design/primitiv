import { describe, expect, test } from "bun:test"
import type { Component, ComponentMap, PrimitivConfig } from "../types"
import { emptyTokenMap, TOKEN_CATEGORIES } from "../types"
import { ContractBuilder } from "./contract"

function config(
  sourceOfTruth: PrimitivConfig["governance"]["sourceOfTruth"] = "codebase",
  onConflict: PrimitivConfig["governance"]["onConflict"] = "warn"
): PrimitivConfig {
  return {
    sources: {},
    governance: { sourceOfTruth, onConflict },
    output: { path: "./primitiv.contract.json" }
  }
}

function codebaseComponent(name: string, file: string): Component {
  return { name, displayName: name, source: { adapter: "codebase", file } }
}

function buildWith(componentsBySource: Array<{ name: string; components: ComponentMap }>) {
  return new ContractBuilder(config()).build(
    componentsBySource.map((s) => ({ name: s.name, tokens: emptyTokenMap(), components: s.components }))
  )
}

describe("component merge (path-qualified identity)", () => {
  test("contract version is 0.3.0 (bare-name → qualified-id shape change)", () => {
    const contract = buildWith([])
    expect(contract.version).toBe("0.3.0")
  })

  test("same-name components from one source coexist instead of overwriting", () => {
    const contract = buildWith([
      {
        name: "codebase",
        components: {
          "list/Item": codebaseComponent("Item", "list/Item.tsx"),
          "menu/Item": codebaseComponent("Item", "menu/Item.tsx")
        }
      }
    ])
    expect(contract.components["list/Item"]?.source.file).toBe("list/Item.tsx")
    expect(contract.components["menu/Item"]?.source.file).toBe("menu/Item.tsx")
    // Same-name within one source is coexistence, never a conflict.
    expect(contract.conflicts).toHaveLength(0)
  })

  test("componentNameIndex maps displayName to sorted ids", () => {
    const contract = buildWith([
      {
        name: "codebase",
        components: {
          "menu/Item": codebaseComponent("Item", "menu/Item.tsx"),
          "list/Item": codebaseComponent("Item", "list/Item.tsx"),
          Card: codebaseComponent("Card", "Card.tsx")
        }
      }
    ])
    expect(contract.componentNameIndex?.Item).toEqual(["list/Item", "menu/Item"])
    expect(contract.componentNameIndex?.Card).toEqual(["Card"])
  })

  test("cross-source same-name is a conflict via displayName grouping, both stay in the map", () => {
    const figmaCard: Component = { name: "Card", displayName: "Card", source: { adapter: "figma" } }
    const contract = buildWith([
      { name: "codebase", components: { "components/ui/Card": codebaseComponent("Card", "components/ui/Card.tsx") } },
      { name: "figma", components: { "figma:Card": figmaCard } }
    ])
    const conflict = contract.conflicts.find((c) => c.type === "component" && c.name === "Card")
    expect(conflict).toBeDefined()
    expect(conflict?.sources).toHaveLength(2)
    // Provenance of both contenders survives — neither is silently dropped.
    expect(contract.components["components/ui/Card"]).toBeDefined()
    expect(contract.components["figma:Card"]).toBeDefined()
  })

  test("governance.sourceOfTruth owning exactly one contender records it as the resolved id", () => {
    const figmaCard: Component = { name: "Card", displayName: "Card", source: { adapter: "figma" } }
    const contract = buildWith([
      { name: "codebase", components: { "components/ui/Card": codebaseComponent("Card", "components/ui/Card.tsx") } },
      { name: "figma", components: { "figma:Card": figmaCard } }
    ])
    const conflict = contract.conflicts.find((c) => c.type === "component" && c.name === "Card")
    expect(conflict?.resolved).toBe("components/ui/Card")
  })

  test("no resolved id when the source of truth owns several contenders", () => {
    const figmaCard: Component = { name: "Card", displayName: "Card", source: { adapter: "figma" } }
    const contract = buildWith([
      {
        name: "codebase",
        components: {
          "marketing/Card": codebaseComponent("Card", "marketing/Card.tsx"),
          "product/Card": codebaseComponent("Card", "product/Card.tsx")
        }
      },
      { name: "figma", components: { "figma:Card": figmaCard } }
    ])
    const conflict = contract.conflicts.find((c) => c.type === "component" && c.name === "Card")
    expect(conflict).toBeDefined()
    expect(conflict?.resolved).toBeUndefined()
  })
})

describe("onConflict policy (governance.onConflict)", () => {
  // codebase and figma disagree on colors.primary — with sourceOfTruth "codebase"
  // the conflict is SoT-decided; with "manual" it's a genuine standoff.
  function conflictingTokenSources() {
    return [
      {
        name: "codebase",
        tokens: {
          ...emptyTokenMap(),
          colors: { primary: { name: "primary", value: "#000", source: { adapter: "codebase" } } }
        },
        components: {}
      },
      {
        name: "figma",
        tokens: {
          ...emptyTokenMap(),
          colors: { primary: { name: "primary", value: "#fff", source: { adapter: "figma" } } }
        },
        components: {}
      }
    ]
  }

  test('auto-resolve marks a token conflict the source of truth decides as resolution "auto"', () => {
    const contract = new ContractBuilder(config("codebase", "auto-resolve")).build(conflictingTokenSources())
    const conflict = contract.conflicts.find((c) => c.name === "colors.primary")
    expect(conflict?.resolution).toBe("auto")
    // The SoT value wins in the merged map; the losing provenance stays on the conflict (rule 11).
    expect(contract.tokens.colors?.primary?.value).toBe("#000")
    expect(conflict?.sources).toHaveLength(2)
  })

  test('auto-resolve leaves a standoff (no source-of-truth contender) "pending"', () => {
    const contract = new ContractBuilder(config("manual", "auto-resolve")).build(conflictingTokenSources())
    expect(contract.conflicts.find((c) => c.name === "colors.primary")?.resolution).toBe("pending")
  })

  test('warn and error keep SoT-decided conflicts "pending" — auto-resolve is the only value that resolves them', () => {
    for (const onConflict of ["warn", "error"] as const) {
      const contract = new ContractBuilder(config("codebase", onConflict)).build(conflictingTokenSources())
      expect(contract.conflicts.find((c) => c.name === "colors.primary")?.resolution).toBe("pending")
    }
  })

  test('auto-resolve marks a component conflict with a governed winner "auto", but not one without', () => {
    const figmaCard: Component = { name: "Card", displayName: "Card", source: { adapter: "figma" } }
    const decided = new ContractBuilder(config("codebase", "auto-resolve")).build([
      {
        name: "codebase",
        tokens: emptyTokenMap(),
        components: { "components/ui/Card": codebaseComponent("Card", "components/ui/Card.tsx") }
      },
      { name: "figma", tokens: emptyTokenMap(), components: { "figma:Card": figmaCard } }
    ])
    expect(decided.conflicts.find((c) => c.type === "component" && c.name === "Card")?.resolution).toBe("auto")

    // SoT owning two contenders means no single governed winner — stays pending.
    const standoff = new ContractBuilder(config("codebase", "auto-resolve")).build([
      {
        name: "codebase",
        tokens: emptyTokenMap(),
        components: {
          "marketing/Card": codebaseComponent("Card", "marketing/Card.tsx"),
          "product/Card": codebaseComponent("Card", "product/Card.tsx")
        }
      },
      { name: "figma", tokens: emptyTokenMap(), components: { "figma:Card": figmaCard } }
    ])
    expect(standoff.conflicts.find((c) => c.type === "component" && c.name === "Card")?.resolution).toBe("pending")
  })
})

describe("token categories (single-source vocabulary)", () => {
  test("a built contract carries exactly the canonical token-category set", () => {
    const contract = buildWith([])
    // The decision: all categories always present (some empty), seeded from one source of truth —
    // not the historical 5-key partial map. "other" only appears when a token lands there.
    expect(Object.keys(contract.tokens).sort()).toEqual([...TOKEN_CATEGORIES].sort())
  })

  test("a token in a post-5 category (zIndex) lands in its own bucket, not dropped or merged", () => {
    const contract = new ContractBuilder(config()).build([
      {
        name: "codebase",
        tokens: {
          ...emptyTokenMap(),
          zIndex: { "z-modal": { name: "z-modal", value: "1000", source: { adapter: "codebase" } } }
        },
        components: {}
      }
    ])
    expect(contract.tokens.zIndex?.["z-modal"]?.value).toBe("1000")
  })
})
