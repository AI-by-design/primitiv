import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { build, buildContract, loadConfig } from "./index"

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

describe("buildContract — source scan statuses", () => {
  // A port that was just bound and released — connecting to it refuses, which is the
  // cheapest deterministic "remote source is down" a test can produce.
  function unreachablePort(): number {
    const s = Bun.serve({ port: 0, fetch: () => new Response("") })
    const port = s.port
    s.stop(true)
    return port
  }

  function writeSources() {
    fs.writeFileSync(path.join(tempDir, "tokens.css"), ":root { --color-primary: #3b82f6; }")
  }

  function configWith(opts: { sourceOfTruth?: string; storybookExtra?: string; port: number }): string {
    const configPath = path.join(tempDir, "primitiv.config.js")
    fs.writeFileSync(
      configPath,
      `module.exports = {
  sources: {
    codebase: { root: ".", patterns: ["**/*.css"], ignore: ["node_modules/**"] },
    storybook: { url: "http://localhost:${opts.port}"${opts.storybookExtra ?? ""} }
  },
  governance: { sourceOfTruth: "${opts.sourceOfTruth ?? "codebase"}", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}`
    )
    return configPath
  }

  test("a failed optional source is recorded as failed; the build continues and the others read ok/skipped", async () => {
    writeSources()
    const configPath = configWith({ port: unreachablePort() })

    const contract = await buildContract(configPath, { silent: true, cwd: tempDir })

    expect(contract.sourceStatuses?.codebase.status).toBe("ok")
    expect(contract.sourceStatuses?.codebase.tokens).toBe(1)
    expect(contract.sourceStatuses?.storybook.status).toBe("failed")
    expect(contract.sourceStatuses?.storybook.error).toContain("Could not reach Storybook")
    expect(contract.sourceStatuses?.figma.status).toBe("skipped")
    // The build survived: the contract carries the codebase data.
    expect(Object.keys(contract.tokens.colors)).toContain("color-primary")
  })

  test("build exits 0 and still writes the contract when an optional source fails", async () => {
    writeSources()
    const configPath = configWith({ port: unreachablePort() })
    expect(await build(configPath)).toBe(0)
    expect(fs.existsSync(path.join(tempDir, "primitiv.contract.json"))).toBe(true)
  })

  test("hard-fails without writing a contract when the failed source IS governance.sourceOfTruth", async () => {
    writeSources()
    const configPath = configWith({ sourceOfTruth: "storybook", port: unreachablePort() })

    expect(buildContract(configPath, { silent: true, cwd: tempDir })).rejects.toThrow(/sourceOfTruth/)
    expect(fs.existsSync(path.join(tempDir, "primitiv.contract.json"))).toBe(false)
  })

  test("hard-fails when a failed source is marked required (optional: false)", async () => {
    writeSources()
    const configPath = configWith({ port: unreachablePort(), storybookExtra: ", optional: false" })

    expect(buildContract(configPath, { silent: true, cwd: tempDir })).rejects.toThrow(/optional: false/)
    expect(fs.existsSync(path.join(tempDir, "primitiv.contract.json"))).toBe(false)
  })
})
