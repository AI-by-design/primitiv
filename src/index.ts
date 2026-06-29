import * as fs from "node:fs"
import * as path from "node:path"
import { ContractBuilder } from "./contract"
import { lintTokenMisuse } from "./lint"
import { PrimitivMCPServer } from "./mcp"
import { applyRationale, loadRationale } from "./rationale"
import { CodebaseScanner } from "./scanner"
import { FigmaAdapter } from "./sources/figma"
import { StorybookAdapter } from "./sources/storybook"
import { primitivConfigSchema, summarizeValidationIssues } from "./types"
import type { PrimitivConfig, PrimitivContract } from "./types"

// Load config — returns config with output.path resolved to an absolute path
export function loadConfig(configPath?: string, cwd: string = process.cwd()): PrimitivConfig {
  const resolved = path.resolve(cwd, configPath || "primitiv.config.js")

  if (!fs.existsSync(resolved)) {
    throw new Error(`Config not found at ${resolved}. Run \`primitiv init\` to create one.`)
  }

  // Cache-bust so callers (like verify's rebuild path) pick up config changes without restarting the process.
  delete require.cache[require.resolve(resolved)]
  const raw: unknown = require(resolved)
  const parsed = primitivConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(
      `Invalid config at ${resolved}: ${summarizeValidationIssues(parsed.error)}. ` +
        `Fix the file or run \`primitiv init\` to regenerate it.`
    )
  }
  // Validated at the boundary (rule 12) — trust the shape from here on.
  const config = raw as PrimitivConfig
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

export interface BuildContractOptions {
  // Suppress console output; used by verify's rebuild path.
  silent?: boolean
  // Working directory for resolving the config path; defaults to process.cwd().
  cwd?: string
}

// Builds the contract object in memory: scans every configured source,
// reconciles via ContractBuilder, applies rationale, returns the result.
// Does NOT write to disk — that's `build()`'s job. Used by verify() to
// produce a fresh contract for content comparison.
export async function buildContract(
  configPath?: string,
  options: BuildContractOptions = {}
): Promise<PrimitivContract> {
  const cwd = options.cwd ?? process.cwd()
  const config = loadConfig(configPath, cwd)
  const projectRoot = path.dirname(path.resolve(cwd, configPath || "primitiv.config.js"))
  const sources = []
  const log = (msg: string) => {
    if (!options.silent) console.log(msg)
  }

  log("🔍 Scanning codebase...")

  if (config.sources.codebase) {
    const scanner = new CodebaseScanner(config.sources.codebase)
    const { tokens, components, internalCssVars } = await scanner.scan()
    sources.push({ name: "codebase", tokens, components })
    log(`   ✓ Found ${Object.values(tokens).reduce((acc, cat) => acc + Object.keys(cat).length, 0)} tokens`)
    if (internalCssVars > 0) {
      log(`     (excluded ${internalCssVars} component-internal CSS var${internalCssVars === 1 ? "" : "s"})`)
    }
    log(`   ✓ Found ${Object.keys(components).length} components`)
    const kindBreakdown = summarizeKinds(components)
    if (kindBreakdown) log(`     ${kindBreakdown}`)
  }

  if (config.sources.figma) {
    log("\n🎨 Scanning Figma...")
    try {
      const adapter = new FigmaAdapter(config.sources.figma)
      const { tokens, components } = await adapter.scan()
      sources.push({ name: "figma", tokens, components })
      log(`   ✓ Found ${Object.values(tokens).reduce((acc, cat) => acc + Object.keys(cat).length, 0)} tokens`)
      log(`   ✓ Found ${Object.keys(components).length} components`)
    } catch (err: unknown) {
      log(`   ✗ Figma scan failed: ${errorMessage(err)}`)
    }
  }

  if (config.sources.storybook) {
    log("\n📖 Scanning Storybook...")
    try {
      const adapter = new StorybookAdapter(config.sources.storybook)
      const { tokens, components } = await adapter.scan()
      sources.push({ name: "storybook", tokens, components })
      log(`   ✓ Found ${Object.keys(components).length} components`)
    } catch (err: unknown) {
      log(`   ✗ Storybook scan failed: ${errorMessage(err)}`)
    }
  }

  log("\n📋 Building contract...")
  const builder = new ContractBuilder(config)
  const contract = builder.build(sources)
  contract.sourceRoot = projectRoot
  contract.configPath = path.resolve(cwd, configPath || "primitiv.config.js")

  // Non-blocking notice: same-name components now coexist under qualified ids instead of
  // first-wins. Surfaced so nobody mistakes a multi-id name for a duplicate-scan bug.
  const coexisting = Object.entries(contract.componentNameIndex ?? {}).filter(([, ids]) => ids.length > 1)
  if (coexisting.length > 0) {
    const top = coexisting
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8)
      .map(([name, ids]) => `${name}(×${ids.length})`)
      .join(", ")
    log(
      `   ℹ ${coexisting.length} component name${coexisting.length === 1 ? "" : "s"} with multiple implementations — coexisting, resolved at lookup by scope/rationale. Top: ${top}`
    )
  }

  const rationale = loadRationale(config, projectRoot)
  const rationaleWarnings = applyRationale(contract.tokens, contract.components, rationale)
  for (const warning of rationaleWarnings) log(`   ⚠ ${warning}`)
  const rationaleTokenCount = Object.keys(rationale.tokens ?? {}).length
  const rationaleComponentCount = Object.keys(rationale.components ?? {}).length
  if (rationaleTokenCount > 0 || rationaleComponentCount > 0) {
    log(`\n📝 Rationale: ${rationaleTokenCount} tokens, ${rationaleComponentCount} components`)
  }

  // Lint pass: scan source files for hardcoded literals that bypass the contract.
  // Runs last so the smart-match index sees the final reconciled token set.
  const violations = await lintTokenMisuse(config, contract)
  contract.violations = violations
  if (violations.length > 0) {
    log(
      `\n🔎 ${violations.length} hardcoded token value${violations.length === 1 ? "" : "s"} — literals typed inline instead of a token.`
    )
    log(`   Full list (file:line + suggestion) in the contract's \`violations\` array, or via get_violations.`)
  }

  return contract
}

