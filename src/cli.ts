#!/usr/bin/env node

import { build, serve } from "./index"
import { init } from "./init"

const command = process.argv[2]
const arg = process.argv[3]

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
    default:
      console.log(`
Primitiv — the reconciliation layer for agentic design systems.

Usage:
  primitiv init           Detect your project and generate primitiv.config.js
  primitiv build          Scan sources, resolve conflicts, write the contract
  primitiv serve          Start the MCP server

Options:
  primitiv init  [dir]    Target directory (default: current directory)
  primitiv build [config] Path to config file (default: primitiv.config.js)
  primitiv serve [config] Path to config file (default: primitiv.config.js)

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

main().catch(err => {
  console.error("Error:", err.message)
  process.exit(1)
})