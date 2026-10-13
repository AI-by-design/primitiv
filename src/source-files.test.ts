import { afterEach, beforeEach, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildContract } from "./index"
import { lintTokenMisuse } from "./lint"
import { CodebaseScanner } from "./scanner"
import type { CodebaseSource, PrimitivConfig } from "./types"
import { emptyTokenMap } from "./types"
import { verify } from "./verify"

let root: string
let config: PrimitivConfig
let configBytes: string
let source: CodebaseSource
const past = new Date(Date.now() - 60_000)
const future = new Date(Date.now() + 60_000)

function write(file: string, content: string, date = past): void {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  fs.utimesSync(target, date, date)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-directory-ignore-"))
  config = {
    sources: {
      codebase: {
        root,
        patterns: ["**/*.css", "**/*.tsx"],
        // Early published init templates used bare directory names.
        ignore: ["node_modules", "dist", "generated/nested/", "**/*.test.tsx", "skip.tsx"]
      }
    },
    governance: { sourceOfTruth: "codebase", onConflict: "warn" },
    output: { path: path.join(root, "primitiv.contract.json") }
  }
  configBytes = `module.exports = ${JSON.stringify(config)}\n`
  const codebase = config.sources.codebase
  if (!codebase) throw new Error("expected fixture codebase source")
  source = codebase
  write("primitiv.config.js", configBytes)
  write("theme.css", ":root { --color-primary: #112233; }")
  write("Button.tsx", "export const Button = () => <button />")
  for (const directory of ["node_modules/dependency", "dist/chunks", "generated/nested"]) {
    write(`${directory}/theme.css`, ":root { --color-dependency: #abcdef; }")
    write(`${directory}/Dependency.tsx`, 'export const Dependency = () => <button className="bg-[#abcdef]" />')
  }
  write("example.test.tsx", 'export const TestOnly = () => <button className="bg-[#abcdef]" />')
  write("skip.tsx", 'export const Skipped = () => <button className="bg-[#abcdef]" />')
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

test("legacy directory ignores exclude descendants from source scanning while file and glob ignores still work", async () => {
  const result = await new CodebaseScanner(source).scan()
  expect(Object.keys(result.components)).toEqual(["Button"])
  expect(Object.keys(result.tokens.colors)).toEqual(["color-primary"])
  expect(source.ignore).toEqual(["node_modules", "dist", "generated/nested/", "**/*.test.tsx", "skip.tsx"])
})

test("legacy directory ignores exclude dependency lint violations but retain consumer violations", async () => {
  write("Button.tsx", 'export const Button = () => <button className="p-[7px]" />')
  const result = await lintTokenMisuse(config, {
    version: "0.3.0",
    generatedAt: new Date().toISOString(),
    sources: ["codebase"],
    tokens: emptyTokenMap(),
    components: {},
    conflicts: []
  })
  expect(result.map((violation) => violation.source.file)).toEqual(["Button.tsx"])
  expect(result[0].found).toBe("7px")
})

test.each([
  false,
  true
])("legacy directory ignores keep verification clean after ignored files change (fast=%s)", async (fast) => {
  const contract = await buildContract(undefined, { cwd: root })
  fs.writeFileSync(path.join(root, "primitiv.contract.json"), JSON.stringify(contract))
  write("node_modules/dependency/theme.css", ":root { --color-dependency: #ff0000; }", future)
  write("node_modules/dependency/Dependency.tsx", 'export const Changed = () => <button className="p-[8px]" />', future)
  const clean = await verify(undefined, { cwd: root, fast })
  expect(clean.status).toBe("clean")
  expect(clean.drift.isStale).toBe(false)
  expect(clean.violations.total).toBe(0)

  write("Button.tsx", 'export const Button = () => <button className="p-[7px]" />')
  if (fast) {
    // Fast verification reads persisted violations instead of rerunning lint.
    const updated = await buildContract(undefined, { cwd: root })
    fs.writeFileSync(path.join(root, "primitiv.contract.json"), JSON.stringify(updated))
  }
  const violation = await verify(undefined, { cwd: root, fast })
  expect(violation.status).toBe("token-misuse-detected")
  expect(violation.violations.reported.map((item) => item.source.file)).toEqual(["Button.tsx"])
  expect(fs.readFileSync(path.join(root, "primitiv.config.js"), "utf8")).toBe(configBytes)
  if (fast) {
    fs.utimesSync(path.join(root, "Button.tsx"), future, future)
    const stale = await verify(undefined, { cwd: root, fast })
    expect(stale.drift.isStale).toBe(true)
    expect(stale.drift.changes.some((change) => change.includes("Button.tsx"))).toBe(true)
    expect(stale.drift.changes.some((change) => change.includes("node_modules"))).toBe(false)
  }
})
