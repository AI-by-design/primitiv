import * as fs from "node:fs"
import * as path from "node:path"
import { ContractBuilder } from "./contract"
import { lintTokenMisuse } from "./lint"
import { PrimitivMCPServer } from "./mcp"
import { applyRationale, loadRationale } from "./rationale"
import { CodebaseScanner } from "./scanner"
import { FigmaAdapter } from "./sources/figma"
import { StorybookAdapter } from "./sources/storybook"
import type { PrimitivConfig, PrimitivContract, SourceStatus, TokenMap } from "./types"
import { primitivConfigSchema, summarizeValidationIssues } from "./types"

// Public type surface for external consumers of the package (rule 2: every
// export is a maintained contract). Curated, not `export *` — config internals
// (Source, FigmaSource, …) stay private until a consumer needs them.
export type {
  PrimitivContract,
  Token,
  TokenMap,
  TokenCategory,
  TokenRedefinition,
  Component,
  ComponentMap,
  ComponentKind,
  PropDefinition,
  Conflict,
  SourceProvenance,
  SourceStatus,
  SourceScanStatus,
  InferredRule,
  InferredRules,
  Rationale,
  RationaleMap,
  Violation,
  LintCategory,
  PrimitivConfig,
} from "./types"
export { primitivContractSchema } from "./types"

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
  // Every known source gets a status so the contract distinguishes "not configured"
  // (skipped) from "configured but failed" (failed) — a failed remote scan must never
  // silently read as an emptied source.
  const sourceStatuses: Record<string, SourceStatus> = {
    codebase: { status: "skipped" },
    figma: { status: "skipped" },
    storybook: { status: "skipped" }
  }
  const log = (msg: string) => {
    if (!options.silent) console.log(msg)
  }

  if (config.sources.codebase) {
    log("🔍 Scanning codebase...")
    try {
      const scanner = new CodebaseScanner(config.sources.codebase)
      const { tokens, components, internalCssVars, redefinitions } = await scanner.scan()
      sources.push({ name: "codebase", tokens, components, redefinitions })
      sourceStatuses.codebase = {
        status: "ok",
        tokens: countTokens(tokens),
        components: Object.keys(components).length
      }
      log(`   ✓ Found ${countTokens(tokens)} tokens`)
      if (internalCssVars > 0) {
        log(`     (excluded ${internalCssVars} component-internal CSS var${internalCssVars === 1 ? "" : "s"})`)
      }
      const modeSummary = summarizeModes(tokens)
      if (modeSummary) log(`     ${modeSummary}`)
      if (redefinitions.length > 0) {
        log(
          `   ⚠ ${redefinitions.length} token name${redefinitions.length === 1 ? "" : "s"} defined multiple times with different values — recorded as pending conflicts`
        )
      }
      log(`   ✓ Found ${Object.keys(components).length} components`)
      const kindBreakdown = summarizeKinds(components)
      if (kindBreakdown) log(`     ${kindBreakdown}`)
    } catch (err: unknown) {
      recordScanFailure({ name: "codebase", err, config, sourceStatuses, log })
    }
  }

  if (config.sources.figma) {
    log("\n🎨 Scanning Figma...")
    try {
      const adapter = new FigmaAdapter(config.sources.figma)
      const { tokens, components } = await adapter.scan()
      sources.push({ name: "figma", tokens, components })
      sourceStatuses.figma = { status: "ok", tokens: countTokens(tokens), components: Object.keys(components).length }
      log(`   ✓ Found ${countTokens(tokens)} tokens`)
      log(`   ✓ Found ${Object.keys(components).length} components`)
    } catch (err: unknown) {
      recordScanFailure({ name: "figma", err, config, sourceStatuses, log })
    }
  }

  if (config.sources.storybook) {
    log("\n📖 Scanning Storybook...")
    try {
      const adapter = new StorybookAdapter(config.sources.storybook)
      const { tokens, components } = await adapter.scan()
      sources.push({ name: "storybook", tokens, components })
      sourceStatuses.storybook = {
        status: "ok",
        tokens: countTokens(tokens),
        components: Object.keys(components).length
      }
      log(`   ✓ Found ${Object.keys(components).length} components`)
    } catch (err: unknown) {
      recordScanFailure({ name: "storybook", err, config, sourceStatuses, log })
    }
  }

  log("\n📋 Building contract...")
  const builder = new ContractBuilder(config)
  const contract = builder.build(sources)
  contract.sourceRoot = projectRoot
  contract.configPath = path.resolve(cwd, configPath || "primitiv.config.js")
  contract.sourceStatuses = sourceStatuses

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

