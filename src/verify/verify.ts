import * as fs from "node:fs"
import * as path from "node:path"
import { glob } from "glob"
import { buildContract, loadConfig } from "../index"
import type { Conflict, PrimitivConfig, PrimitivContract } from "../types"

export interface VerifyOptions {
  strict?: boolean
  json?: boolean
  cwd?: string
  // Opt into the legacy mtime-based staleness check. Faster but unreliable
  // anywhere file mtimes get reset (CI, fresh clones). Default verify rebuilds
  // the contract in memory and compares structurally — correct in any
  // environment, slightly slower.
  fast?: boolean
}

export type VerifyStatus = "clean" | "stale" | "unresolved-conflicts" | "missing-config" | "missing-contract"
export type VerifyExitCode = 0 | 1 | 2 | 3

export interface VerifyResult {
  status: VerifyStatus
  exitCode: VerifyExitCode
  messages: string[]
  contract: {
    generatedAt?: string
    ageHours?: number
  }
  conflicts: {
    total: number
    pending: number
  }
  drift: {
    isStale: boolean
    // Human-readable change descriptions. Default mode lists structural
    // diffs ("token added: colors.color-warning"); --fast lists modified
    // source files ("source modified: tokens.css").
    changes: string[]
  }
}

const MAX_REPORTED_CHANGES = 10
const MAX_REPORTED_CONFLICTS = 5
const MAX_DETECTED_NEWER_FILES = 10

export async function verify(configPath: string | undefined, options: VerifyOptions = {}): Promise<VerifyResult> {
  const cwd = options.cwd ?? process.cwd()
  const resolvedConfigPath = path.resolve(cwd, configPath ?? "primitiv.config.js")

  if (!fs.existsSync(resolvedConfigPath)) {
    return {
      status: "missing-config",
      exitCode: 3,
      messages: [`No config found at ${resolvedConfigPath}. Run \`primitiv init\` in this project first.`],
      contract: {},
      conflicts: { total: 0, pending: 0 },
      drift: { isStale: false, changes: [] }
    }
  }

  const config = loadConfig(configPath, cwd)
  const contractPath = config.output.path

  if (!fs.existsSync(contractPath)) {
    return {
      status: "missing-contract",
      exitCode: 3,
      messages: [`No contract at ${contractPath}. Run \`primitiv build\` to generate one.`],
      contract: {},
      conflicts: { total: 0, pending: 0 },
      drift: { isStale: false, changes: [] }
    }
  }

  const contract = JSON.parse(fs.readFileSync(contractPath, "utf-8")) as PrimitivContract
  const generatedAt = new Date(contract.generatedAt)
  const ageHours = (Date.now() - generatedAt.getTime()) / (1000 * 60 * 60)

  const pendingConflicts = contract.conflicts.filter((c) => c.resolution === "pending")
  const hasUnresolvedConflicts = pendingConflicts.length > 0

  const drift = options.fast
    ? await detectDriftByMtime(config, resolvedConfigPath, generatedAt)
    : await detectDriftByRebuild(contract, configPath, cwd)

  const messages: string[] = []

  if (hasUnresolvedConflicts) {
    messages.push(
      `✗ ${pendingConflicts.length} pending conflict${pendingConflicts.length === 1 ? "" : "s"} require resolution:`
    )
    for (const conflict of pendingConflicts.slice(0, MAX_REPORTED_CONFLICTS)) {
      messages.push(`  - ${conflict.type}: ${conflict.name}`)
      if (conflict.suggestedFix) messages.push(`    → ${conflict.suggestedFix}`)
    }
    if (pendingConflicts.length > MAX_REPORTED_CONFLICTS) {
      messages.push(
        `  ... and ${pendingConflicts.length - MAX_REPORTED_CONFLICTS} more. Call get_conflicts via the MCP server for the full list.`
      )
    }
  }

  if (drift.isStale) {
    const severity = options.strict || !hasUnresolvedConflicts ? "✗" : "!"
    const noun = drift.changes.length === 1 ? "change" : "changes"
    messages.push(`${severity} Contract is stale: ${drift.changes.length} ${noun} detected since contract was built.`)
    for (const change of drift.changes.slice(0, MAX_REPORTED_CHANGES)) {
      messages.push(`  - ${change}`)
    }
    if (drift.changes.length > MAX_REPORTED_CHANGES) {
      messages.push(`  ... and ${drift.changes.length - MAX_REPORTED_CHANGES} more.`)
    }
    messages.push(`  Run \`primitiv build\` to refresh.`)
  }

  if (!drift.isStale && !hasUnresolvedConflicts) {
    messages.push(`✓ Contract is fresh (age ${formatAge(ageHours)}) and all conflicts resolved.`)
  }

  const { status, exitCode } = decideStatus({
    isStale: drift.isStale,
    hasUnresolvedConflicts,
    strict: options.strict === true
  })

  return {
    status,
    exitCode,
    messages,
    contract: {
      generatedAt: contract.generatedAt,
      ageHours: Number(ageHours.toFixed(2))
    },
    conflicts: {
      total: contract.conflicts.length,
      pending: pendingConflicts.length
    },
    drift
  }
}

