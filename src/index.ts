import * as fs from "node:fs"
import * as path from "node:path"
import { ContractBuilder } from "./contract"
import { PrimitivMCPServer } from "./mcp"
import { applyRationale, loadRationale } from "./rationale"
import { CodebaseScanner } from "./scanner"
import { FigmaAdapter } from "./sources/figma"
import { StorybookAdapter } from "./sources/storybook"
import type { PrimitivConfig } from "./types"

// Load config — returns config with output.path resolved to an absolute path
function loadConfig(configPath?: string): PrimitivConfig {
  const resolved = path.resolve(process.cwd(), configPath || "primitiv.config.js")

  if (!fs.existsSync(resolved)) {
    throw new Error(`Config not found at ${resolved}. Run \`primitiv init\` to create one.`)
  }

  const config: PrimitivConfig = require(resolved)
  const configDir = path.dirname(resolved)
  config.output.path = path.resolve(configDir, config.output.path)
  if (config.sources.codebase) {
    config.sources.codebase.root = path.resolve(configDir, config.sources.codebase.root)
  }
  if (config.sources.storybook?.sourceRoot) {
    config.sources.storybook.sourceRoot = path.resolve(configDir, config.sources.storybook.sourceRoot)
  }
  return config
}

// Build command — scan sources, resolve conflicts, write contract
export async function build(configPath?: string): Promise<void> {
  const config = loadConfig(configPath)
  const projectRoot = path.dirname(path.resolve(process.cwd(), configPath || "primitiv.config.js"))
  const sources = []

  console.log("🔍 Scanning codebase...")

  if (config.sources.codebase) {
    const scanner = new CodebaseScanner(config.sources.codebase)
    const { tokens, components } = await scanner.scan()
    sources.push({ name: "codebase", tokens, components })
    console.log(`   ✓ Found ${Object.values(tokens).reduce((acc, cat) => acc + Object.keys(cat).length, 0)} tokens`)
    console.log(`   ✓ Found ${Object.keys(components).length} components`)
  }

  if (config.sources.figma) {
    console.log("\n🎨 Scanning Figma...")
    try {
      const adapter = new FigmaAdapter(config.sources.figma)
      const { tokens, components } = await adapter.scan()
      sources.push({ name: "figma", tokens, components })
      console.log(`   ✓ Found ${Object.values(tokens).reduce((acc, cat) => acc + Object.keys(cat).length, 0)} tokens`)
      console.log(`   ✓ Found ${Object.keys(components).length} components`)
    } catch (err: unknown) {
      console.log(`   ✗ Figma scan failed: ${errorMessage(err)}`)
    }
  }

  if (config.sources.storybook) {
    console.log("\n📖 Scanning Storybook...")
    try {
      const adapter = new StorybookAdapter(config.sources.storybook)
      const { tokens, components } = await adapter.scan()
      sources.push({ name: "storybook", tokens, components })
      console.log(`   ✓ Found ${Object.keys(components).length} components`)
    } catch (err: unknown) {
      console.log(`   ✗ Storybook scan failed: ${errorMessage(err)}`)
    }
  }

  console.log("\n📋 Building contract...")
  const builder = new ContractBuilder(config)
  const contract = builder.build(sources)
  contract.sourceRoot = projectRoot
  contract.configPath = path.resolve(process.cwd(), configPath || "primitiv.config.js")

  const rationale = loadRationale(config, projectRoot)
  applyRationale(contract.tokens, contract.components, rationale)
  const rationaleTokenCount = Object.keys(rationale.tokens ?? {}).length
  const rationaleComponentCount = Object.keys(rationale.components ?? {}).length
  if (rationaleTokenCount > 0 || rationaleComponentCount > 0) {
    console.log(`\n📝 Rationale: ${rationaleTokenCount} tokens, ${rationaleComponentCount} components`)
  }

  if (contract.conflicts.length > 0) {
    console.log(`\n⚠️  ${contract.conflicts.length} conflict(s) found:`)
    contract.conflicts.forEach((c) => {
      console.log(`   - ${c.type}: ${c.name}`)
      c.sources.forEach((s) => {
        console.log(`     ${s.source.adapter}${s.source.file ? ` (${s.source.file})` : ""}: ${s.value}`)
      })
    })
  }

  builder.save(contract)
  console.log(`\n✅ Contract written to ${config.output.path}`)
  console.log(
    `   ${Object.values(contract.tokens).reduce((acc, cat) => acc + Object.keys(cat).length, 0)} tokens resolved`
  )
  console.log(`   ${Object.keys(contract.components).length} components indexed`)
  console.log(`   ${contract.conflicts.filter((c) => c.resolution === "pending").length} pending conflicts`)
}

// Serve command — start MCP server
export async function serve(configPath?: string): Promise<void> {
  const config = loadConfig(configPath)
  const server = new PrimitivMCPServer(config.output.path)
  await server.start()
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
