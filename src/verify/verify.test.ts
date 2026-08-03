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
    tokens: emptyTokenMap(),
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

  // A committed contract holding a storybook-sourced component, as a build with a
  // healthy Storybook would have written it.
  function storybookCommit(root: string) {
    writeContract(root, {
      components: {
        "storybook:Button": {
          name: "Button",
          displayName: "Button",
          source: { adapter: "storybook", file: "./Button.stories.tsx" }
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
})
