import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { Conflict, PrimitivContract } from "../types"
import { verify } from "./verify"

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-verify-test-"))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeConfig(root: string) {
  const body = `module.exports = {
  sources: {
    codebase: { root: ".", patterns: ["**/*.css"], ignore: ["node_modules/**"] }
  },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}
`
  fs.writeFileSync(path.join(root, "primitiv.config.js"), body)
}

function writeContract(root: string, overrides: Partial<PrimitivContract> = {}) {
  const contract: PrimitivContract = {
    version: "0.1.0",
    generatedAt: new Date().toISOString(),
    sources: ["codebase"],
    sourceRoot: root,
    configPath: path.join(root, "primitiv.config.js"),
    tokens: { colors: {}, spacing: {}, typography: {}, borderRadius: {}, shadows: {} },
    components: {},
    conflicts: [],
    ...overrides
  }
  fs.writeFileSync(path.join(root, "primitiv.contract.json"), JSON.stringify(contract, null, 2))
}

function pendingConflict(name = "colors.primary"): Conflict {
  return {
    type: "token",
    name,
    sources: [
      { source: { adapter: "codebase" }, value: "#000" },
      { source: { adapter: "figma" }, value: "#fff" }
    ],
    resolution: "pending",
    actionable: true,
    suggestedFix: `Set governance.sourceOfTruth or resolve ${name} manually.`
  }
}

describe("verify", () => {
  test("returns missing-config (exit 3) when no config exists", async () => {
    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("missing-config")
    expect(result.exitCode).toBe(3)
  })

  test("returns missing-contract (exit 3) when config exists but contract does not", async () => {
    writeConfig(tempDir)
    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("missing-contract")
    expect(result.exitCode).toBe(3)
  })

  test("returns clean (exit 0) when contract matches a fresh rebuild", async () => {
    writeConfig(tempDir)
    writeContract(tempDir)
    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("clean")
    expect(result.exitCode).toBe(0)
    expect(result.drift.isStale).toBe(false)
    expect(result.drift.changes).toEqual([])
    expect(result.conflicts.pending).toBe(0)
  })

  test("returns unresolved-conflicts (exit 2) when pending conflicts exist", async () => {
    writeConfig(tempDir)
    writeContract(tempDir, { conflicts: [pendingConflict()] })
    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("unresolved-conflicts")
    expect(result.exitCode).toBe(2)
    expect(result.conflicts.pending).toBe(1)
  })

  test("returns stale (exit 1) when a token in source is missing from the contract", async () => {
    fs.writeFileSync(path.join(tempDir, "styles.css"), ":root { --color-primary: oklch(0.5 0.2 260); }")
    writeConfig(tempDir)
    // Contract has no tokens — a fresh rebuild will find color-primary in the CSS,
    // so the structural diff will report it as added.
    writeContract(tempDir)

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("stale")
    expect(result.exitCode).toBe(1)
    expect(result.drift.isStale).toBe(true)
    expect(result.drift.changes.some((c) => c.includes("color-primary"))).toBe(true)
  })

  test("stale message identifies the specific token that drifted", async () => {
    fs.writeFileSync(path.join(tempDir, "styles.css"), ":root { --color-warning: oklch(0.7 0.18 60); }")
    writeConfig(tempDir)
    writeContract(tempDir)

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.drift.changes).toContain("token added: colors.color-warning")
  })

  test("--strict escalates stale from exit 1 to exit 2", async () => {
    fs.writeFileSync(path.join(tempDir, "styles.css"), ":root { --color-primary: oklch(0.5 0.2 260); }")
    writeConfig(tempDir)
    writeContract(tempDir)

    const result = await verify(undefined, { cwd: tempDir, strict: true })
    expect(result.status).toBe("stale")
    expect(result.exitCode).toBe(2)
  })

  test("unresolved conflicts take priority over staleness", async () => {
    fs.writeFileSync(path.join(tempDir, "styles.css"), ":root { --color-primary: oklch(0.5 0.2 260); }")
    writeConfig(tempDir)
    writeContract(tempDir, { conflicts: [pendingConflict()] })

    const result = await verify(undefined, { cwd: tempDir })
    // Even though both conditions hold, we report the conflict as the primary status.
    expect(result.status).toBe("unresolved-conflicts")
    expect(result.exitCode).toBe(2)
  })

  test("accepts an explicit config path", async () => {
    writeConfig(tempDir)
    writeContract(tempDir)
    const explicit = path.join(tempDir, "primitiv.config.js")
    const result = await verify(explicit, { cwd: "/" })
    expect(result.status).toBe("clean")
    expect(result.exitCode).toBe(0)
  })
})

