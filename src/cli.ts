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
      await build(arg)
      break
    case "serve":
      await serve(arg)
      break
    case "verify": {
      const strict = process.argv.includes("--strict")
      const json = process.argv.includes("--json")
      const result = await verify(arg, { strict, json })
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
  primitiv verify [config] [--strict] [--json]
                           --strict: treat a stale contract as a hard failure (exit 2)
                           --json:   emit a machine-readable report instead of text

Exit codes for verify:
  0  clean — contract is fresh and all conflicts resolved
  1  stale — source files modified since the contract was built
  2  unresolved conflicts (or stale in --strict)
  3  no config or contract found

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
