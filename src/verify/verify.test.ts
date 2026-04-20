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

  test("returns clean (exit 0) when contract is fresh and conflict-free", async () => {
    writeConfig(tempDir)
    writeContract(tempDir)
    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("clean")
    expect(result.exitCode).toBe(0)
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

  test("returns stale (exit 1) when source files are newer than the contract", async () => {
    fs.writeFileSync(path.join(tempDir, "styles.css"), ":root { --color-primary: #000 }")
    writeConfig(tempDir)
    // Contract stamped one hour in the past so the just-written css is "newer".
    const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    writeContract(tempDir, { generatedAt: oldDate })

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("stale")
    expect(result.exitCode).toBe(1)
    expect(result.staleness.contractOlderThanSources).toBe(true)
    expect(result.staleness.sampleNewerFiles).toContain("styles.css")
  })

  test("--strict escalates stale from exit 1 to exit 2", async () => {
    fs.writeFileSync(path.join(tempDir, "styles.css"), ":root { --color-primary: #000 }")
    writeConfig(tempDir)
    const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    writeContract(tempDir, { generatedAt: oldDate })

    const result = await verify(undefined, { cwd: tempDir, strict: true })
    expect(result.status).toBe("stale")
    expect(result.exitCode).toBe(2)
  })

  test("unresolved conflicts take priority over staleness", async () => {
    fs.writeFileSync(path.join(tempDir, "styles.css"), ":root { --color-primary: #000 }")
    writeConfig(tempDir)
    const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    writeContract(tempDir, {
      generatedAt: oldDate,
      conflicts: [pendingConflict()]
    })

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
