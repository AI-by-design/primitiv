import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildContract } from "../index"
import type { Conflict, PrimitivContract } from "../types"
import { emptyTokenMap } from "../types"
import { verify } from "./verify"

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-verify-test-"))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeConfig(root: string, patterns: string[] = ["**/*.css"]) {
  const body = `module.exports = {
  sources: {
    codebase: { root: ".", patterns: ${JSON.stringify(patterns)}, ignore: ["node_modules/**"] }
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
    tokens: emptyTokenMap(),
    components: {},
    conflicts: [],
    ...overrides
  }
  fs.writeFileSync(path.join(root, "primitiv.contract.json"), JSON.stringify(contract, null, 2))
}

function rawContract(root: string): Record<string, unknown> {
  return {
    version: "0.1.0",
    generatedAt: new Date().toISOString(),
    sources: ["codebase"],
    sourceRoot: root,
    configPath: path.join(root, "primitiv.config.js"),
    tokens: emptyTokenMap(),
    components: {},
    conflicts: []
  }
}

function writeRawContract(root: string, contract: unknown): void {
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

  test("a changed theme-mode value is reported as drift even when the default is unchanged", async () => {
    fs.writeFileSync(
      path.join(tempDir, "styles.css"),
      `:root { --color-bg: #ffffff; }
.dark { --color-bg: #000000; }`
    )
    writeConfig(tempDir)
    // Committed contract has the same default but a STALE dark-mode value.
    const tokens = emptyTokenMap()
    tokens.colors["color-bg"] = {
      name: "color-bg",
      value: "#ffffff",
      source: { adapter: "codebase", file: "styles.css", line: 1 },
      modes: { dark: "#111111" }
    }
    writeContract(tempDir, { tokens })

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("stale")
    expect(result.drift.changes).toContain("token mode changed: colors.color-bg (dark: #111111 → #000000)")
  })

  test("equivalent default and mode spellings do not make a contract stale", async () => {
    fs.writeFileSync(
      path.join(tempDir, "styles.css"),
      `:root { --color-brand: #ffffff; } .dark { --color-brand: #000000; }`
    )
    writeConfig(tempDir)
    const tokens = emptyTokenMap()
    tokens.colors["color-brand"] = {
      name: "color-brand",
      value: "#fff",
      modes: { dark: "#000" },
      source: { adapter: "codebase", file: "styles.css", line: 1 }
    }
    writeContract(tempDir, { tokens })

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("clean")
    expect(result.drift.changes).toEqual([])
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

describe("verify — hardcoded token values", () => {
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
    expect(result.messages.some((m) => m.includes("use var(--color-destructive)"))).toBe(true)
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

  // A dangling symlink is the stable stand-in for the real race: the glob matches the
  // entry, the stat fails. Deleting a file mid-scan produces the same ENOENT.
  test("counts a file that disappeared after the glob as stale instead of crashing", async () => {
    writeConfig(tempDir)
    writeContract(tempDir)
    fs.symlinkSync(path.join(tempDir, "deleted.css"), path.join(tempDir, "ghost.css"))

    const result = await verify(undefined, { cwd: tempDir, fast: true })
    expect(result.status).toBe("stale")
    expect(result.drift.changes.some((c) => c.includes("ghost.css"))).toBe(true)
  })
})

describe("verify — component identity migration (0.2 → 0.3)", () => {
  function writeTsxConfig(root: string) {
    const body = `module.exports = {
  sources: {
    codebase: { root: ".", patterns: ["**/*.tsx"], ignore: ["node_modules/**"] }
  },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}
`
    fs.writeFileSync(path.join(root, "primitiv.config.js"), body)
  }

  test("re-key recognizer reports bare-name → path-id as a re-key, not remove+add", async () => {
    fs.mkdirSync(path.join(tempDir, "ui"))
    fs.writeFileSync(path.join(tempDir, "ui/Button.tsx"), `export function Button() { return <button /> }`)
    writeTsxConfig(tempDir)
    // A pre-0.3 committed contract: bare-name key, no displayName, no name index.
    writeContract(tempDir, {
      version: "0.2.0",
      components: { Button: { name: "Button", source: { adapter: "codebase", file: "ui/Button.tsx" } } }
    })

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.drift.changes).toContain("component re-keyed: Button → ui/Button")
    expect(result.drift.changes.some((c) => c.startsWith("component removed"))).toBe(false)
    expect(result.drift.changes.some((c) => c.startsWith("component added"))).toBe(false)
  })

  test("same-name coexistence warns but passes — exit stays 0", async () => {
    fs.mkdirSync(path.join(tempDir, "list"))
    fs.mkdirSync(path.join(tempDir, "menu"))
    fs.writeFileSync(path.join(tempDir, "list/Item.tsx"), `export function Item() { return <li /> }`)
    fs.writeFileSync(path.join(tempDir, "menu/Item.tsx"), `export function Item() { return <li /> }`)
    writeTsxConfig(tempDir)
    // Commit a contract that matches a fresh rebuild exactly, so coexistence is the only signal.
    const built = await buildContract(undefined, { cwd: tempDir, silent: true })
    fs.writeFileSync(path.join(tempDir, "primitiv.contract.json"), JSON.stringify(built, null, 2))

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("clean")
    expect(result.exitCode).toBe(0)
    expect(result.messages.some((m) => m.includes("intentional coexistence"))).toBe(true)
  })
})

describe("verify — component relationship drift", () => {
  function writeTsxConfig(root: string) {
    const body = `module.exports = {
  sources: {
    codebase: { root: ".", patterns: ["**/*.tsx"], ignore: ["node_modules/**"] }
  },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}
`
    fs.writeFileSync(path.join(root, "primitiv.config.js"), body)
  }

  async function commitCurrentBuild(): Promise<PrimitivContract> {
    const contract = await buildContract(undefined, { cwd: tempDir, silent: true })
    fs.writeFileSync(path.join(tempDir, "primitiv.contract.json"), JSON.stringify(contract, null, 2))
    return contract
  }

  test("reports added, removed, and count-changed component uses", async () => {
    writeTsxConfig(tempDir)
    fs.writeFileSync(path.join(tempDir, "Child.tsx"), `export function Child() { return <span /> }`)
    fs.writeFileSync(
      path.join(tempDir, "Parent.tsx"),
      `import { Child } from "./Child"; export function Parent() { return <Child /> }`
    )
    await commitCurrentBuild()

    fs.writeFileSync(
      path.join(tempDir, "Parent.tsx"),
      `import { Child } from "./Child"; export function Parent() { return <><Child /><Child /></> }`
    )
    let result = await verify(undefined, { cwd: tempDir })
    expect(result.drift.changes).toContain("component use count changed: Parent → Child (1 → 2)")
    expect(result.status).toBe("stale")

    fs.writeFileSync(
      path.join(tempDir, "Parent.tsx"),
      `import { Child } from "./Child"; export function Parent() { return <span /> }`
    )
    result = await verify(undefined, { cwd: tempDir })
    expect(result.drift.changes).toContain("component use removed: Parent → Child")
  })

  test("reports an added edge and usage-only changes independently", async () => {
    writeTsxConfig(tempDir)
    fs.writeFileSync(path.join(tempDir, "Child.tsx"), `export function Child() { return <span /> }`)
    fs.writeFileSync(path.join(tempDir, "Parent.tsx"), `export function Parent() { return <span /> }`)
    await commitCurrentBuild()

    fs.writeFileSync(
      path.join(tempDir, "Parent.tsx"),
      `import { Child } from "./Child"; export function Parent() { return <Child /> }`
    )
    let result = await verify(undefined, { cwd: tempDir })
    expect(result.drift.changes).toContain("component use added: Parent → Child (1 site)")
    expect(result.drift.changes).toContain("component usage changed: Child (0 → 1 sites)")

    await commitCurrentBuild()
    fs.writeFileSync(
      path.join(tempDir, "Page.tsx"),
      `import { Child } from "./Child"; export function Page() { return <Child /> }`
    )
    result = await verify(undefined, { cwd: tempDir })
    expect(result.drift.changes).toContain("component usage changed: Child (1 → 2 sites)")
    expect(result.drift.changes.some((change) => change.startsWith("component use "))).toBe(false)
  })

  test("treats absent and empty uses as equivalent and keeps fast mode mtime-only", async () => {
    writeTsxConfig(tempDir)
    fs.writeFileSync(path.join(tempDir, "Child.tsx"), `export function Child() { return <span /> }`)
    fs.writeFileSync(path.join(tempDir, "Parent.tsx"), `export function Parent() { return <span /> }`)
    const built = await commitCurrentBuild()
    const committed = JSON.parse(JSON.stringify(built)) as PrimitivContract
    const parent = committed.components.Parent
    if (parent) parent.uses = {}
    fs.writeFileSync(path.join(tempDir, "primitiv.contract.json"), JSON.stringify(committed, null, 2))

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("clean")
    expect(result.drift.changes).toEqual([])

    if (parent) parent.uses = { Child: 99 }
    fs.writeFileSync(path.join(tempDir, "primitiv.contract.json"), JSON.stringify(committed, null, 2))
    const fast = await verify(undefined, { cwd: tempDir, fast: true })
    expect(fast.drift.changes).toEqual([])
  })

  test("does not report relationship drift when both owner and target are re-keyed", async () => {
    fs.mkdirSync(path.join(tempDir, "ui"))
    writeTsxConfig(tempDir)
    fs.writeFileSync(path.join(tempDir, "ui/Child.tsx"), `export function Child() { return <span /> }`)
    fs.writeFileSync(
      path.join(tempDir, "ui/Parent.tsx"),
      `import { Child } from "./Child"; export function Parent() { return <Child /> }`
    )
    const fresh = await buildContract(undefined, { cwd: tempDir, silent: true })
    const committed = JSON.parse(JSON.stringify(fresh)) as PrimitivContract
    const oldComponents: PrimitivContract["components"] = {
      Parent: { ...committed.components["ui/Parent"], uses: { Child: 1 } },
      Child: { ...committed.components["ui/Child"] }
    }
    committed.components = oldComponents
    fs.writeFileSync(path.join(tempDir, "primitiv.contract.json"), JSON.stringify(committed, null, 2))

    const result = await verify(undefined, { cwd: tempDir })
    expect(result.drift.changes).toContain("component re-keyed: Parent → ui/Parent")
    expect(result.drift.changes).toContain("component re-keyed: Child → ui/Child")
    expect(result.drift.changes.some((change) => change.startsWith("component use "))).toBe(false)
    expect(result.drift.changes.some((change) => change.startsWith("component usage "))).toBe(false)
  })
})

describe("verify — failed sources", () => {
  function unreachablePort(): number {
    const s = Bun.serve({ port: 0, fetch: () => new Response("") })
    const port = s.port
    s.stop(true)
    return port
  }

  function writeStorybookConfig(root: string, port: number) {
    const body = `module.exports = {
  sources: {
    codebase: { root: ".", patterns: ["**/*.css"], ignore: ["node_modules/**"] },
    storybook: { url: "http://localhost:${port}" }
  },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}
`
    fs.writeFileSync(path.join(root, "primitiv.config.js"), body)
  }

  function writeFigmaConfig(root: string) {
    fs.writeFileSync(
      path.join(root, "primitiv.config.js"),
      `module.exports = {
  sources: {
    codebase: { root: ".", patterns: ["**/*.css"], ignore: ["node_modules/**"] },
    figma: { token: "test-token", fileId: "demo-file" }
  },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}`
    )
  }

  // A committed contract holding a storybook-sourced component, as a build with a
  // healthy Storybook would have written it.
  function storybookCommit(root: string) {
    writeContract(root, {
      components: {
        "storybook:Button": {
          name: "Button",
          displayName: "Button",
          source: { adapter: "storybook", file: "./Button.stories.tsx" },
          uses: { "storybook:Icon": 2 },
          usage: { sites: 3 }
        }
      },
      componentNameIndex: { Button: ["storybook:Button"] },
      sourceStatuses: {
        codebase: { status: "ok", tokens: 0, components: 0 },
        figma: { status: "skipped" },
        storybook: { status: "ok", tokens: 0, components: 1 }
      }
    })
  }

  test("entries from a source that failed during rebuild are not reported as removed", async () => {
    writeStorybookConfig(tempDir, unreachablePort())
    storybookCommit(tempDir)

    const result = await verify(undefined, { cwd: tempDir })
    // The unreachable Storybook must read as "unknown", not "Button was removed".
    expect(result.drift.changes.some((c) => c.includes("storybook:Button"))).toBe(false)
    expect(result.drift.isStale).toBe(false)
    expect(result.status).toBe("clean")
    expect(result.exitCode).toBe(0)
    expect(result.failedSources).toEqual([{ name: "storybook", error: expect.stringContaining("Storybook") }])
    expect(result.messages.some((m) => m.includes("failed to scan"))).toBe(true)
  })

  test("--strict escalates a failed source to exit 2 (source-scan-failed)", async () => {
    writeStorybookConfig(tempDir, unreachablePort())
    storybookCommit(tempDir)

    const result = await verify(undefined, { cwd: tempDir, strict: true })
    expect(result.status).toBe("source-scan-failed")
    expect(result.exitCode).toBe(2)
  })

  test("a failed Figma source does not report its previously sourced mode as removed", async () => {
    const originalFetch = globalThis.fetch
    try {
      fs.writeFileSync(path.join(tempDir, "tokens.css"), ":root { --color-brand: #fff; }")
      writeFigmaConfig(tempDir)
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = input instanceof Request ? input.url : input.toString()
        if (url.endsWith("/variables/local")) {
          return Response.json({
            meta: {
              variables: {
                brand: {
                  id: "brand",
                  name: "color/brand",
                  resolvedType: "COLOR",
                  variableCollectionId: "collection",
                  valuesByMode: { light: { r: 1, g: 1, b: 1, a: 1 }, dark: { r: 0, g: 0, b: 0, a: 1 } }
                }
              },
              variableCollections: {
                collection: {
                  defaultModeId: "light",
                  modes: [
                    { modeId: "light", name: "Light" },
                    { modeId: "dark", name: "Dark" }
                  ]
                }
              }
            }
          })
        }
        if (url.endsWith("/component_sets")) return Response.json({ meta: { component_sets: [] } })
        return Response.json({ meta: { components: [] } })
      }) as typeof fetch
      const committed = await buildContract(undefined, { cwd: tempDir, silent: true })
      expect(committed.tokens.colors["color-brand"]?.modeSources?.dark?.adapter).toBe("figma")
      fs.writeFileSync(path.join(tempDir, "primitiv.contract.json"), JSON.stringify(committed, null, 2))

      globalThis.fetch = (async () => {
        throw new Error("offline")
      }) as typeof fetch
      const result = await verify(undefined, { cwd: tempDir })
      expect(result.drift.changes.some((change) => change.includes("mode removed"))).toBe(false)
      expect(result.status).toBe("clean")
      expect(result.failedSources).toEqual([{ name: "figma", error: "offline" }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("--fast surfaces failed sources recorded on the committed contract", async () => {
    writeConfig(tempDir)
    writeContract(tempDir, {
      sourceStatuses: {
        codebase: { status: "ok", tokens: 0, components: 0 },
        figma: { status: "failed", error: "Figma API error (403): Forbidden" },
        storybook: { status: "skipped" }
      }
    })

    const result = await verify(undefined, { cwd: tempDir, fast: true })
    expect(result.failedSources).toEqual([{ name: "figma", error: "Figma API error (403): Forbidden" }])
    expect(result.exitCode).toBe(0)

    const strict = await verify(undefined, { cwd: tempDir, fast: true, strict: true })
    expect(strict.status).toBe("source-scan-failed")
    expect(strict.exitCode).toBe(2)
  })
})

describe("verify — invalid contract", () => {
  test("returns invalid-contract (exit 3) when the contract isn't valid JSON", async () => {
    writeConfig(tempDir)
    fs.writeFileSync(path.join(tempDir, "primitiv.contract.json"), "{ not json")
    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("invalid-contract")
    expect(result.exitCode).toBe(3)
    expect(result.messages.join("\n")).toContain("primitiv build")
  })

  test("returns invalid-contract when the contract is valid JSON but missing required fields", async () => {
    writeConfig(tempDir)
    // No conflicts/tokens/components — verify would crash dereferencing `.conflicts.filter()`.
    fs.writeFileSync(path.join(tempDir, "primitiv.contract.json"), JSON.stringify({ version: "1.0.0" }))
    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("invalid-contract")
    expect(result.exitCode).toBe(3)
  })

  test("shared malformed leaves refuse in default and --fast without throwing", async () => {
    writeConfig(tempDir)
    const sharedCases: Array<{
      name: string
      path: string
      mutate: (contract: Record<string, unknown>) => void
    }> = [
      {
        name: "timestamp",
        path: "generatedAt",
        mutate: (contract) => (contract.generatedAt = "not-a-timestamp")
      },
      {
        name: "conflict entry",
        path: "conflicts.0",
        mutate: (contract) => (contract.conflicts = [null])
      },
      {
        name: "pending conflict identity",
        path: "conflicts.0.type",
        mutate: (contract) => (contract.conflicts = [{ resolution: "pending", name: "colors.primary" }])
      },
      {
        name: "pending conflict remediation",
        path: "conflicts.0.suggestedFix",
        mutate: (contract) =>
          (contract.conflicts = [
            { resolution: "pending", type: "token", name: "colors.primary", suggestedFix: ["rebuild"] }
          ])
      },
      {
        name: "component name index",
        path: "componentNameIndex.Button",
        mutate: (contract) => (contract.componentNameIndex = { Button: "components/Button" })
      }
    ]

    for (const testCase of sharedCases) {
      for (const fast of [false, true]) {
        const contract = rawContract(tempDir)
        testCase.mutate(contract)
        writeRawContract(tempDir, contract)

        const result = await verify(undefined, { cwd: tempDir, fast, strict: true, json: true })

        expect(result.status, `${testCase.name} (${fast ? "fast" : "default"})`).toBe("invalid-contract")
        expect(result.exitCode).toBe(3)
        expect(result.messages.join("\n")).toContain(testCase.path)
        expect(result.messages.join("\n")).toContain("primitiv build")
      }
    }
  })

  test("default verification refuses malformed structural-comparison leaves", async () => {
    writeConfig(tempDir)
    const defaultCases: Array<{
      path: string
      mutate: (contract: Record<string, unknown>) => void
    }> = [
      {
        path: "tokens.custom",
        mutate: (contract) => (contract.tokens = { custom: null })
      },
      {
        path: "tokens.custom.brand",
        mutate: (contract) => (contract.tokens = { custom: { brand: null } })
      },
      {
        path: "tokens.custom.brand.value",
        mutate: (contract) => (contract.tokens = { custom: { brand: { value: 42, source: { adapter: "codebase" } } } })
      },
      {
        path: "tokens.custom.brand.modes",
        mutate: (contract) =>
          (contract.tokens = {
            custom: { brand: { value: "#fff", source: { adapter: "codebase" }, modes: "dark" } }
          })
      },
      {
        path: "tokens.custom.brand.source",
        mutate: (contract) => (contract.tokens = { custom: { brand: { value: "#fff", source: "codebase" } } })
      },
      {
        path: "components.Button.source",
        mutate: (contract) => (contract.components = { Button: { name: "Button", source: null } })
      }
    ]

    for (const testCase of defaultCases) {
      const contract = rawContract(tempDir)
      testCase.mutate(contract)
      writeRawContract(tempDir, contract)

      const result = await verify(undefined, { cwd: tempDir })

      expect(result.status).toBe("invalid-contract")
      expect(result.exitCode).toBe(3)
      expect(result.messages.join("\n")).toContain(testCase.path)
    }
  })

  test("default verification accepts valid static relationship counts", async () => {
    writeConfig(tempDir)
    const contract = rawContract(tempDir)
    contract.components = {
      "ui/Button": {
        name: "Button",
        source: { adapter: "codebase", file: "ui/Button.tsx" },
        uses: { "ui/Icon": 2 },
        usage: { sites: 1 }
      }
    }
    writeRawContract(tempDir, contract)

    const result = await verify(undefined, { cwd: tempDir })

    expect(result.status).not.toBe("invalid-contract")
    expect(result.exitCode).not.toBe(3)
  })

  test("default verification accepts legacy components without relationship facts", async () => {
    fs.mkdirSync(path.join(tempDir, "ui"))
    fs.writeFileSync(path.join(tempDir, "ui/Button.tsx"), `export function Button() { return <button /> }`)
    writeConfig(tempDir, ["**/*.tsx"])
    const contract = await buildContract(undefined, { cwd: tempDir, silent: true })
    expect(contract.components["ui/Button"]?.uses).toBeUndefined()
    expect(contract.components["ui/Button"]?.usage).toBeUndefined()
    writeRawContract(tempDir, contract)

    const result = await verify(undefined, { cwd: tempDir })

    expect(result.status).toBe("clean")
    expect(result.exitCode).toBe(0)
    expect(result.drift.isStale).toBe(false)
    expect(result.drift.changes).toEqual([])
  })

  test("default verification accepts an empty uses map for compatibility", async () => {
    writeConfig(tempDir)
    const contract = rawContract(tempDir)
    contract.components = {
      "ui/Button": {
        name: "Button",
        source: { adapter: "codebase", file: "ui/Button.tsx" },
        uses: {}
      }
    }
    writeRawContract(tempDir, contract)

    const result = await verify(undefined, { cwd: tempDir })

    expect(result.status).not.toBe("invalid-contract")
    expect(result.exitCode).not.toBe(3)
  })

  test("default verification refuses malformed static relationship counts", async () => {
    writeConfig(tempDir)
    const invalidCounts: Array<{ name: string; value: unknown }> = [
      { name: "zero", value: 0 },
      { name: "negative", value: -1 },
      { name: "fractional", value: 1.5 },
      { name: "numeric string", value: "2" },
      { name: "null", value: null },
      { name: "object", value: {} },
      { name: "array", value: [] }
    ]
    const relationshipLeaves: Array<{
      path: string
      fields: (value: unknown) => Record<string, unknown>
    }> = [
      {
        path: "components.ui/Button.uses.ui/Icon",
        fields: (value) => ({ uses: { "ui/Icon": value } })
      },
      {
        path: "components.ui/Button.usage.sites",
        fields: (value) => ({ usage: { sites: value } })
      }
    ]

    for (const invalidCount of invalidCounts) {
      for (const leaf of relationshipLeaves) {
        const contract = rawContract(tempDir)
        contract.components = {
          "ui/Button": {
            name: "Button",
            source: { adapter: "codebase", file: "ui/Button.tsx" },
            ...leaf.fields(invalidCount.value)
          }
        }
        writeRawContract(tempDir, contract)

        const result = await verify(undefined, { cwd: tempDir })

        expect(result.status, `${leaf.path} (${invalidCount.name})`).toBe("invalid-contract")
        expect(result.exitCode).toBe(3)
        expect(result.messages.join("\n")).toContain(leaf.path)
        expect(result.messages.join("\n")).toContain("primitiv build")
      }
    }
  })

  test("default verification refuses usage without a site count", async () => {
    writeConfig(tempDir)
    const contract = rawContract(tempDir)
    contract.components = {
      "ui/Button": {
        name: "Button",
        source: { adapter: "codebase", file: "ui/Button.tsx" },
        usage: {}
      }
    }
    writeRawContract(tempDir, contract)

    const result = await verify(undefined, { cwd: tempDir })

    expect(result.status).toBe("invalid-contract")
    expect(result.exitCode).toBe(3)
    expect(result.messages.join("\n")).toContain("components.ui/Button.usage.sites")
  })

  test("--fast does not impose default-only deep token/component validation", async () => {
    writeConfig(tempDir)
    const contract = rawContract(tempDir)
    contract.tokens = { custom: { brand: null } }
    contract.components = { Button: null }
    writeRawContract(tempDir, contract)

    const result = await verify(undefined, { cwd: tempDir, fast: true })

    expect(result.status).toBe("clean")
    expect(result.exitCode).toBe(0)
  })

  test("--fast refuses malformed committed scan health and violations", async () => {
    writeConfig(tempDir)
    const fastCases: Array<{
      path: string
      mutate: (contract: Record<string, unknown>) => void
    }> = [
      {
        path: "sourceStatuses.codebase.status",
        mutate: (contract) => (contract.sourceStatuses = { codebase: { status: "partial" } })
      },
      {
        path: "sourceStatuses.codebase.error",
        mutate: (contract) => (contract.sourceStatuses = { codebase: { status: "failed", error: ["down"] } })
      },
      {
        path: "violations.0.context",
        mutate: (contract) =>
          (contract.violations = [
            {
              type: "token-misuse",
              category: "colors",
              found: "#fff",
              context: 42,
              source: { file: "Button.tsx", line: 1, column: 1 }
            }
          ])
      },
      {
        path: "violations.0.suggestion.token",
        mutate: (contract) =>
          (contract.violations = [
            {
              type: "token-misuse",
              category: "colors",
              found: "#fff",
              context: "bg-[#fff]",
              source: { file: "Button.tsx", line: 1, column: 1 },
              suggestion: { token: null, category: "colors", value: "#fff" }
            }
          ])
      }
    ]

    for (const testCase of fastCases) {
      const contract = rawContract(tempDir)
      testCase.mutate(contract)
      writeRawContract(tempDir, contract)

      const result = await verify(undefined, { cwd: tempDir, fast: true })

      expect(result.status).toBe("invalid-contract")
      expect(result.exitCode).toBe(3)
      expect(result.messages.join("\n")).toContain(testCase.path)
    }
  })

  test("default verification ignores malformed fast-only fields because it rebuilds them", async () => {
    writeConfig(tempDir)
    const contract = rawContract(tempDir)
    contract.sourceStatuses = { codebase: { status: "partial" } }
    contract.violations = [{ context: 42 }]
    writeRawContract(tempDir, contract)

    const result = await verify(undefined, { cwd: tempDir })

    expect(result.status).toBe("clean")
    expect(result.exitCode).toBe(0)
    expect(result.violations.reported).toEqual([])
  })

  test("default verification keeps token provenance optional but validates it when present", async () => {
    writeConfig(tempDir)
    const withoutSource = rawContract(tempDir)
    withoutSource.tokens = { custom: { brand: { value: "#fff" } } }
    writeRawContract(tempDir, withoutSource)
    expect((await verify(undefined, { cwd: tempDir })).status).not.toBe("invalid-contract")

    const malformedSource = rawContract(tempDir)
    malformedSource.tokens = { custom: { brand: { value: "#fff", source: { adapter: "future" } } } }
    writeRawContract(tempDir, malformedSource)
    const result = await verify(undefined, { cwd: tempDir })
    expect(result.status).toBe("invalid-contract")
    expect(result.messages.join("\n")).toContain("tokens.custom.brand.source.adapter")
  })

  test("non-pending conflict identity fields stay opaque because verify never renders them", async () => {
    writeConfig(tempDir)
    const contract = rawContract(tempDir)
    contract.conflicts = [{ resolution: "manual", type: 42, name: null, suggestedFix: ["unused"] }]
    writeRawContract(tempDir, contract)

    const result = await verify(undefined, { cwd: tempDir, fast: true })

    expect(result.status).toBe("clean")
    expect(result.conflicts).toEqual({ total: 1, pending: 0 })
  })
})
