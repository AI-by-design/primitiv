import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { PrimitivConfig, PrimitivContract, Token } from "../types"
import { lintTokenMisuse } from "./lint"

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-lint-test-"))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeFixture(rel: string, content: string): void {
  const abs = path.join(tempDir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function buildConfig(overrides: { patterns?: string[] } = {}): PrimitivConfig {
  return {
    sources: {
      codebase: {
        root: tempDir,
        patterns: overrides.patterns ?? ["**/*.tsx", "**/*.ts"],
        ignore: ["node_modules", "**/*.test.*"]
      }
    },
    governance: { sourceOfTruth: "codebase", onConflict: "warn" },
    output: { path: path.join(tempDir, "primitiv.contract.json") }
  }
}

interface ContractOpts {
  colorTokens?: Record<string, string>
  spacingTokens?: Record<string, string>
  tokenSourceFile?: string
}

function buildContract(opts: ContractOpts = {}): PrimitivContract {
  const colors: Record<string, Token> = {}
  const spacing: Record<string, Token> = {}
  const sourceFile = opts.tokenSourceFile ?? "tokens.ts"

  for (const [name, value] of Object.entries(opts.colorTokens ?? {})) {
    colors[name] = { name, value, source: { adapter: "codebase", file: sourceFile } }
  }
  for (const [name, value] of Object.entries(opts.spacingTokens ?? {})) {
    spacing[name] = { name, value, source: { adapter: "codebase", file: sourceFile } }
  }

  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    sources: ["codebase"],
    sourceRoot: tempDir,
    configPath: path.join(tempDir, "primitiv.config.js"),
    tokens: { colors, spacing, typography: {}, borderRadius: {}, shadows: {} },
    components: {},
    conflicts: []
  }
}

describe("lintTokenMisuse — colors", () => {
  test("flags hex literals in className arbitrary values", async () => {
    writeFixture("Button.tsx", `export const Button = () => <button className="bg-[#ff0000]" />`)
    const violations = await lintTokenMisuse(buildConfig(), buildContract())
    expect(violations).toHaveLength(1)
    expect(violations[0].category).toBe("colors")
    expect(violations[0].found).toBe("#ff0000")
    expect(violations[0].context).toBe("bg-[#ff0000]")
    expect(violations[0].source.file).toBe("Button.tsx")
  })

  test("flags rgb / hsl / oklch literals", async () => {
    writeFixture(
      "Card.tsx",
      [
        `const a = "border-[rgb(0,0,0)]"`,
        `const b = "ring-[hsl(0,0%,50%)]"`,
        `const c = "text-[oklch(0.6 0.2 30)]"`
      ].join("\n")
    )
    const violations = await lintTokenMisuse(buildConfig(), buildContract())
    expect(violations).toHaveLength(3)
    expect(violations.every((v) => v.category === "colors")).toBe(true)
  })

  test("does not flag var() / --var / theme() references or non-arbitrary classes", async () => {
    writeFixture(
      "OK.tsx",
      [
        `const a = "bg-[var(--color-primary)]"`,
        `const b = "text-[--my-var]"`,
        `const c = "ring-[theme(colors.red.500)]"`,
        `const d = "bg-primary"`
      ].join("\n")
    )
    const violations = await lintTokenMisuse(buildConfig(), buildContract())
    expect(violations).toHaveLength(0)
  })

  test("smart-match suggests the matching token name", async () => {
    writeFixture("Button.tsx", `<button className="bg-[#ff0000]" />`)
    const contract = buildContract({ colorTokens: { destructive: "#ff0000", primary: "#3b82f6" } })
    const violations = await lintTokenMisuse(buildConfig(), contract)
    expect(violations).toHaveLength(1)
    expect(violations[0].suggestion?.token).toBe("destructive")
    expect(violations[0].suggestion?.value).toBe("#ff0000")
  })

  test("no suggestion when no contract token matches the literal", async () => {
    writeFixture("Button.tsx", `<button className="bg-[#abcdef]" />`)
    const contract = buildContract({ colorTokens: { destructive: "#ff0000" } })
    const violations = await lintTokenMisuse(buildConfig(), contract)
    expect(violations).toHaveLength(1)
    expect(violations[0].suggestion).toBeUndefined()
  })

  test("smart-match is case-insensitive on hex", async () => {
    writeFixture("Button.tsx", `<button className="bg-[#FF0000]" />`)
    const contract = buildContract({ colorTokens: { destructive: "#ff0000" } })
    const violations = await lintTokenMisuse(buildConfig(), contract)
    expect(violations[0].suggestion?.token).toBe("destructive")
  })
})

