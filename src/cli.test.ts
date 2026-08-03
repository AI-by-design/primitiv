import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
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
