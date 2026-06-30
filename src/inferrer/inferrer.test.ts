import { describe, expect, test } from "bun:test"
import type { Component, ComponentMap, PropDefinition, TokenMap } from "../types"
import { emptyTokenMap } from "../types"
import { inferRules, normalizeRuleCategory } from "./inferrer"

function comp(name: string, props: Record<string, PropDefinition>): Component {
  return { name, displayName: name, source: { adapter: "codebase" }, props }
}

function token(name: string, value: string) {
  return { name, value, source: { adapter: "codebase" as const } }
}

describe("inferRules — category vocabulary", () => {
  // Triggers a color rule (semantic naming) and a border-radius rule (uniform).
  const tokenMap: TokenMap = {
    colors: {
      primary: token("primary", "#3b82f6"),
      secondary: token("secondary", "#64748b"),
      destructive: token("destructive", "#ef4444")
    },
    spacing: {},
    typography: {},
    borderRadius: {
      "radius-sm": token("radius-sm", "4px"),
      "radius-md": token("radius-md", "4px")
    },
    shadows: {}
  }

  test("color rules use the token vocabulary ('colors', not 'color')", () => {
    const { rules } = inferRules(tokenMap, {})
    const colorRule = rules.find((r) => r.id === "color-semantic-naming")
    expect(colorRule).toBeDefined()
    expect(colorRule?.category).toBe("colors")
  })

  test("border-radius rules use the token vocabulary ('borderRadius', not 'border-radius')", () => {
    const { rules } = inferRules(tokenMap, {})
    const radiusRule = rules.find((r) => r.id === "border-radius-uniform")
    expect(radiusRule).toBeDefined()
    expect(radiusRule?.category).toBe("borderRadius")
  })

  test("no rule carries the legacy singular/kebab spelling", () => {
    const { rules } = inferRules(tokenMap, {})
    for (const rule of rules) {
      expect(rule.category).not.toBe("color")
      expect(rule.category).not.toBe("border-radius")
    }
  })
})

describe("normalizeRuleCategory", () => {
  test("maps legacy spellings to the token vocabulary", () => {
    expect(normalizeRuleCategory("color")).toBe("colors")
    expect(normalizeRuleCategory("border-radius")).toBe("borderRadius")
  })

  test("leaves canonical categories unchanged", () => {
    for (const c of ["colors", "borderRadius", "spacing", "typography", "naming", "components"]) {
      expect(normalizeRuleCategory(c)).toBe(c)
    }
  })

  test("leaves unknown categories unchanged (caller decides)", () => {
    expect(normalizeRuleCategory("bogus")).toBe("bogus")
  })
})

describe("inferRules — component prop patterns", () => {
  test("emits the variant-prop rule when >40% of components share a `variant` prop, with evidence", () => {
    const components: ComponentMap = {
      Button: comp("Button", { variant: { type: "string", required: false } }),
      Badge: comp("Badge", { variant: { type: "string", required: false } }),
      Card: comp("Card", {}),
      Icon: comp("Icon", {})
    }
    const { rules } = inferRules(emptyTokenMap(), components)
    const variantRule = rules.find((r) => r.id === "components-variant-prop")
    expect(variantRule).toBeDefined()
    expect(variantRule?.category).toBe("components")
    expect(variantRule?.evidence).toEqual(expect.arrayContaining(["Button", "Badge"]))
  })

  test("does NOT emit the variant rule below the 40% threshold", () => {
    const components: ComponentMap = {
      Button: comp("Button", { variant: { type: "string", required: false } }),
      Card: comp("Card", {}),
      Icon: comp("Icon", {}),
      Box: comp("Box", {}),
      Stack: comp("Stack", {})
    }
    const { rules } = inferRules(emptyTokenMap(), components)
    expect(rules.find((r) => r.id === "components-variant-prop")).toBeUndefined()
  })

  test("emits the disabled-prop rule when >50% of components accept `disabled`", () => {
    const components: ComponentMap = {
      Button: comp("Button", { disabled: { type: "boolean", required: false } }),
      Input: comp("Input", { disabled: { type: "boolean", required: false } }),
      Card: comp("Card", {})
    }
    const { rules } = inferRules(emptyTokenMap(), components)
    expect(rules.find((r) => r.id === "components-disabled-prop")).toBeDefined()
  })

  test("the regression the prop-scoping fix protects: sibling props no longer cross-credit", () => {
    // Pre-fix, every component in a multi-component file inherited the first's props — so one
    // `variant` got credited to all four and inflated the ratio past threshold. With correct
    // per-component props only Card truly has it (1/4 = 25% < 40%), so no false rule fires.
    const components: ComponentMap = {
      Card: comp("Card", { variant: { type: "string", required: false } }),
      CardHeader: comp("CardHeader", {}),
      CardBody: comp("CardBody", {}),
      CardFooter: comp("CardFooter", {})
    }
    const { rules } = inferRules(emptyTokenMap(), components)
    expect(rules.find((r) => r.id === "components-variant-prop")).toBeUndefined()
  })
})
