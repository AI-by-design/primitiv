import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ComponentMap, PrimitivConfig, TokenMap } from "../types"
import { applyRationale, loadRationale, loadRationaleLayers } from "./rationale"

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-rationale-test-"))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function baseConfig(overrides: Partial<PrimitivConfig> = {}): PrimitivConfig {
  return {
    sources: { codebase: { root: ".", patterns: ["**/*.css"], ignore: [] } },
    governance: { sourceOfTruth: "codebase", onConflict: "warn" },
    output: { path: "./primitiv.contract.json" },
    ...overrides
  }
}

function seededTokens(): TokenMap {
  return {
    colors: {
      primary: { name: "primary", value: "#1d4ed8", source: { adapter: "codebase" } },
      neutral: { name: "neutral", value: "#737373", source: { adapter: "codebase" } }
    },
    spacing: {
      sm: { name: "sm", value: "4px", source: { adapter: "codebase" } }
    },
    typography: {},
    borderRadius: {},
    shadows: {}
  }
}

function seededComponents(): ComponentMap {
  return {
    Button: { name: "Button", source: { adapter: "codebase" } },
    Card: { name: "Card", source: { adapter: "codebase" } }
  }
}

describe("loadRationale", () => {
  test("returns empty RationaleMap when no sidecar and no inline", () => {
    const result = loadRationale(baseConfig(), tempDir)
    expect(result.tokens).toEqual({})
    expect(result.components).toEqual({})
  })

  test("loads sidecar YAML from default path", () => {
    fs.writeFileSync(
      path.join(tempDir, "primitiv.rationale.yml"),
      `tokens:
  colors.primary:
    why: Brand primary
    when: CTAs and active states
components:
  Button:
    why: Unified clickable entry
`
    )
    const result = loadRationale(baseConfig(), tempDir)
    expect(result.tokens?.["colors.primary"]?.why).toBe("Brand primary")
    expect(result.tokens?.["colors.primary"]?.when).toBe("CTAs and active states")
    expect(result.components?.Button?.why).toBe("Unified clickable entry")
  })

  test("loads sidecar from config-specified path", () => {
    fs.mkdirSync(path.join(tempDir, "docs"))
    fs.writeFileSync(
      path.join(tempDir, "docs/rationale.yml"),
      `tokens:
  spacing.sm:
    why: Tight default spacing
`
    )
    const result = loadRationale(baseConfig({ rationale: { path: "docs/rationale.yml" } }), tempDir)
    expect(result.tokens?.["spacing.sm"]?.why).toBe("Tight default spacing")
  })

  test("inline rationale overrides sidecar for the same key", () => {
    fs.writeFileSync(
      path.join(tempDir, "primitiv.rationale.yml"),
      `tokens:
  colors.primary:
    why: From sidecar
`
    )
    const result = loadRationale(
      baseConfig({
        rationale: {
          inline: { tokens: { "colors.primary": { why: "From inline" } } }
        }
      }),
      tempDir
    )
    expect(result.tokens?.["colors.primary"]?.why).toBe("From inline")
  })

  test("malformed YAML surfaces a stderr warning and returns empty rationale", () => {
    fs.writeFileSync(path.join(tempDir, "primitiv.rationale.yml"), "tokens:\n  - not a map\n    why: :::")
    // We don't assert on stderr content here, just that the loader doesn't throw and returns a safe shape.
    const result = loadRationale(baseConfig(), tempDir)
    expect(result.tokens).toEqual({})
    expect(result.components).toEqual({})
  })
})

describe("applyRationale", () => {
  test("attaches rationale to tokens by dotted key", () => {
    const tokens = seededTokens()
    const components = seededComponents()
    applyRationale(tokens, components, {
      tokens: {
        "colors.primary": { why: "Brand primary", when: "CTAs" }
      }
    })
    expect(tokens.colors.primary.rationale?.why).toBe("Brand primary")
    expect(tokens.colors.primary.rationale?.when).toBe("CTAs")
    // neutral wasn't in rationale — untouched.
    expect(tokens.colors.neutral.rationale).toBeUndefined()
  })

  test("attaches rationale to components by name", () => {
    const tokens = seededTokens()
    const components = seededComponents()
    applyRationale(tokens, components, {
      components: {
        Button: { why: "Primary click target", deprecated: false }
      }
    })
    expect(components.Button.rationale?.why).toBe("Primary click target")
    expect(components.Card.rationale).toBeUndefined()
  })

  test("silently ignores rationale for tokens/components that don't exist", () => {
    const tokens = seededTokens()
    const components = seededComponents()
    applyRationale(tokens, components, {
      tokens: { "colors.missing": { why: "not present" } },
      components: { NotAComponent: { why: "nope" } }
    })
    // No throw, nothing attached.
    expect(tokens.colors.primary.rationale).toBeUndefined()
    expect(components.Button.rationale).toBeUndefined()
  })

  test("keys without a category separator are skipped", () => {
    const tokens = seededTokens()
    const components = seededComponents()
    applyRationale(tokens, components, {
      tokens: { primary: { why: "missing category" } }
    })
    expect(tokens.colors.primary.rationale).toBeUndefined()
  })
})

