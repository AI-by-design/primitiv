import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { PrimitivContract, Token } from "./index"
import { build, buildContract, emptyTokenMap, loadConfig, primitivContractSchema, TOKEN_CATEGORIES } from "./index"

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

describe("build — same-source token redefinitions", () => {
  test("a redefined token becomes a pending conflict in the written contract; onConflict error fails the build", async () => {
    fs.writeFileSync(path.join(tempDir, "a.css"), ":root { --color-bg: #ffffff; }")
    fs.writeFileSync(path.join(tempDir, "b.css"), ":root { --color-bg: #000000; }")
    const configBody = (onConflict: string) => `module.exports = {
  sources: { codebase: { root: ".", patterns: ["**/*.css"], ignore: ["node_modules/**"] } },
  governance: { sourceOfTruth: "codebase", onConflict: "${onConflict}" },
  output: { path: "./primitiv.contract.json" }
}`
    const configPath = path.join(tempDir, "primitiv.config.js")

    fs.writeFileSync(configPath, configBody("warn"))
    expect(await build(configPath)).toBe(0)
    const contract = JSON.parse(fs.readFileSync(path.join(tempDir, "primitiv.contract.json"), "utf-8"))
    const conflict = contract.conflicts.find(
      (c: { type: string; name: string }) => c.type === "token" && c.name === "colors.color-bg"
    )
    expect(conflict.resolution).toBe("pending")
    expect(contract.tokens.colors["color-bg"].value).toBe("#ffffff")

    fs.writeFileSync(configPath, configBody("error"))
    expect(await build(configPath)).toBe(2)
  })
})

describe("package root — public type surface", () => {
  // Anti-rot: external consumers (primitiv-pro first) import the contract types and
  // schema from the package root, not from ./types. If a re-export is removed, this
  // file stops compiling (types) or this test fails (schema) before the change ships.
  test("primitivContractSchema is importable from the root and accepts a minimal contract", () => {
    const colors: Record<string, Token> = {}
    const contract: PrimitivContract = {
      version: "0.3.0",
      generatedAt: new Date().toISOString(),
      sources: ["codebase"],
      sourceRoot: "/tmp/project",
      configPath: "/tmp/project/primitiv.config.js",
      tokens: { colors, spacing: {}, typography: {}, borderRadius: {}, shadows: {} },
      components: {},
      conflicts: []
    }
    expect(primitivContractSchema.safeParse(contract).success).toBe(true)
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

    await expect(buildContract(configPath, { silent: true, cwd: tempDir })).rejects.toThrow(/sourceOfTruth/)
    expect(fs.existsSync(path.join(tempDir, "primitiv.contract.json"))).toBe(false)
  })

  test("hard-fails when a failed source is marked required (optional: false)", async () => {
    writeSources()
    const configPath = configWith({ port: unreachablePort(), storybookExtra: ", optional: false" })

    await expect(buildContract(configPath, { silent: true, cwd: tempDir })).rejects.toThrow(/optional: false/)
    expect(fs.existsSync(path.join(tempDir, "primitiv.contract.json"))).toBe(false)
  })
})

describe("package root export surface — token category vocabulary", () => {
  // External consumers (e.g. contract diffing) need the canonical category set from the
  // package root so their fixtures and category walks never drift from the real vocabulary.
  test("exports TOKEN_CATEGORIES and emptyTokenMap, and they agree with each other", () => {
    expect(TOKEN_CATEGORIES.length).toBeGreaterThan(0)
    const map = emptyTokenMap()
    for (const category of TOKEN_CATEGORIES) {
      expect(map[category]).toEqual({})
    }
    expect(Object.keys(map)).toEqual([...TOKEN_CATEGORIES])
  })
})
