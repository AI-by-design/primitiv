#!/usr/bin/env node

import * as fs from "node:fs"
import * as path from "node:path"
import { build, serve } from "./index"
import { init } from "./init"
import { verify } from "./verify"

const command = process.argv[2]
const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"))
const arg = positional[0]

async function main() {
  switch (command) {
    case "--version":
    case "-v":
    case "version":
      console.log(readVersion())
      break
    case "init":
      await init(arg)
      break
    case "build":
      // exitCode (not process.exit) so queued stdout flushes before the process ends.
      process.exitCode = await build(arg)
      break
    case "serve":
      await serve(arg)
      break
    case "verify": {
      const strict = process.argv.includes("--strict")
      const json = process.argv.includes("--json")
      const fast = process.argv.includes("--fast")
      const result = await verify(arg, { strict, json, fast })
      if (json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        for (const msg of result.messages) console.log(msg)
      }
      process.exit(result.exitCode)
      break
    }
    default:
      console.log(`
Primitiv — the reconciliation layer for agentic design systems.

Usage:
  primitiv init           Detect your project and generate primitiv.config.js
  primitiv build          Scan sources, resolve conflicts, write the contract
  primitiv serve          Start the MCP server
  primitiv verify         Check contract freshness, token usage, source scans, and conflict policy
  primitiv --version      Print the installed version

Options:
  primitiv init   [dir]    Target directory (default: current directory)
  primitiv build  [config] Path to config file (default: primitiv.config.js)
  primitiv serve  [config] Path to config file (default: primitiv.config.js)
  primitiv verify [config] [--strict] [--json] [--fast]
                           --strict: escalate pending conflicts / stale contract / token
                                     misuses / failed source scans to hard failure (exit 2)
                           --json:   emit a machine-readable report instead of text
                           --fast:   skip the rebuild-and-compare step; use file mtimes
                                     instead. Faster but unreliable in CI / fresh clones.

Exit codes for verify:
  0  no blocking findings — includes pending conflicts allowed by governance.onConflict
     "warn" / "auto-resolve", and failed optional source scans, when not using --strict
  1  stale contract or token misuse without --strict (including alongside tolerated conflicts)
  2  pending conflicts under governance.onConflict "error", or pending conflicts / stale
     contract / token misuses / failed source scans when using --strict
  3  no config or contract found, or the contract is malformed

Exit codes for build:
  0  contract written (failed optional sources are recorded in sourceStatuses)
  1  build failed (bad config, or the source of truth / a source marked
     optional: false failed to scan — no contract written)
  2  pending conflicts and governance.onConflict is "error" (contract still written)

Quick start:
  1. Run \`primitiv init\` in your project root
  2. Run \`primitiv build\` to generate your contract
  3. Add Primitiv to your MCP config in Cursor or Claude Code:
     {
       "primitiv": {
         "command": "node",
         "args": ["/path/to/primitiv/dist/cli.js", "serve", "/path/to/your/project/primitiv.config.js"]
       }
     }
      `)
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : String(err))
  process.exit(1)
})

// Read from the manifest that ships beside the compiled CLI rather than baking the
// version in at build time, so what it prints is always what npm actually installed.
// Resolves identically from src/ and dist/ — both sit one level under the package root.
function readVersion(): string {
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"))
    if (typeof manifest === "object" && manifest !== null && "version" in manifest) {
      const version = (manifest as { version: unknown }).version
      if (typeof version === "string" && version.length > 0) return version
    }
  } catch {
    // An unreadable or malformed manifest is not a reason for `--version` to throw.
  }
  return "unknown"
}