// Default drift detection: rebuild the contract in memory using the existing
// build pipeline, then compare structurally against the committed contract.
// Works in any environment because it doesn't depend on file mtimes — the
// only thing that matters is whether a fresh build would produce a different
// contract.
async function detectDriftByRebuild(
  committed: PrimitivContract,
  configPath: string | undefined,
  cwd: string
): Promise<{ isStale: boolean; changes: string[] }> {
  const fresh = await buildContract(configPath, { silent: true, cwd })
  const changes = diffContracts(committed, fresh)
  return { isStale: changes.length > 0, changes }
}

// Compare two contracts and return a list of human-readable change descriptions.
// Only the substantive parts of the contract are compared:
//   - token additions / removals / value changes
//   - component additions / removals
// generatedAt timestamps and source provenance metadata are intentionally
// ignored — drift is about the design surface, not when the file was written.
function diffContracts(committed: PrimitivContract, fresh: PrimitivContract): string[] {
  const changes: string[] = []

  const allCategories = new Set([...Object.keys(committed.tokens), ...Object.keys(fresh.tokens)])
  for (const category of allCategories) {
    const committedTokens = (committed.tokens as Record<string, Record<string, { value: string }>>)[category] || {}
    const freshTokens = (fresh.tokens as Record<string, Record<string, { value: string }>>)[category] || {}
    const allNames = new Set([...Object.keys(committedTokens), ...Object.keys(freshTokens)])
    for (const name of allNames) {
      const c = committedTokens[name]
      const f = freshTokens[name]
      if (!c) {
        changes.push(`token added: ${category}.${name}`)
      } else if (!f) {
        changes.push(`token removed: ${category}.${name}`)
      } else if (c.value !== f.value) {
        changes.push(`token value changed: ${category}.${name} (${c.value} → ${f.value})`)
      }
    }
  }

  const allComponents = new Set([...Object.keys(committed.components), ...Object.keys(fresh.components)])
  for (const name of allComponents) {
    const c = committed.components[name]
    const f = fresh.components[name]
    if (!c) {
      changes.push(`component added: ${name}`)
    } else if (!f) {
      changes.push(`component removed: ${name}`)
    }
  }

  return changes
}

// Legacy drift detection (--fast): compares file mtimes against contract.generatedAt.
// Faster than rebuild but unreliable anywhere mtimes get reset — git checkouts,
// Docker mounts, fresh clones. Use only on machines where the user just edited
// a file and wants a near-instant pre-commit check.
async function detectDriftByMtime(
  config: PrimitivConfig,
  configPath: string,
  threshold: Date
): Promise<{ isStale: boolean; changes: string[] }> {
  const newerFiles = await findSourceFilesNewerThan(config, configPath, threshold)
  return {
    isStale: newerFiles.length > 0,
    changes: newerFiles.map((f) => `source modified: ${f}`)
  }
}

async function findSourceFilesNewerThan(
  config: PrimitivConfig,
  configPath: string,
  threshold: Date
): Promise<string[]> {
  // Figma/Storybook sources are remote — we can't check mtimes. Only codebase sources are verifiable.
  if (!config.sources.codebase) return []

  const configDir = path.dirname(configPath)
  const codebaseRoot = path.resolve(configDir, config.sources.codebase.root)
  const newer: string[] = []

  for (const pattern of config.sources.codebase.patterns) {
    const matches = await glob(pattern, {
      cwd: codebaseRoot,
      ignore: config.sources.codebase.ignore,
      absolute: false
    })
    for (const file of matches) {
      const stat = fs.statSync(path.resolve(codebaseRoot, file))
      if (stat.mtime > threshold) {
        newer.push(file)
        if (newer.length >= MAX_DETECTED_NEWER_FILES) return newer
      }
    }
  }

  return newer
}

function decideStatus(params: { isStale: boolean; hasUnresolvedConflicts: boolean; strict: boolean }): {
  status: VerifyStatus
  exitCode: VerifyExitCode
} {
  if (params.hasUnresolvedConflicts) return { status: "unresolved-conflicts", exitCode: 2 }
  if (params.isStale) return { status: "stale", exitCode: params.strict ? 2 : 1 }
  return { status: "clean", exitCode: 0 }
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 24) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

// Re-exported so callers can narrow a result's conflict list without importing the full types module.
export type { Conflict }
