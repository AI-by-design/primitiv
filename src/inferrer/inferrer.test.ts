import { describe, expect, test } from "bun:test"
import type { TokenMap } from "../types"
import { inferRules, normalizeRuleCategory } from "./inferrer"

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
