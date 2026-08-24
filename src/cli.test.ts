import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import pkg from "../package.json"

const CLI = path.join(__dirname, "cli.ts")

// Spawned rather than imported: cli.ts runs main() on load, so importing it would
// execute a command instead of exercising one.
function runCli(...args: string[]): string {
  return execFileSync("bun", [CLI, ...args], { encoding: "utf-8" })
}

describe("primitiv --version", () => {
  test("prints the version from the package manifest", () => {
    expect(runCli("--version").trim()).toBe(pkg.version)
  })

  test("-v and the bare `version` command print the same thing", () => {
    expect(runCli("-v").trim()).toBe(pkg.version)
    expect(runCli("version").trim()).toBe(pkg.version)
  })

  test("an unrecognized command still prints usage", () => {
    expect(runCli("nonsense")).toContain("Usage:")
  })
})

describe("primitiv build — command-line integration", () => {
  test("writes deterministic JSX component relationships to the contract", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-cli-relationships-e2e-"))
    const contractPath = path.join(tempDir, "primitiv.contract.json")

    try {
      fs.writeFileSync(path.join(tempDir, "Button.tsx"), `export function Button() { return <button type="button" /> }`)
      fs.writeFileSync(
        path.join(tempDir, "SplitButton.tsx"),
        `import { Button } from "./Button"

export function SplitButton() {
  return <><Button /><Button /></>
}`
      )
      fs.writeFileSync(
        path.join(tempDir, "primitiv.config.js"),
        `module.exports = {
  sources: { codebase: { root: ".", patterns: ["**/*.tsx"], ignore: ["node_modules/**"] } },
  governance: { sourceOfTruth: "codebase", onConflict: "error" },
  output: { path: "./primitiv.contract.json" }
}`
      )

      execFileSync("bun", [CLI, "build"], { cwd: tempDir, encoding: "utf-8" })
      const firstContract = JSON.parse(fs.readFileSync(contractPath, "utf-8"))

      expect(firstContract.components.SplitButton.uses.Button).toBe(2)
      expect(firstContract.components.Button.usage.sites).toBe(2)

      execFileSync("bun", [CLI, "build"], { cwd: tempDir, encoding: "utf-8" })
      const secondContract = JSON.parse(fs.readFileSync(contractPath, "utf-8"))

      expect(secondContract.components).toEqual(firstContract.components)
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("accepts equivalent zero-length values from separate CSS files without reporting a redefinition", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-cli-e2e-"))
    try {
      fs.writeFileSync(path.join(tempDir, "first.css"), ":root { --spacing-gap: 0; }")
      fs.writeFileSync(path.join(tempDir, "second.css"), ":root { --spacing-gap: 0px; }")
      fs.writeFileSync(
        path.join(tempDir, "primitiv.config.js"),
        `module.exports = {
  sources: { codebase: { root: ".", patterns: ["**/*.css"], ignore: ["node_modules/**"] } },
  governance: { sourceOfTruth: "codebase", onConflict: "error" },
  output: { path: "./primitiv.contract.json" }
}`
      )

      execFileSync("bun", [CLI, "build"], { cwd: tempDir, encoding: "utf-8" })

      const contract = JSON.parse(fs.readFileSync(path.join(tempDir, "primitiv.contract.json"), "utf-8"))
      expect(contract.tokens.spacing["spacing-gap"].value).toBe("0")
      expect(contract.conflicts).toEqual([])
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