// Build command — scan sources, resolve conflicts, write contract.
// Returns the process exit code: 0 = contract written, 2 = pending conflicts under
// governance.onConflict: "error". The contract is always written first — failing the
// build never withholds the artifact that explains the failure.
export async function build(configPath?: string): Promise<number> {
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
  const pendingConflicts = contract.conflicts.filter((c) => c.resolution === "pending").length
  console.log(`\n✅ Contract written to ${config.output.path}`)
  console.log(`   ${countTokens(contract.tokens)} tokens resolved`)
  console.log(`   ${Object.keys(contract.components).length} components indexed`)
  console.log(`   ${pendingConflicts} pending conflicts`)
  console.log(`   ${(contract.violations ?? []).length} hardcoded token values`)

  if (config.governance.onConflict === "error" && pendingConflicts > 0) {
    console.error(
      `\n✗ governance.onConflict is "error": failing the build on ${pendingConflicts} pending conflict${pendingConflicts === 1 ? "" : "s"} (contract still written).`
    )
    console.error(`   Resolve the conflicts above, or relax governance.onConflict to "warn" in primitiv.config.js.`)
    return 2
  }
  return 0
}

// Serve command — start MCP server
export async function serve(configPath?: string): Promise<void> {
  const config = loadConfig(configPath)
  const server = new PrimitivMCPServer(config.output.path)
  await server.start()
}

// Record a failed scan and decide whether the build survives it. The source of truth
// is always required — resolving conflicts without the authority that decides them is
// worse than no contract, so no contract is written. Other sources are optional unless
// the config says `optional: false`; their failure is recorded and the build continues.
function recordScanFailure(opts: {
  name: "codebase" | "figma" | "storybook"
  err: unknown
  config: PrimitivConfig
  sourceStatuses: Record<string, SourceStatus>
  log: (msg: string) => void
}): void {
  const { name, err, config, sourceStatuses, log } = opts
  const error = scanErrorMessage(err)
  sourceStatuses[name] = { status: "failed", error }
  if (config.governance.sourceOfTruth === name) {
    throw new Error(
      `${name} scan failed: ${error}\n` +
        `governance.sourceOfTruth is "${name}" — a contract built without its source of truth would resolve conflicts with no authority, so none was written. ` +
        `Fix the source and rerun \`primitiv build\`, or change governance.sourceOfTruth in primitiv.config.js.`
    )
  }
  if (config.sources[name]?.optional === false) {
    throw new Error(
      `${name} scan failed: ${error}\n` +
        `primitiv.config.js marks this source required (optional: false), so no contract was written. ` +
        `Fix the source and rerun \`primitiv build\`, or drop \`optional: false\` to continue without it.`
    )
  }
  log(`   ✗ ${name} scan failed: ${error}`)
  log(`     Continuing without it — recorded in the contract's sourceStatuses.`)
}

// Sanitized error for logs and the persisted contract: first line only, capped, so a
// thrown message can never drag a response body or secret into primitiv.contract.json
// (the contract gets committed and fed to LLMs).
function scanErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const firstLine = msg.split("\n")[0]
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine
}

function countTokens(tokens: TokenMap): number {
  return Object.values(tokens).reduce((acc, cat) => acc + Object.keys(cat).length, 0)
}

// "3 tokens carry theme modes: dark, dim" — how many tokens have theme-scoped values and which
// modes appeared, so a dark-mode design system can confirm its variants were captured (not dropped
// as component-internal, the pre-modes behavior). Empty when no token has modes.
function summarizeModes(tokens: TokenMap): string {
  const modeKeys = new Set<string>()
  let count = 0
  for (const cat of Object.values(tokens)) {
    for (const token of Object.values(cat)) {
      if (token.modes && Object.keys(token.modes).length > 0) {
        count++
        for (const key of Object.keys(token.modes)) modeKeys.add(key)
      }
    }
  }
  if (count === 0) return ""
  return `${count} token${count === 1 ? "" : "s"} carry theme modes: ${[...modeKeys].sort().join(", ")}`
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
