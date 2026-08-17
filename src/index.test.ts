import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { PrimitivContract, Token } from "./index"
import {
  build,
  buildContract,
  emptyTokenMap,
  loadConfig,
  primitivContractSchema,
  TOKEN_CATEGORIES,
  valuesEquivalent
} from "./index"
import { verify } from "./verify/verify"

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

  test("rejects empty Figma mapping keys and values before they can erase or wildcard names", () => {
    writeConfig(`module.exports = {
  sources: {
    figma: {
      token: "test-token",
      fileId: "file123",
      numericUnits: { "": "px" },
      tokenAliases: { "valid-key": "" },
      modeAliases: { "valid-mode": "" }
    }
  },
  governance: { sourceOfTruth: "figma", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}`)
    expect(() => loadConfig(undefined, tempDir)).toThrow(/Invalid config/)
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

describe("build — inferred-rule metadata", () => {
  test("keeps inferred rules identical across repeat builds while retaining the contract freshness timestamp", async () => {
    fs.writeFileSync(
      path.join(tempDir, "tokens.css"),
      ":root { --spacing-sm: 8px; --spacing-md: 16px; --spacing-lg: 24px; }"
    )
    writeConfig(`module.exports = {
  sources: { codebase: { root: ".", patterns: ["**/*.css"], ignore: [] } },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}`)

    const configPath = path.join(tempDir, "primitiv.config.js")
    const contractPath = path.join(tempDir, "primitiv.contract.json")
    expect(await build(configPath)).toBe(0)
    const first = JSON.parse(fs.readFileSync(contractPath, "utf-8"))

    expect(await build(configPath)).toBe(0)
    const second = JSON.parse(fs.readFileSync(contractPath, "utf-8"))
    expect(second.generatedAt).toEqual(expect.any(String))
    expect(second.inferredRules.generatedAt).toBeUndefined()
    expect(second.inferredRules.rules.length).toBeGreaterThan(0)
    expect(second.inferredRules).toEqual(first.inferredRules)
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

  test("primitivContractSchema remains deliberately shallow for external consumers", () => {
    const opaqueNestedValues = {
      version: "0.3.0",
      generatedAt: new Date().toISOString(),
      sources: ["codebase"],
      tokens: { custom: { malformedButOpaqueHere: null } },
      components: { malformedButOpaqueHere: null },
      conflicts: [null]
    }

    expect(primitivContractSchema.safeParse(opaqueNestedValues).success).toBe(true)
  })

  test("valuesEquivalent is importable from the root with its conservative comparison behavior", () => {
    expect(valuesEquivalent("#fff", "#ffffff", "colors")).toBe(true)
    expect(valuesEquivalent("#fff", "#eeeeee", "colors")).toBe(false)
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

describe("build — codebase and Figma integration", () => {
  test("reconciles equivalent CSS and Figma colors without a false conflict", async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      requests.push(url)

      if (url.endsWith("/files/demo-file/variables/local")) {
        return Response.json({
          meta: {
            variables: {
              "VariableID:1": {
                id: "VariableID:1",
                key: "stable-variable-key",
                name: "color/primary",
                resolvedType: "COLOR",
                variableCollectionId: "VariableCollectionId:1",
                valuesByMode: {
                  "1:0": { r: 1, g: 1, b: 1, a: 1 },
                  "1:1": { r: 0, g: 0, b: 0, a: 1 }
                }
              }
            },
            variableCollections: {
              "VariableCollectionId:1": {
                name: "Foundation",
                defaultModeId: "1:0",
                modes: [
                  { modeId: "1:0", name: "Light" },
                  { modeId: "1:1", name: "Dark" }
                ]
              }
            }
          }
        })
      }

      if (url.endsWith("/files/demo-file/components")) return Response.json({ meta: { components: [] } })
      return new Response("Not found", { status: 404, statusText: "Not Found" })
    }) as typeof fetch

    try {
      fs.writeFileSync(
        path.join(tempDir, "tokens.css"),
        ":root { --color-primary: #fff; } .dark { --color-primary: #000; }"
      )
      const configPath = path.join(tempDir, "primitiv.config.js")
      fs.writeFileSync(
        configPath,
        `module.exports = {
  sources: {
    codebase: { root: ".", patterns: ["**/*.css"], ignore: ["node_modules/**"] },
    figma: { token: "test-token", fileId: "demo-file" }
  },
  governance: { sourceOfTruth: "codebase", onConflict: "error" },
  output: { path: "./primitiv.contract.json" }
}`
      )

      expect(await build(configPath)).toBe(0)
      const contract = JSON.parse(fs.readFileSync(path.join(tempDir, "primitiv.contract.json"), "utf-8"))
      expect(contract.sourceStatuses.figma).toMatchObject({ status: "ok", tokens: 1, components: 0 })
      expect(contract.tokens.colors["color-primary"].value).toBe("#fff")
      expect(contract.tokens.colors["color-primary"].modes).toEqual({ dark: "#000" })
      expect(contract.tokens.colors["color-primary"].modeSources.dark.adapter).toBe("codebase")
      expect(contract.conflicts).toEqual([])
      expect((await verify(configPath, { cwd: tempDir })).status).toBe("clean")
      expect(requests).toEqual(
        expect.arrayContaining([
          "https://api.figma.com/v1/files/demo-file/variables/local",
          "https://api.figma.com/v1/files/demo-file/components"
        ])
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("records a timed-out Figma scan without discarding the codebase contract", async () => {
    const originalFetch = globalThis.fetch
    const originalTimeout = AbortSignal.timeout
    const requests: Array<{ url: string; signal?: AbortSignal | null }> = []
    // The production policy remains 30 seconds. Shorten it only inside this end-to-end fixture
    // so it proves build-level failure isolation without making the suite wait half a minute.
    Object.defineProperty(AbortSignal, "timeout", {
      value: (_ms: number) => originalTimeout(10),
      configurable: true,
      writable: true
    })
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      requests.push({ url, signal: init?.signal })
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
      })
    }) as typeof fetch

    try {
      fs.writeFileSync(path.join(tempDir, "tokens.css"), ":root { --color-primary: #fff; }")
      const configPath = path.join(tempDir, "primitiv.config.js")
      fs.writeFileSync(
        configPath,
        `module.exports = {
  sources: {
    codebase: { root: ".", patterns: ["**/*.css"], ignore: ["node_modules/**"] },
    figma: { token: "test-token", fileId: "demo-file" }
  },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}`
      )

      expect(await build(configPath)).toBe(0)
      // Promise.all reports the first timeout immediately; allow the second endpoint's signal
      // to fire before proving both requests were independently bounded.
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      const contract = JSON.parse(fs.readFileSync(path.join(tempDir, "primitiv.contract.json"), "utf-8"))
      expect(contract.tokens.colors["color-primary"].value).toBe("#fff")
      expect(contract.sourceStatuses.figma).toEqual({
        status: "failed",
        error: "Figma API request timed out after 30000ms. Check your network connection and try again."
      })
      expect(requests.map((request) => request.url)).toEqual(
        expect.arrayContaining([
          "https://api.figma.com/v1/files/demo-file/variables/local",
          "https://api.figma.com/v1/files/demo-file/components"
        ])
      )
      expect(requests.every((request) => request.signal?.aborted)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(AbortSignal, "timeout", {
        value: originalTimeout,
        configurable: true,
        writable: true
      })
    }
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