describe("resolved rationale source precedence", () => {
  for (const inlineKey of ["ui/Card", "Card"]) {
    for (const reverse of [false, true]) {
      test(`inline ${inlineKey} wins after binding with sidecar order reversed=${reverse}`, () => {
        const keys = reverse ? ["Card", "ui/Card"] : ["ui/Card", "Card"]
        const sidecar = Object.fromEntries(keys.map((key) => [key, { why: `sidecar ${key}`, when: "sidecar only" }]))
        fs.writeFileSync(path.join(tempDir, "primitiv.rationale.yml"), JSON.stringify({ components: sidecar }))
        const config = baseConfig({ rationale: { inline: { components: { [inlineKey]: { why: "inline" } } } } })
        const components: ComponentMap = { "ui/Card": { name: "Card", source: { adapter: "codebase" } } }

        const warnings = loadRationaleLayers(config, tempDir).flatMap((layer) =>
          applyRationale(seededTokens(), components, layer)
        )

        expect(warnings).toEqual([])
        expect(components["ui/Card"].rationale).toEqual({ why: "inline" })
      })
    }
  }

  test("an ambiguous inline name does not replace qualified sidecar guidance", () => {
    fs.writeFileSync(
      path.join(tempDir, "primitiv.rationale.yml"),
      JSON.stringify({ components: { "ui/Card": { why: "qualified" } } })
    )
    const components: ComponentMap = {
      "ui/Card": { name: "Card", source: { adapter: "codebase" } },
      "marketing/Card": { name: "Card", source: { adapter: "codebase" } }
    }
    const config = baseConfig({ rationale: { inline: { components: { Card: { why: "ambiguous" } } } } })
    const warnings = loadRationaleLayers(config, tempDir).flatMap((layer) =>
      applyRationale(seededTokens(), components, layer)
    )

    expect(components["ui/Card"].rationale).toEqual({ why: "qualified" })
    expect(components["marketing/Card"].rationale).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain("matches 2 components")
    expect(warnings[0]).toContain("Qualify it with a component id")
  })

  test("configured JSON keeps token whole-entry replacement and binds component aliases", () => {
    fs.writeFileSync(
      path.join(tempDir, "guidance.json"),
      JSON.stringify({
        tokens: { "colors.primary": { why: "sidecar", when: "sidecar only" } },
        components: { Card: { why: "sidecar" } }
      })
    )
    const tokens = seededTokens()
    const components: ComponentMap = { "ui/Card": { name: "Card", source: { adapter: "codebase" } } }
    const config = baseConfig({
      rationale: {
        path: "guidance.json",
        inline: {
          tokens: { "colors.primary": { when: "inline" } },
          components: { "ui/Card": { when: "inline" } }
        }
      }
    })
    for (const layer of loadRationaleLayers(config, tempDir)) applyRationale(tokens, components, layer)

    expect(tokens.colors.primary.rationale).toEqual({ when: "inline" })
    expect(components["ui/Card"].rationale).toEqual({ when: "inline" })
  })
})

describe("own-key rationale binding", () => {
  for (const name of ["constructor", "__proto__", "toString"]) {
    test(`indexes and binds the legitimate display name ${name}`, () => {
      const components: ComponentMap = { "ui/Special": { name, source: { adapter: "codebase" } } }
      expect(applyRationale(seededTokens(), components, { components: {} })).toEqual([])
      expect(applyRationale(seededTokens(), components, { components: { [name]: { why: name } } })).toEqual([])
      expect(components["ui/Special"].rationale).toEqual({ why: name })
    })

    test(`does not bind an inherited ${name} key as a component`, () => {
      const inherited: ComponentMap = { [name]: { name: "Inherited", source: { adapter: "codebase" } } }
      const components: ComponentMap = Object.assign(Object.create(inherited), seededComponents())
      expect(applyRationale(seededTokens(), components, { components: { [name]: { why: "unknown" } } })).toEqual([])
      expect(inherited[name].rationale).toBeUndefined()
      expect(components.Card.rationale).toBeUndefined()
    })

    test(`binds a legitimate exact ${name} component ID`, () => {
      const components: ComponentMap = {
        [name]: { name: "Special", source: { adapter: "codebase" } },
        "ui/Other": { name, source: { adapter: "codebase" } }
      }
      applyRationale(seededTokens(), components, { components: { [name]: { why: "exact ID" } } })
      expect(components[name].rationale).toEqual({ why: "exact ID" })
      expect(components["ui/Other"].rationale).toBeUndefined()
    })
  }

  test("does not mutate inherited token categories or token names", () => {
    const inheritedToken: TokenMap["colors"][string] = {
      name: "inherited",
      value: "#000",
      source: { adapter: "codebase" }
    }
    const tokens = seededTokens()
    tokens.colors = Object.assign(Object.create({ inherited: inheritedToken }), tokens.colors)
    const withInheritedCategory: TokenMap = Object.assign(
      Object.create({ inherited: { token: inheritedToken } }),
      tokens
    )

    applyRationale(withInheritedCategory, seededComponents(), {
      tokens: { "colors.inherited": { why: "unknown" }, "inherited.token": { why: "unknown" } }
    })

    expect(inheritedToken.rationale).toBeUndefined()
  })
})
