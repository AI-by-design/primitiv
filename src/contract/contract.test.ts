import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Component, ComponentMap, PrimitivConfig, PrimitivContract } from "../types"
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

  test("relationship facts survive construction and serialization without creating a conflict", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-contract-relationships-"))
    const outputPath = path.join(tempDir, "primitiv.contract.json")
    const builder = new ContractBuilder({ ...config(), output: { path: outputPath } })
    const button: Component = {
      ...codebaseComponent("Button", "components/Button.tsx"),
      uses: {
        "components/Icon": 2,
        "components/Spinner": 1
      },
      usage: { sites: 3 }
    }

    try {
      const contract = builder.build([
        {
          name: "codebase",
          tokens: emptyTokenMap(),
          components: { "components/Button": button }
        }
      ])

      expect(contract.version).toBe("0.3.0")
      expect(contract.components["components/Button"]?.uses).toEqual({
        "components/Icon": 2,
        "components/Spinner": 1
      })
      expect(contract.components["components/Button"]?.usage).toEqual({ sites: 3 })
      expect(contract.conflicts).toHaveLength(0)

      builder.save(contract)
      const serialized = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as PrimitivContract
      expect(serialized.components["components/Button"].uses).toEqual({
        "components/Icon": 2,
        "components/Spinner": 1
      })
      expect(serialized.components["components/Button"].usage).toEqual({ sites: 3 })
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("typed prop values and string defaults survive construction and JSON serialization", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-contract-prop-values-"))
    const outputPath = path.join(tempDir, "primitiv.contract.json")
    const builder = new ContractBuilder({ ...config(), output: { path: outputPath } })
    const button: Component = {
      ...codebaseComponent("Button", "components/Button.tsx"),
      props: {
        size: {
          type: '"sm" | "md" | "lg"',
          required: false,
          default: "md",
          values: ["lg", "md", "sm"]
        },
        elevation: { type: "0 | 1 | 2", required: false, default: "1", values: [0, 1, 2] },
        disabled: { type: "true | false", required: false, default: "false", values: [false, true] },
        legacy: { type: "string", required: true }
      }
    }

    try {
      const contract = builder.build([
        { name: "codebase", tokens: emptyTokenMap(), components: { "components/Button": button } }
      ])

      expect(contract.version).toBe("0.3.0")
      expect(contract.components["components/Button"]?.props).toEqual(button.props)
      expect(contract.conflicts).toHaveLength(0)

      builder.save(contract)
      const serialized = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as PrimitivContract
      expect(serialized.version).toBe("0.3.0")
      expect(serialized.components["components/Button"]?.props).toEqual(button.props)
      expect(serialized.conflicts).toHaveLength(0)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
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

describe("same-source redefinition conflicts", () => {
  function redefinition() {
    return {
      category: "colors",
      name: "color-bg",
      kept: { value: "#ffffff", source: { adapter: "codebase" as const, file: "a.css", line: 1 } },
      discarded: [{ value: "#000000", source: { adapter: "codebase" as const, file: "b.css", line: 3 } }]
    }
  }

  test("a redefinition surfaces as a pending, actionable token conflict with every provenance", () => {
    const contract = new ContractBuilder(config()).build([
      { name: "codebase", tokens: emptyTokenMap(), components: {}, redefinitions: [redefinition()] }
    ])
    const conflict = contract.conflicts.find((c) => c.type === "token" && c.name === "colors.color-bg")
    expect(conflict).toBeDefined()
    expect(conflict?.resolution).toBe("pending")
    expect(conflict?.actionable).toBe(true)
    expect(conflict?.sources).toHaveLength(2)
    expect(conflict?.suggestedFix).toContain("a.css:1")
    expect(conflict?.suggestedFix).toContain("b.css:3")
    expect(conflict?.suggestedFix).toContain("keeps the first")
  })

  test("auto-resolve never self-arbitrates: a same-source conflict stays pending even when the source IS the source of truth", () => {
    const contract = new ContractBuilder(config("codebase", "auto-resolve")).build([
      { name: "codebase", tokens: emptyTokenMap(), components: {}, redefinitions: [redefinition()] }
    ])
    const conflict = contract.conflicts.find((c) => c.name === "colors.color-bg")
    expect(conflict?.resolution).toBe("pending")
  })
})

describe("token value equivalence", () => {
  function source(name: "codebase" | "figma", value: string, category = "colors") {
    const tokens = emptyTokenMap()
    tokens[category].brand = { name: "brand", value, source: { adapter: name } }
    return { name, tokens, components: {} }
  }

  test("does not create cross-source conflicts for equivalent colour spellings", () => {
    const contract = new ContractBuilder(config("manual")).build([
      source("codebase", "#1E4FD8"),
      source("figma", "#1e4fd8")
    ])
    expect(contract.conflicts).toHaveLength(0)
    // The comparison is normalized, not stored: provenance retains the source spelling.
    expect(contract.tokens.colors.brand.value).toBe("#1E4FD8")
  })

  test("does not hide genuinely different values", () => {
    const contract = new ContractBuilder(config("manual")).build([
      source("codebase", "600", "typography"),
      source("figma", "600px", "typography")
    ])
    expect(contract.conflicts).toHaveLength(1)
  })
})

describe("theme-mode reconciliation", () => {
  function tokenSource(adapter: "codebase" | "figma", value: string, modes?: Record<string, string>) {
    const tokens = emptyTokenMap()
    tokens.colors.brand = {
      name: "brand",
      value,
      source: { adapter },
      ...(modes
        ? {
            modes,
            modeSources: Object.fromEntries(Object.keys(modes).map((mode) => [mode, { adapter }]))
          }
        : {})
    }
    return { name: adapter, tokens, components: {} }
  }

  test("a conflicting mode is a separate conflict and the source of truth owns its provenance", () => {
    const contract = new ContractBuilder(config("figma", "auto-resolve")).build([
      tokenSource("codebase", "#fff", { dark: "#000" }),
      tokenSource("figma", "#ffffff", { dark: "#111111" })
    ])
    const conflict = contract.conflicts.find((candidate) => candidate.name === "colors.brand.modes.dark")
    expect(conflict?.resolution).toBe("auto")
    expect(contract.tokens.colors.brand?.value).toBe("#fff")
    expect(contract.tokens.colors.brand?.modes?.dark).toBe("#111111")
    expect(contract.tokens.colors.brand?.modeSources?.dark?.adapter).toBe("figma")
  })

  test("equivalent mode values do not conflict and retain the first observed source", () => {
    const contract = new ContractBuilder(config("manual")).build([
      tokenSource("codebase", "#fff", { dark: "#000" }),
      tokenSource("figma", "#ffffff", { dark: "#000000" })
    ])
    expect(contract.conflicts).toEqual([])
    expect(contract.tokens.colors.brand?.modes?.dark).toBe("#000")
    expect(contract.tokens.colors.brand?.modeSources?.dark?.adapter).toBe("codebase")
  })

  test("a source without a mode cannot erase a known mode while it wins the default", () => {
    const contract = new ContractBuilder(config("figma", "auto-resolve")).build([
      tokenSource("codebase", "#fff", { dark: "#000" }),
      tokenSource("figma", "#111111")
    ])
    expect(contract.tokens.colors.brand?.value).toBe("#111111")
    expect(contract.tokens.colors.brand?.modes?.dark).toBe("#000")
    expect(contract.tokens.colors.brand?.modeSources?.dark?.adapter).toBe("codebase")
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
