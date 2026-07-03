#!/usr/bin/env node

import { build, serve } from "./index"
import { init } from "./init"
import { verify } from "./verify"

const command = process.argv[2]
const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"))
const arg = positional[0]

async function main() {
  switch (command) {
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
  primitiv verify         Check the contract is fresh and conflict-free (for CI)

Options:
  primitiv init   [dir]    Target directory (default: current directory)
  primitiv build  [config] Path to config file (default: primitiv.config.js)
  primitiv serve  [config] Path to config file (default: primitiv.config.js)
  primitiv verify [config] [--strict] [--json] [--fast]
                           --strict: escalate stale contract / token misuses to hard failure (exit 2)
                           --json:   emit a machine-readable report instead of text
                           --fast:   skip the rebuild-and-compare step; use file mtimes
                                     instead. Faster but unreliable in CI / fresh clones.

Exit codes for verify:
  0  clean — contract matches a fresh rebuild, conflicts resolved, no token misuses
  1  stale or token misuse detected (warning level)
  2  unresolved conflicts (or stale / token misuses in --strict)
  3  no config or contract found, or the contract is malformed

Exit codes for build:
  0  contract written
  1  build failed (bad config, unreadable source)
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