describe("lintTokenMisuse — spacing", () => {
  test("flags px / rem / % literals", async () => {
    writeFixture(
      "Card.tsx",
      [`const a = "p-[7px]"`, `const b = "gap-[12px]"`, `const c = "mt-[1rem]"`, `const d = "w-[100%]"`].join("\n")
    )
    const violations = await lintTokenMisuse(buildConfig(), buildContract())
    expect(violations).toHaveLength(4)
    expect(violations.every((v) => v.category === "spacing")).toBe(true)
  })

  test("does not flag var() or non-arbitrary classes or calc-with-var", async () => {
    writeFixture(
      "OK.tsx",
      [`const a = "p-[var(--spacing-2)]"`, `const b = "p-4"`, `const c = "p-[calc(var(--gap)+2px)]"`].join("\n")
    )
    const violations = await lintTokenMisuse(buildConfig(), buildContract())
    expect(violations).toHaveLength(0)
  })

  test("smart-match suggests matching spacing token", async () => {
    writeFixture("Card.tsx", `<div className="p-[8px]" />`)
    const contract = buildContract({ spacingTokens: { "spacing-2": "8px" } })
    const violations = await lintTokenMisuse(buildConfig(), contract)
    expect(violations).toHaveLength(1)
    expect(violations[0].suggestion?.token).toBe("spacing-2")
  })
})

describe("lintTokenMisuse — exemption", () => {
  test("skips files that define tokens (per source.file)", async () => {
    writeFixture("tokens.ts", `export const colors = { primary: "#ff0000" } // bg-[#ff0000]`)
    writeFixture("Button.tsx", `<button className="bg-[#ff0000]" />`)
    const contract = buildContract({
      colorTokens: { primary: "#ff0000" },
      tokenSourceFile: "tokens.ts"
    })
    const violations = await lintTokenMisuse(buildConfig(), contract)
    expect(violations).toHaveLength(1)
    expect(violations[0].source.file).toBe("Button.tsx")
  })
})

describe("lintTokenMisuse — ignore directive", () => {
  test("skips the violation on the line directly below the directive", async () => {
    writeFixture(
      "Button.tsx",
      [
        "export const Button = () => (",
        "  // primitiv-ignore-next-line",
        '  <button className="bg-[#ff0000]" />',
        ")"
      ].join("\n")
    )
    const violations = await lintTokenMisuse(buildConfig(), buildContract())
    expect(violations).toHaveLength(0)
  })

  test("does NOT skip when the directive is on the same line", async () => {
    writeFixture("Button.tsx", `<button className="bg-[#ff0000]" /> // primitiv-ignore-next-line`)
    const violations = await lintTokenMisuse(buildConfig(), buildContract())
    expect(violations).toHaveLength(1)
  })

  test("directive separated by blank lines still suppresses the next non-blank line", async () => {
    writeFixture(
      "Button.tsx",
      ["// primitiv-ignore-next-line", "", "", '<button className="bg-[#ff0000]" />'].join("\n")
    )
    const violations = await lintTokenMisuse(buildConfig(), buildContract())
    expect(violations).toHaveLength(0)
  })
})

describe("lintTokenMisuse — file scope", () => {
  test("does not scan CSS files (out of MVP scope)", async () => {
    writeFixture("style.css", `.foo { color: #ff0000; }`)
    const config = buildConfig({ patterns: ["**/*.css"] })
    const violations = await lintTokenMisuse(config, buildContract())
    expect(violations).toHaveLength(0)
  })

  test("returns empty when no codebase source is configured", async () => {
    const config: PrimitivConfig = {
      sources: {},
      governance: { sourceOfTruth: "codebase", onConflict: "warn" },
      output: { path: path.join(tempDir, "primitiv.contract.json") }
    }
    const violations = await lintTokenMisuse(config, buildContract())
    expect(violations).toHaveLength(0)
  })
})

describe("lintTokenMisuse — multiple matches per file", () => {
  test("captures violations from the same line and across lines", async () => {
    writeFixture(
      "Button.tsx",
      [`<button className="bg-[#ff0000] text-[#ffffff] p-[7px]" />`, `<div className="border-[#000000]" />`].join("\n")
    )
    const violations = await lintTokenMisuse(buildConfig(), buildContract())
    expect(violations).toHaveLength(4)
    const lines = violations.map((v) => v.source.line).sort()
    expect(lines).toEqual([1, 1, 1, 2])
  })
})
