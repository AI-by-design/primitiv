import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { loadConfig } from "./index"

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-config-test-"))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeConfig(body: string): void {
  fs.writeFileSync(path.join(tempDir, "primitiv.config.js"), body)
}

describe("loadConfig — boundary validation", () => {
  test("loads a valid config and resolves output.path to absolute", () => {
    writeConfig(`module.exports = {
  sources: { codebase: { root: ".", patterns: ["**/*.css"], ignore: [] } },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}`)
    const config = loadConfig(undefined, tempDir)
    expect(config.governance.sourceOfTruth).toBe("codebase")
    expect(path.isAbsolute(config.output.path)).toBe(true)
  })

  test("throws an actionable error naming the field and the fix when output is missing", () => {
    writeConfig(`module.exports = {
  sources: { codebase: { root: ".", patterns: [], ignore: [] } },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" }
}`)
    let message = ""
    try {
      loadConfig(undefined, tempDir)
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain("Invalid config")
    expect(message).toContain("output")
    expect(message).toContain("primitiv init")
  })

  test("throws when governance.sourceOfTruth is not a known source", () => {
    writeConfig(`module.exports = {
  sources: { codebase: { root: ".", patterns: [], ignore: [] } },
  governance: { sourceOfTruth: "codbase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}`)
    expect(() => loadConfig(undefined, tempDir)).toThrow(/Invalid config/)
  })

  test("keeps unknown/future config fields (looseObject passthrough)", () => {
    writeConfig(`module.exports = {
  sources: { codebase: { root: ".", patterns: [], ignore: [] } },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" },
  experimental: { future: true }
}`)
    const config = loadConfig(undefined, tempDir) as Record<string, unknown>
    expect(config.experimental).toEqual({ future: true })
  })
})
