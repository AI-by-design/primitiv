import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { type BuildContractOptions, buildContract, loadConfig } from "./index"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-data-only-"))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function config() {
  return {
    sources: { codebase: { root: ".", patterns: ["tokens.css", "Button.tsx"], ignore: [] } },
    governance: { sourceOfTruth: "codebase", onConflict: "warn" },
    output: { path: "primitiv.contract.json" }
  }
}

function writeJson(value: unknown = config(), filename = "primitiv.config.json") {
  fs.writeFileSync(path.join(root, filename), JSON.stringify(value))
}

function buildJson(configPath?: string) {
  return buildContract(configPath, { configMode: "data-only", cwd: root, silent: true })
}

describe("buildContract data-only config policy", () => {
  test("invalid runtime mode refuses executable fallback", async () => {
    fs.writeFileSync(
      path.join(root, "primitiv.config.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "executed"))}, "yes"); module.exports = ${JSON.stringify(config())}`
    )
    for (const configMode of ["invalid", null]) {
      const options = { configMode, cwd: root, silent: true } as unknown as BuildContractOptions
      await expect(buildContract(undefined, options)).rejects.toThrow(/Invalid configMode/)
    }
    expect(fs.existsSync(path.join(root, "executed"))).toBe(false)
  })
  test("rejects explicit executable configuration before any side effect", async () => {
    fs.writeFileSync(
      path.join(root, "primitiv.config.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "executed"))}, "yes"); module.exports = ${JSON.stringify(config())}`
    )
    await expect(buildJson("primitiv.config.js")).rejects.toThrow(/Convert the config to strict JSON/)
    expect(fs.existsSync(path.join(root, "executed"))).toBe(false)
  })

  test("missing default JSON refuses fallback to existing JS", async () => {
    fs.writeFileSync(
      path.join(root, "primitiv.config.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "executed"))}, "yes"); module.exports = ${JSON.stringify(config())}`
    )
    await expect(buildJson()).rejects.toThrow(/Data-only config not found.*primitiv.config.json/)
    expect(fs.existsSync(path.join(root, "executed"))).toBe(false)
  })

  test("JSON symlink to JavaScript refuses execution", async () => {
    fs.writeFileSync(
      path.join(root, "unsafe.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "executed"))}, "yes"); module.exports = ${JSON.stringify(config())}`
    )
    fs.symlinkSync("unsafe.js", path.join(root, "primitiv.config.json"))
    await expect(buildJson()).rejects.toThrow(/resolves to a non-JSON file/)
    expect(fs.existsSync(path.join(root, "executed"))).toBe(false)
  })

  test("executable text disguised as JSON is parsed and rejected without executing", async () => {
    fs.writeFileSync(
      path.join(root, "primitiv.config.json"),
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "executed"))}, "yes")`
    )
    await expect(buildJson()).rejects.toThrow(/Invalid JSON config/)
    expect(fs.existsSync(path.join(root, "executed"))).toBe(false)
  })

  test("valid JSON and legacy JS extract equivalent data with static component scanning", async () => {
    writeJson()
    fs.writeFileSync(path.join(root, "primitiv.config.js"), `module.exports = ${JSON.stringify(config())}`)
    fs.writeFileSync(path.join(root, "tokens.css"), ":root { --color-primary: #123456; }")
    fs.writeFileSync(
      path.join(root, "Button.tsx"),
      `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(root, "component-executed"))}, "yes"); export function Button(props: { label: string }) { return <button>{props.label}</button> }`
    )
    const json = await buildJson()
    const legacy = await buildContract(undefined, { cwd: root, silent: true })
    expect(json.tokens).toEqual(legacy.tokens)
    expect(json.components).toEqual(legacy.components)
    expect(Object.keys(json.components).length).toBeGreaterThan(0)
    expect(json.sourceStatuses).toEqual(legacy.sourceStatuses)
    expect(json.configPath).toBe(path.join(root, "primitiv.config.json"))
    expect(fs.existsSync(path.join(root, "component-executed"))).toBe(false)
  })

  test("nested config paths preserve relative root and guidance path semantics", async () => {
    fs.mkdirSync(path.join(root, "nested"))
    const value = config()
    value.sources.codebase.root = ".."
    writeJson({ ...value, rationale: { path: "notes.json" } }, "nested/config.json")
    fs.writeFileSync(
      path.join(root, "nested/notes.json"),
      JSON.stringify({ tokens: { "colors.color-primary": { why: "nested guidance" } } })
    )
    fs.writeFileSync(path.join(root, "tokens.css"), ":root { --color-primary: #123456; }")
    const result = await buildJson("nested/config.json")
    expect(result.sourceRoot).toBe(path.join(root, "nested"))
    expect(result.configPath).toBe(path.join(root, "nested/config.json"))
    expect(result.sourceStatuses?.codebase.status).toBe("ok")
    expect(result.tokens.colors["color-primary"]?.value).toBe("#123456")
    expect(result.tokens.colors["color-primary"]?.rationale?.why).toBe("nested guidance")
  })

  test("malformed JSON and schema-invalid JSON fail boundary validation", async () => {
    fs.writeFileSync(path.join(root, "primitiv.config.json"), '{"sources": {},}')
    await expect(buildJson()).rejects.toThrow(/Invalid JSON config/)
    writeJson({ sources: {} })
    await expect(buildJson()).rejects.toThrow(/Invalid config/)
  })

  test("changed JSON config is reloaded on every build", async () => {
    fs.writeFileSync(path.join(root, "tokens.css"), ":root { --color-primary: #123456; }")
    writeJson()
    expect((await buildJson()).tokens.colors["color-primary"]?.value).toBe("#123456")
    const next = config()
    next.sources.codebase.patterns = ["other.css"]
    fs.writeFileSync(path.join(root, "other.css"), ":root { --color-primary: #abcdef; }")
    writeJson(next)
    expect((await buildJson()).tokens.colors["color-primary"]?.value).toBe("#abcdef")
  })

  test.skipIf(process.platform === "win32")("a JSON-named FIFO is rejected without blocking", () => {
    const fifo = path.join(root, "primitiv.config.json")
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0)
    const script = `const { buildContract } = require(${JSON.stringify(path.join(__dirname, "index.ts"))});
      buildContract(undefined, { configMode: "data-only", cwd: ${JSON.stringify(root)}, silent: true })
        .then(() => process.exit(1), error => { console.log(error.message); process.exit(0) });`
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 3000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain("must be a regular JSON file")
  })

  test("oversized JSON is rejected before parsing", async () => {
    fs.writeFileSync(path.join(root, "primitiv.config.json"), " ".repeat(1024 * 1024 + 1))
    await expect(buildJson()).rejects.toThrow(/1048576-byte limit/)
  })

  test("default local JavaScript loading retains execution and path resolution", () => {
    fs.writeFileSync(
      path.join(root, "primitiv.config.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "executed"))}, "yes"); module.exports = ${JSON.stringify(config())}`
    )
    expect(loadConfig(undefined, root).output.path).toBe(path.join(root, "primitiv.contract.json"))
    expect(fs.existsSync(path.join(root, "executed"))).toBe(true)
  })
})
