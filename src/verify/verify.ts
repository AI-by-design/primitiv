import * as fs from "node:fs"
import * as path from "node:path"
import { glob } from "glob"
import type { Conflict, PrimitivConfig, PrimitivContract } from "../types"

export interface VerifyOptions {
  strict?: boolean
  json?: boolean
  cwd?: string
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
  staleness: {
    contractOlderThanSources: boolean
    sampleNewerFiles: string[]
  }
}

const MAX_REPORTED_NEWER_FILES = 10
const MAX_REPORTED_CONFLICTS = 5

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
      staleness: { contractOlderThanSources: false, sampleNewerFiles: [] }
    }
  }

  const config = loadConfig(resolvedConfigPath)
  const contractPath = path.resolve(path.dirname(resolvedConfigPath), config.output.path)

  if (!fs.existsSync(contractPath)) {
    return {
      status: "missing-contract",
      exitCode: 3,
      messages: [`No contract at ${contractPath}. Run \`primitiv build\` to generate one.`],
      contract: {},
      conflicts: { total: 0, pending: 0 },
      staleness: { contractOlderThanSources: false, sampleNewerFiles: [] }
    }
  }

  const contract = JSON.parse(fs.readFileSync(contractPath, "utf-8")) as PrimitivContract
  const generatedAt = new Date(contract.generatedAt)
  const ageHours = (Date.now() - generatedAt.getTime()) / (1000 * 60 * 60)

  const pendingConflicts = contract.conflicts.filter((c) => c.resolution === "pending")
  const newerFiles = await findSourceFilesNewerThan(config, resolvedConfigPath, generatedAt)

  const isStale = newerFiles.length > 0
  const hasUnresolvedConflicts = pendingConflicts.length > 0

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

  if (isStale) {
    const severity = options.strict || !hasUnresolvedConflicts ? "✗" : "!"
    messages.push(
      `${severity} Contract is stale: ${newerFiles.length} source file${newerFiles.length === 1 ? "" : "s"} modified since ${generatedAt.toISOString()}.`
    )
    messages.push(`  Run \`primitiv build\` to refresh.`)
  }

  if (!isStale && !hasUnresolvedConflicts) {
    messages.push(`✓ Contract is fresh (age ${formatAge(ageHours)}) and all conflicts resolved.`)
  }

  const { status, exitCode } = decideStatus({
    isStale,
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
    staleness: {
      contractOlderThanSources: isStale,
      sampleNewerFiles: newerFiles.slice(0, MAX_REPORTED_NEWER_FILES)
    }
  }
}

function loadConfig(resolvedConfigPath: string): PrimitivConfig {
  // Cache-bust so a re-run of verify picks up config changes without restarting the process.
  delete require.cache[require.resolve(resolvedConfigPath)]
  return require(resolvedConfigPath) as PrimitivConfig
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
        if (newer.length >= MAX_REPORTED_NEWER_FILES) return newer
      }
    }
  }

  return newer
}

function decideStatus(params: {
  isStale: boolean
  hasUnresolvedConflicts: boolean
  strict: boolean
}): { status: VerifyStatus; exitCode: VerifyExitCode } {
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
