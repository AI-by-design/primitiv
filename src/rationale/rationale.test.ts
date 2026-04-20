import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { ComponentMap, PrimitivConfig, TokenMap } from "../types"
import { applyRationale, loadRationale } from "./rationale"

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
