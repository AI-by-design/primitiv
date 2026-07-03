import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { build, loadConfig } from "./index"

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

describe("build — onConflict exit codes", () => {
  // Anti-rot: one fixture with a real cross-source conflict (codebase Button vs a
  // stubbed Storybook Button), built under "error" then "warn" — the exit codes must
  // differ, or the onConflict wiring has gone inert again.
  test('"error" exits 2 on a pending conflict and still writes the contract; "warn" exits 0 on the same fixture', async () => {
    const manifest = {
      entries: {
        "components-button--default": {
          type: "story",
          id: "components-button--default",
          title: "Components/Button",
          name: "Default",
          importPath: "./Button.stories.tsx"
        }
      }
    }
    const server = Bun.serve({ port: 0, fetch: () => Response.json(manifest) })
    try {
      fs.writeFileSync(
        path.join(tempDir, "Button.tsx"),
        `export function Button({ label }: { label: string }) {\n  return <button>{label}</button>\n}\n`
      )
      const configBody = (onConflict: string) => `module.exports = {
  sources: {
    codebase: { root: ".", patterns: ["**/*.tsx"], ignore: ["node_modules/**"] },
    storybook: { url: "http://localhost:${server.port}" }
  },
  governance: { sourceOfTruth: "codebase", onConflict: "${onConflict}" },
  output: { path: "./primitiv.contract.json" }
}`
      const configPath = path.join(tempDir, "primitiv.config.js")
      const contractPath = path.join(tempDir, "primitiv.contract.json")

      fs.writeFileSync(configPath, configBody("error"))
      expect(await build(configPath)).toBe(2)
      // Failing the build never withholds the artifact that explains the failure.
      expect(fs.existsSync(contractPath)).toBe(true)

      fs.writeFileSync(configPath, configBody("warn"))
      expect(await build(configPath)).toBe(0)
    } finally {
      server.stop()
    }
  })
})
