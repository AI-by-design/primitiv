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

  test("an explicit mapping supplies the governance lookup winner when the source of truth has several candidates", () => {
    const builder = new ContractBuilder({
      ...config(),
      reconciliation: {
        componentMappings: [{ codebase: "checkout/Button", figma: "figma:button" }]
      }
    })
    const contract = builder.build([
      {
        name: "codebase",
        tokens: emptyTokenMap(),
        components: {
          "checkout/Button": codebaseComponent("Button", "checkout/Button.tsx"),
          "marketing/Button": codebaseComponent("Button", "marketing/Button.tsx")
        }
      },
      {
        name: "figma",
        tokens: emptyTokenMap(),
        components: {
          "figma:button": { name: "Button", displayName: "Button", source: { adapter: "figma" } }
        }
      }
    ])

    expect(contract.componentNameResolutions?.Button).toBe("checkout/Button")
  })

  test("an explicit mapping remains non-blocking when its optional partner failed to scan", () => {
    const builder = new ContractBuilder({
      ...config(),
      reconciliation: {
        componentMappings: [{ codebase: "ui/Button", figma: "figma:button" }]
      }
    })
    const contract = builder.build(
      [
        {
          name: "codebase",
          tokens: emptyTokenMap(),
          components: { "ui/Button": codebaseComponent("Button", "ui/Button.tsx") }
        }
      ],
      { sourceStatuses: { codebase: { status: "ok" }, figma: { status: "failed" } } }
    )

    expect(contract.components["ui/Button"]).toBeDefined()
    expect(contract.sourceStatuses?.figma?.status).toBe("failed")
    expect(contract.conflicts).toEqual([])
  })

  test("source and status insertion order cannot change the serialized component contract", () => {
    const sources = [
      {
        name: "storybook",
        tokens: emptyTokenMap(),
        components: {
          "storybook:UI/Button": {
            name: "Button",
            displayName: "Button",
            source: { adapter: "storybook" as const },
            props: { size: { values: ["xl", "sm"] } }
          }
        }
      },
      {
        name: "codebase",
        tokens: emptyTokenMap(),
        components: {
          "ui/Button": {
            ...codebaseComponent("Button", "ui/Button.tsx"),
            props: { size: { values: ["md", "sm"] } }
          }
        }
      },
      {
        name: "figma",
        tokens: emptyTokenMap(),
        components: {
          "figma:button": {
            name: "Button",
            displayName: "Button",
            source: { adapter: "figma" as const },
            props: { size: { values: ["lg", "sm"] } }
          }
        }
      }
    ]
    const builder = new ContractBuilder(config())
    const first = builder.build(sources, {
      sourceStatuses: { storybook: { status: "ok" }, codebase: { status: "ok" }, figma: { status: "ok" } }
    })
    const second = builder.build([...sources].reverse(), {
      sourceStatuses: { figma: { status: "ok" }, codebase: { status: "ok" }, storybook: { status: "ok" } }
    })
    const normalize = (contract: PrimitivContract) => {
      const serialized = JSON.parse(JSON.stringify(contract))
      delete serialized.generatedAt
      return serialized
    }

    expect(normalize(first)).toEqual(normalize(second))
  })

  test("component insertion order cannot change serialized name-index bytes", () => {
    const entries = [
      ["z/Zed", codebaseComponent("Zed", "z/Zed.tsx")],
      ["a/Alpha", codebaseComponent("Alpha", "a/Alpha.tsx")]
    ] as const
    const first = buildWith([{ name: "codebase", components: Object.fromEntries(entries) }])
    const second = buildWith([{ name: "codebase", components: Object.fromEntries([...entries].reverse()) }])
    const serialize = (contract: PrimitivContract) => {
      const copy = { ...contract, generatedAt: "stable" }
      return JSON.stringify(copy)
    }

    expect(serialize(first)).toBe(serialize(second))
    expect(Object.keys(first.componentNameIndex ?? {})).toEqual(["Alpha", "Zed"])
  })

  test("prototype-like component names remain ordinary lookup keys", () => {
    const contract = buildWith([
      {
        name: "figma",
        components: {
          "figma:proto-key": {
            name: "__proto__",
            displayName: "__proto__",
            source: { adapter: "figma" }
          },
          "figma:constructor-key": {
            name: "constructor",
            displayName: "constructor",
            source: { adapter: "figma" }
          }
        }
      }
    ])

    expect(Reflect.get(contract.componentNameIndex ?? {}, "__proto__")).toEqual(["figma:proto-key"])
    expect(contract.componentNameIndex?.constructor).toEqual(["figma:constructor-key"])
  })

  test("opaque punctuation and prototype-like component IDs survive the generated-contract boundary", () => {
    const decomposed = "component/e\u0301"
    const contract = buildWith([
      {
        name: "codebase",
        components: {
          "__proto__.size": codebaseComponent("PrototypeSize", "components/PrototypeSize.tsx"),
          [decomposed]: codebaseComponent("Decomposed", "components/Decomposed.tsx")
        }
      }
    ])

    expect(Object.keys(contract.components)).toEqual(["__proto__.size", decomposed])
    expect(contract.componentNameIndex?.Decomposed).toEqual([decomposed])
  })

  test("generated contracts reject unsafe component IDs without echoing them", () => {
    const unsafeId = "components/safe\u202ehidden"
    let message = ""
    try {
      buildWith([
        {
          name: "codebase",
          components: { [unsafeId]: codebaseComponent("Button", "components/Button.tsx") }
        }
      ])
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain("Generated contract rejected unsafe or oversized machine identifiers")
    expect(message).toContain("components.0.(key)")
    expect(message).not.toContain(unsafeId)
  })

  test("generated contracts fail visibly when a conflict exceeds the durable participant ceiling", () => {
    const codebaseComponents = Object.fromEntries(
      Array.from({ length: 10_000 }, (_, index) => {
        const id = `components/${String(index).padStart(5, "0")}/Button`
        return [
          id,
          {
            ...codebaseComponent("Button", `${id}.tsx`),
            props: { size: { default: "sm" } }
          }
        ]
      })
    ) as ComponentMap

    expect(() =>
      buildWith([
        { name: "codebase", components: codebaseComponents },
        {
          name: "figma",
          components: {
            "figma:button": {
              name: "Button",
              displayName: "Button",
              source: { adapter: "figma" },
              props: { size: { default: "lg" } }
            }
          }
        }
      ])
    ).toThrow("Generated contract rejected unsafe or oversized machine identifiers")
  })

  test("the write boundary rejects a newly unsafe nested ID before replacing the output", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-contract-boundary-"))
    const outputPath = path.join(tempDir, "primitiv.contract.json")
    const builder = new ContractBuilder({ ...config(), output: { path: outputPath } })
    const contract = builder.build([])
    const unsafeId = "figma:button\nconcealed"
    contract.conflicts.push({
      type: "component",
      scope: "cross-source",
      name: "Button.props.size",
      sources: [],
      componentIds: [unsafeId]
    })
    fs.writeFileSync(outputPath, "existing-contract", "utf-8")

    let message = ""
    try {
      builder.save(contract)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    try {
      expect(message).toContain("Contract write rejected unsafe or oversized machine identifiers")
      expect(message).toContain("conflicts.0.componentIds.0")
      expect(message).not.toContain(unsafeId)
      expect(fs.readFileSync(outputPath, "utf-8")).toBe("existing-contract")
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
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

  test("cross-source same-name components are complementary evidence, not unconditional duplicates", () => {
    const figmaCard: Component = { name: "Card", displayName: "Card", source: { adapter: "figma" } }
    const contract = buildWith([
      { name: "codebase", components: { "components/ui/Card": codebaseComponent("Card", "components/ui/Card.tsx") } },
      { name: "figma", components: { "figma:Card": figmaCard } }
    ])
    expect(contract.conflicts).toHaveLength(0)
    expect(contract.componentNameResolutions?.Card).toBe("components/ui/Card")
    expect(contract.components["components/ui/Card"]).toBeDefined()
    expect(contract.components["figma:Card"]).toBeDefined()
  })

  test("cross-source same-name components disagree at an exact structured field path", () => {
    const codeCard: Component = {
      ...codebaseComponent("Card", "components/ui/Card.tsx"),
      props: { size: { default: "md" } }
    }
    const figmaCard: Component = {
      name: "Card",
      displayName: "Card",
      source: { adapter: "figma" },
      props: { size: { default: "lg" } }
    }
    const contract = buildWith([
      { name: "codebase", components: { "components/ui/Card": codeCard } },
      { name: "figma", components: { "figma:Card": figmaCard } }
    ])
    const conflict = contract.conflicts.find((c) => c.type === "component" && c.name === "Card")
    expect(conflict?.fieldPath).toEqual(["props", "size", "default"])
    expect(conflict?.comparison).toBe("exact")
    expect(conflict?.sources.map((source) => source.structuredValue)).toEqual(["md", "lg"])
  })

  test("multiple same-source candidates reconcile only their unanimous complete fields", () => {
    const figmaCard: Component = {
      name: "Card",
      displayName: "Card",
      source: { adapter: "figma" },
      props: { tone: { default: "dark" }, size: { default: "lg" } }
    }
    const contract = buildWith([
      {
        name: "codebase",
        components: {
          "marketing/Card": {
            ...codebaseComponent("Card", "marketing/Card.tsx"),
            props: { tone: { default: "light" }, size: { default: "sm" } }
          },
          "product/Card": {
            ...codebaseComponent("Card", "product/Card.tsx"),
            props: { tone: { default: "light" }, size: { default: "lg" } }
          }
        }
      },
      { name: "figma", components: { "figma:Card": figmaCard } }
    ])
    expect(contract.conflicts).toHaveLength(1)
    expect(contract.conflicts[0].fieldPath).toEqual(["props", "tone", "default"])
    expect(contract.conflicts[0].sources).toHaveLength(3)
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

  test('auto-resolve marks a field conflict with a governed formal value "auto"', () => {
    const figmaCard: Component = {
      name: "Card",
      displayName: "Card",
      source: { adapter: "figma" },
      props: { size: { default: "lg" } }
    }
    const decided = new ContractBuilder(config("codebase", "auto-resolve")).build([
      {
        name: "codebase",
        tokens: emptyTokenMap(),
        components: {
          "components/ui/Card": {
            ...codebaseComponent("Card", "components/ui/Card.tsx"),
            props: { size: { default: "md" } }
          }
        }
      },
      { name: "figma", tokens: emptyTokenMap(), components: { "figma:Card": figmaCard } }
    ])
    const conflict = decided.conflicts.find(
      (candidate) => candidate.fieldPath?.[candidate.fieldPath.length - 1] === "default"
    )
    expect(conflict?.resolution).toBe("auto")
    expect(conflict?.fieldResolution?.structuredValue).toBe("md")
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
    expect(conflict?.sources.map((source) => source.source)).toEqual(
      expect.arrayContaining([
        { adapter: "codebase", file: "a.css", line: 1 },
        { adapter: "codebase", file: "b.css", line: 3 }
      ])
    )
    expect(conflict?.suggestedFix).toContain("labelled source evidence")
    expect(conflict?.suggestedFix).not.toContain("#ffffff")
    expect(conflict?.suggestedFix).not.toContain("#000000")
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