// Build command — scan sources, resolve conflicts, write contract
export async function build(configPath?: string): Promise<void> {
  const config = loadConfig(configPath)
  const contract = await buildContract(configPath)

  if (contract.conflicts.length > 0) {
    console.log(`\n⚠️  ${contract.conflicts.length} conflict(s) found:`)
    contract.conflicts.forEach((c) => {
      console.log(`   - ${c.type}: ${c.name}`)
      c.sources.forEach((s) => {
        console.log(`     ${s.source.adapter}${s.source.file ? ` (${s.source.file})` : ""}: ${s.value}`)
      })
    })
  }

  const builder = new ContractBuilder(config)
  builder.save(contract)
  console.log(`\n✅ Contract written to ${config.output.path}`)
  console.log(
    `   ${Object.values(contract.tokens).reduce((acc, cat) => acc + Object.keys(cat).length, 0)} tokens resolved`
  )
  console.log(`   ${Object.keys(contract.components).length} components indexed`)
  console.log(`   ${contract.conflicts.filter((c) => c.resolution === "pending").length} pending conflicts`)
  console.log(`   ${(contract.violations ?? []).length} hardcoded token values`)
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

// "kind: component 285 · icon 40 · screen 12" — the AST classifier's breakdown, so a build log
// shows how much of the component count is reusable UI vs screens/providers/icons/other noise.
function summarizeKinds(components: Record<string, { kind?: string }>): string {
  const counts: Record<string, number> = {}
  for (const c of Object.values(components)) {
    const kind = c.kind ?? "component"
    counts[kind] = (counts[kind] ?? 0) + 1
  }
  const order = ["component", "screen", "provider", "icon", "other"]
  const parts = Object.entries(counts)
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]) || b[1] - a[1])
    .map(([kind, n]) => `${kind} ${n}`)
  return parts.length > 1 ? `kind: ${parts.join(" · ")}` : ""
}