describe("verify — token misuse violations", () => {
  function writeConfigWithJSX(root: string) {
    const body = `module.exports = {
  sources: {
    codebase: { root: ".", patterns: ["**/*.tsx", "**/*.css"], ignore: ["node_modules/**"] }
  },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}
`
    fs.writeFileSync(path.join(root, "primitiv.config.js"), body)
  }

  test("returns token-misuse-detected (exit 1) when violations exist", async () => {
    writeConfigWithJSX(tempDir)
    fs.writeFileSync(path.join(tempDir, "Button.tsx"), `<button className="bg-[#ff0000]" />`)
    writeContract(tempDir)

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("token-misuse-detected")
    expect(result.exitCode).toBe(1)
    expect(result.violations.total).toBe(1)
    expect(result.violations.reported[0].context).toBe("bg-[#ff0000]")
  })

  test("--strict escalates token-misuse from exit 1 to exit 2", async () => {
    writeConfigWithJSX(tempDir)
    fs.writeFileSync(path.join(tempDir, "Button.tsx"), `<button className="bg-[#ff0000]" />`)
    writeContract(tempDir)

    const result = await verify(undefined, { cwd: tempDir, strict: true })
    expect(result.status).toBe("token-misuse-detected")
    expect(result.exitCode).toBe(2)
  })

  test("conflicts take precedence over violations in reported status", async () => {
    writeConfigWithJSX(tempDir)
    fs.writeFileSync(path.join(tempDir, "Button.tsx"), `<button className="bg-[#ff0000]" />`)
    writeContract(tempDir, { conflicts: [pendingConflict()] })

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("unresolved-conflicts")
    expect(result.exitCode).toBe(2)
    // Violations are still tracked even when conflicts win the status field.
    expect(result.violations.total).toBe(1)
  })

  test("violation message includes smart-match suggestion to a matching token", async () => {
    writeConfigWithJSX(tempDir)
    fs.writeFileSync(path.join(tempDir, "tokens.css"), ":root { --color-destructive: #ff0000; }")
    fs.writeFileSync(path.join(tempDir, "Button.tsx"), `<button className="bg-[#ff0000]" />`)
    writeContract(tempDir, {
      tokens: {
        colors: {
          "color-destructive": {
            name: "color-destructive",
            value: "#ff0000",
            source: { adapter: "codebase", file: "tokens.css", line: 1 }
          }
        },
        spacing: {},
        typography: {},
        borderRadius: {},
        shadows: {}
      }
    })

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("token-misuse-detected")
    expect(result.violations.reported[0].suggestion?.token).toBe("color-destructive")
    expect(result.messages.some((m) => m.includes("use --color-destructive"))).toBe(true)
  })

  test("// primitiv-ignore-next-line suppresses a violation end-to-end", async () => {
    writeConfigWithJSX(tempDir)
    // Use lowercase filename so the scanner's filename-component fallback
    // (Button.tsx → component "Button") doesn't add unrelated drift here.
    fs.writeFileSync(
      path.join(tempDir, "button.tsx"),
      ["// primitiv-ignore-next-line", `<button className="bg-[#ff0000]" />`].join("\n")
    )
    writeContract(tempDir)

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("clean")
    expect(result.violations.total).toBe(0)
  })

  test("legacy contract without violations field doesn't crash (--fast)", async () => {
    writeConfig(tempDir)
    writeContract(tempDir)
    // No violations field on the contract — older Primitiv writes look like this.
    const result = await verify(undefined, { cwd: tempDir, fast: true })
    expect(result.violations.total).toBe(0)
    expect(result.violations.reported).toEqual([])
  })
})

describe("verify --fast (legacy mtime check)", () => {
  test("returns stale when source mtimes are newer than contract.generatedAt", async () => {
    fs.writeFileSync(path.join(tempDir, "styles.css"), ":root { --color-primary: oklch(0.5 0.2 260); }")
    writeConfig(tempDir)
    // Stamp contract one hour in the past so the just-written css is "newer" by mtime.
    const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    writeContract(tempDir, { generatedAt: oldDate })

    const result = await verify(undefined, { cwd: tempDir, fast: true })
    expect(result.status).toBe("stale")
    expect(result.exitCode).toBe(1)
    expect(result.drift.isStale).toBe(true)
    expect(result.drift.changes.some((c) => c.includes("source modified") && c.includes("styles.css"))).toBe(true)
  })

  test("returns clean when no source mtimes exceed contract.generatedAt", async () => {
    writeConfig(tempDir)
    writeContract(tempDir)
    const result = await verify(undefined, { cwd: tempDir, fast: true })
    expect(result.status).toBe("clean")
    expect(result.exitCode).toBe(0)
  })
})
