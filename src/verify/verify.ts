import * as fs from "node:fs"
import * as path from "node:path"
import { glob } from "glob"
import { buildContract, loadConfig } from "../index"
import { valuesEquivalent } from "../normalize/value"
import type { Conflict, PrimitivConfig, PrimitivContract, Violation } from "../types"
import { primitivContractSchema, summarizeValidationIssues } from "../types"
import { verifyDefaultContractSchema, verifyFastContractSchema, verifySharedContractSchema } from "./contract-schema"

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

export type VerifyStatus =
  | "clean"
  | "stale"
  | "unresolved-conflicts"
  | "token-misuse-detected"
  | "source-scan-failed"
  | "missing-config"
  | "missing-contract"
  | "invalid-contract"
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
  violations: {
    total: number
    // First N violations included for direct display. Full list is on the
    // contract itself; agents fetch it via the get_violations MCP tool.
    reported: Violation[]
  }
  // Sources that failed to scan — during the rebuild in default mode, or as recorded
  // on the committed contract in --fast mode. Warn-level by default; --strict
  // escalates to a hard failure (exit 2). Drift for a failed source's entries is not
  // evaluated, so an unreachable Figma never reads as "every figma token removed".
  failedSources: Array<{ name: string; error?: string }>
}

const MAX_REPORTED_CHANGES = 10
const MAX_REPORTED_CONFLICTS = 5
const MAX_REPORTED_VIOLATIONS = 5
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
      drift: { isStale: false, changes: [] },
      violations: { total: 0, reported: [] },
      failedSources: []
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
      drift: { isStale: false, changes: [] },
      violations: { total: 0, reported: [] },
      failedSources: []
    }
  }

  let parsedContract: unknown
  try {
    parsedContract = JSON.parse(fs.readFileSync(contractPath, "utf-8"))
  } catch {
    return invalidContract(contractPath, "it isn't valid JSON")
  }
  const validatedContract = primitivContractSchema.safeParse(parsedContract)
  if (!validatedContract.success) {
    return invalidContract(contractPath, summarizeValidationIssues(validatedContract.error))
  }
  const sharedContract = verifySharedContractSchema.safeParse(parsedContract)
  if (!sharedContract.success) {
    return invalidContract(contractPath, summarizeValidationIssues(sharedContract.error))
  }
  const modeContract = (options.fast ? verifyFastContractSchema : verifyDefaultContractSchema).safeParse(parsedContract)
  if (!modeContract.success) {
    return invalidContract(contractPath, summarizeValidationIssues(modeContract.error))
  }
  // The public envelope plus shared and selected-mode proofs cover every committed
  // leaf this execution dereferences. Keep the original loose object so unrelated
  // and future artifact fields are not stripped or reconstructed.
  const contract = parsedContract as PrimitivContract
  const generatedAt = new Date(contract.generatedAt)
  const ageHours = (Date.now() - generatedAt.getTime()) / (1000 * 60 * 60)

  const pendingConflicts = contract.conflicts.filter((c) => c.resolution === "pending")
  const hasUnresolvedConflicts = pendingConflicts.length > 0

  // In default (rebuild) mode, the rebuilt contract has fresh violations from
  // the current source tree. In --fast mode we trust the committed contract,
  // accepting that violations may be stale (same tradeoff as drift detection).
  const driftAndLint = options.fast
    ? {
        ...(await detectDriftByMtime(config, resolvedConfigPath, generatedAt)),
        violations: contract.violations ?? [],
        failedSources: collectFailedSources(contract.sourceStatuses)
      }
    : await detectDriftAndLintByRebuild(contract, configPath, cwd)
  const drift = { isStale: driftAndLint.isStale, changes: driftAndLint.changes }
  const violations = driftAndLint.violations
  const hasViolations = violations.length > 0
  const failedSources = driftAndLint.failedSources
  const hasFailedSources = failedSources.length > 0

  const messages: string[] = []

  if (hasFailedSources) {
    const severity = options.strict ? "✗" : "!"
    for (const failed of failedSources) {
      messages.push(
        `${severity} Source '${failed.name}' failed to scan${failed.error ? ` (${failed.error})` : ""} — its data may be missing; drift for its entries is not evaluated.`
      )
    }
    if (!options.strict) {
      messages.push(`  Does not fail verify by default; --strict escalates failed sources to a hard failure.`)
    }
  }

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

  if (hasViolations) {
    const severity = options.strict || !hasUnresolvedConflicts ? "✗" : "!"
    const noun = violations.length === 1 ? "value" : "values"
    messages.push(`${severity} ${violations.length} hardcoded token ${noun} detected:`)
    for (const v of violations.slice(0, MAX_REPORTED_VIOLATIONS)) {
      // Token names are stored bare (`color-destructive`), so the reference is assembled
      // here. `use --color-destructive` reads as a CLI flag rather than a custom property;
      // leading dashes are stripped first so a `--`-prefixed name can't yield `var(----x)`.
      const suggestion = v.suggestion
        ? ` → use var(--${v.suggestion.token.replace(/^-+/, "")})`
        : ` → no matching token`
      messages.push(`  - ${v.source.file}:${v.source.line}  ${v.context}${suggestion}`)
    }
    if (violations.length > MAX_REPORTED_VIOLATIONS) {
      messages.push(
        `  ... and ${violations.length - MAX_REPORTED_VIOLATIONS} more. Call get_violations via the MCP server for the full list.`
      )
    }
  }

  if (drift.isStale) {
    const severity = options.strict || (!hasUnresolvedConflicts && !hasViolations) ? "✗" : "!"
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

  if (!drift.isStale && !hasUnresolvedConflicts && !hasViolations && !hasFailedSources) {
    messages.push(`✓ Contract is fresh (age ${formatAge(ageHours)}), conflicts resolved, no hardcoded token values.`)
  }

  // Same-name coexistence is intentional (path-qualified identity) — warn-but-pass, never
  // an exit-code change. Only cross-source conflicts fail CI.
  const coexisting = Object.values(contract.componentNameIndex ?? {}).filter((ids) => ids.length > 1).length
  if (coexisting > 0) {
    messages.push(
      `! ${coexisting} component name${coexisting === 1 ? "" : "s"} with multiple implementations — intentional coexistence, resolved at lookup by scope/rationale. Does not fail CI.`
    )
  }

  const { status, exitCode } = decideStatus({
    isStale: drift.isStale,
    hasUnresolvedConflicts,
    hasViolations,
    hasFailedSources,
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
    drift,
    violations: {
      total: violations.length,
      reported: violations.slice(0, MAX_REPORTED_VIOLATIONS)
    },
    failedSources
  }
}

// A contract file that exists but can't be trusted — invalid JSON, or missing the
// structure verify dereferences. Exit 3, the same file-level class as a missing
// config/contract, with the reason and the fix.
function invalidContract(contractPath: string, reason: string): VerifyResult {
  return {
    status: "invalid-contract",
    exitCode: 3,
    messages: [`Contract at ${contractPath} is malformed (${reason}). Run \`primitiv build\` to regenerate it.`],
    contract: {},
    conflicts: { total: 0, pending: 0 },
    drift: { isStale: false, changes: [] },
    violations: { total: 0, reported: [] },
    failedSources: []
  }
}

// Default drift + lint pass: rebuild the contract in memory using the existing
// build pipeline (which now includes the lint pass), compare structurally
// against the committed contract, and surface fresh violations from the rebuild.
// Works in any environment because it doesn't depend on file mtimes.
async function detectDriftAndLintByRebuild(
  committed: PrimitivContract,
  configPath: string | undefined,
  cwd: string
): Promise<{
  isStale: boolean
  changes: string[]
  violations: Violation[]
  failedSources: Array<{ name: string; error?: string }>
}> {
  const fresh = await buildContract(configPath, { silent: true, cwd })
  const failedSources = collectFailedSources(fresh.sourceStatuses)
  const changes = diffContracts(committed, fresh, new Set(failedSources.map((f) => f.name)))
  return { isStale: changes.length > 0, changes, violations: fresh.violations ?? [], failedSources }
}

function collectFailedSources(
  sourceStatuses: PrimitivContract["sourceStatuses"]
): Array<{ name: string; error?: string }> {
  return Object.entries(sourceStatuses ?? {})
    .filter(([, s]) => s.status === "failed")
    .map(([name, s]) => ({ name, ...(s.error ? { error: s.error } : {}) }))
}

// Compare two contracts and return a list of human-readable change descriptions.
// Only the substantive parts of the contract are compared:
//   - token additions / removals / value changes
//   - component additions / removals
//   - component relationship / usage changes
// generatedAt timestamps and source provenance metadata are intentionally
// ignored — drift is about the design surface, not when the file was written.
// Entries whose provenance points at a source that failed during the fresh scan
// are excluded from removal reporting: an unreachable Figma means "unknown",
// not "every figma token was removed".
function diffContracts(committed: PrimitivContract, fresh: PrimitivContract, failedSources?: Set<string>): string[] {
  const changes: string[] = []
  const failed = failedSources ?? new Set<string>()

  const allCategories = new Set([...Object.keys(committed.tokens), ...Object.keys(fresh.tokens)])
  for (const category of allCategories) {
    type DiffToken = {
      value: string
      source?: { adapter?: string }
      modes?: Record<string, string>
      modeSources?: Record<string, { adapter?: string }>
    }
    const committedTokens = (committed.tokens as Record<string, Record<string, DiffToken>>)[category] || {}
    const freshTokens = (fresh.tokens as Record<string, Record<string, DiffToken>>)[category] || {}
    const allNames = new Set([...Object.keys(committedTokens), ...Object.keys(freshTokens)])
    for (const name of allNames) {
      const c = committedTokens[name]
      const f = freshTokens[name]
      if (!c) {
        changes.push(`token added: ${category}.${name}`)
      } else if (!f) {
        if (!failed.has(c.source?.adapter ?? "")) changes.push(`token removed: ${category}.${name}`)
      } else {
        if (!valuesEquivalent(c.value, f.value, category)) {
          changes.push(`token value changed: ${category}.${name} (${c.value} → ${f.value})`)
        }
        // Theme-mode drift is real drift even when the default value is unchanged.
        const cModes = c.modes ?? {}
        const fModes = f.modes ?? {}
        for (const mode of new Set([...Object.keys(cModes), ...Object.keys(fModes)])) {
          const cv = cModes[mode]
          const fv = fModes[mode]
          if (cv === undefined) changes.push(`token mode added: ${category}.${name} (${mode}: ${fv})`)
          else if (fv === undefined) {
            const modeSource = c.modeSources?.[mode]?.adapter ?? c.source?.adapter ?? ""
            if (!failed.has(modeSource)) changes.push(`token mode removed: ${category}.${name} (${mode}: ${cv})`)
          } else if (!valuesEquivalent(cv, fv, category)) {
            changes.push(`token mode changed: ${category}.${name} (${mode}: ${cv} → ${fv})`)
          }
        }
      }
    }
  }

  const identity = compareComponentIdentity({ committed, fresh, failedSources: failed })
  changes.push(...identity.changes)
  changes.push(
    ...compareComponentRelationships({
      committed,
      fresh,
      pairs: identity.pairs,
      rekeys: identity.rekeys,
      failedSources: failed
    })
  )

  return changes
}

interface ComponentPair {
  committedId: string
  freshId: string
}

interface ComponentIdentityResult {
  changes: string[]
  pairs: ComponentPair[]
  rekeys: Map<string, string>
}

function compareComponentIdentity(params: {
  committed: PrimitivContract
  fresh: PrimitivContract
  failedSources: Set<string>
}): ComponentIdentityResult {
  const { committed, fresh, failedSources } = params
  const pairs: ComponentPair[] = Object.keys(committed.components)
    .filter((id) => fresh.components[id])
    .map((id) => ({ committedId: id, freshId: id }))
  const changes: string[] = []
  const rekeys = new Map<string, string>()
  const removed = Object.keys(committed.components).filter(
    (key) => !fresh.components[key] && !failedSources.has(committed.components[key].source.adapter)
  )
  const added = Object.keys(fresh.components).filter((key) => !committed.components[key])

  // A removed/added pair sharing display name, adapter, and file is the same component
  // under the 0.2 → 0.3 qualified-id migration. Keep this matching rule in one place so
  // relationship comparisons can use the same logical component pair.
  const consumed = new Set<string>()
  for (const oldKey of removed) {
    const committedComponent = committed.components[oldKey]
    const matches = added.filter((newKey) => {
      if (consumed.has(newKey)) return false
      const freshComponent = fresh.components[newKey]
      return (
        (freshComponent.displayName ?? freshComponent.name) ===
          (committedComponent.displayName ?? committedComponent.name) &&
        freshComponent.source.adapter === committedComponent.source.adapter &&
        (freshComponent.source.file ?? "") === (committedComponent.source.file ?? "")
      )
    })
    if (matches.length === 1) {
      const newKey = matches[0]
      consumed.add(newKey)
      rekeys.set(oldKey, newKey)
      pairs.push({ committedId: oldKey, freshId: newKey })
      changes.push(`component re-keyed: ${oldKey} → ${newKey}`)
    } else {
      changes.push(`component removed: ${oldKey}`)
    }
  }
  for (const newKey of added) {
    if (!consumed.has(newKey)) changes.push(`component added: ${newKey}`)
  }

  return { changes, pairs, rekeys }
}

function compareComponentRelationships(params: {
  committed: PrimitivContract
  fresh: PrimitivContract
  pairs: ComponentPair[]
  rekeys: Map<string, string>
  failedSources: Set<string>
}): string[] {
  const { committed, fresh, pairs, rekeys, failedSources } = params
  const changes: string[] = []
  const sortedPairs = [...pairs].sort((a, b) => compareIds(a.freshId, b.freshId))
  for (const pair of sortedPairs) {
    const committedComponent = committed.components[pair.committedId]
    const freshComponent = fresh.components[pair.freshId]
    if (failedSources.has(committedComponent.source.adapter) || failedSources.has(freshComponent.source.adapter)) {
      continue
    }

    const committedUses = canonicalizeUses(committedComponent.uses, rekeys)
    const freshUses = freshComponent.uses ?? {}
    const targetIds = [...new Set([...Object.keys(committedUses), ...Object.keys(freshUses)])].sort(compareIds)
    for (const targetId of targetIds) {
      const committedCount = committedUses[targetId]
      const freshCount = freshUses[targetId]
      if (committedCount === undefined && freshCount !== undefined) {
        changes.push(
          `component use added: ${pair.freshId} → ${targetId} (${freshCount} site${freshCount === 1 ? "" : "s"})`
        )
      } else if (committedCount !== undefined && freshCount === undefined) {
        changes.push(`component use removed: ${pair.freshId} → ${targetId}`)
      } else if (committedCount !== undefined && freshCount !== undefined && committedCount !== freshCount) {
        changes.push(`component use count changed: ${pair.freshId} → ${targetId} (${committedCount} → ${freshCount})`)
      }
    }

    const committedSites = committedComponent.usage?.sites ?? 0
    const freshSites = freshComponent.usage?.sites ?? 0
    if (committedSites !== freshSites) {
      changes.push(`component usage changed: ${pair.freshId} (${committedSites} → ${freshSites} sites)`)
    }
  }
  return changes
}

function canonicalizeUses(
  uses: Record<string, number> | undefined,
  rekeys: Map<string, string>
): Record<string, number> {
  const canonical: Record<string, number> = {}
  for (const [targetId, count] of Object.entries(uses ?? {})) {
    const canonicalId = rekeys.get(targetId) ?? targetId
    canonical[canonicalId] = (canonical[canonicalId] ?? 0) + count
  }
  return canonical
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
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
      // Directories match source patterns on name alone (`node_modules/ipaddr.js` vs
      // `**/*.js`); stat'ing one and treating it as a source file is meaningless.
      nodir: true,
      absolute: false
    })
    for (const file of matches) {
      // A file can vanish between the glob and the stat. Treat it as changed rather
      // than crashing: something moved under us, which is exactly what staleness means.
      const stat = statOrUndefined(path.resolve(codebaseRoot, file))
      if (stat === undefined || stat.mtime > threshold) {
        newer.push(file)
        if (newer.length >= MAX_DETECTED_NEWER_FILES) return newer
      }
    }
  }

  return newer
}

function decideStatus(params: {
  isStale: boolean
  hasUnresolvedConflicts: boolean
  hasViolations: boolean
  hasFailedSources: boolean
  strict: boolean
}): {
  status: VerifyStatus
  exitCode: VerifyExitCode
} {
  // Precedence: data integrity (conflicts) > completeness (failed sources, --strict only)
  // > usage (violations) > freshness (stale). A failed source is warn-and-continue by
  // default — codebase is usually the source of truth and a transient Storybook outage
  // shouldn't fail every build — but under --strict an incomplete picture is a failure.
  if (params.hasUnresolvedConflicts) return { status: "unresolved-conflicts", exitCode: 2 }
  if (params.strict && params.hasFailedSources) return { status: "source-scan-failed", exitCode: 2 }
  if (params.hasViolations) return { status: "token-misuse-detected", exitCode: params.strict ? 2 : 1 }
  if (params.isStale) return { status: "stale", exitCode: params.strict ? 2 : 1 }
  return { status: "clean", exitCode: 0 }
}

function formatAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 24) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

// Returns undefined when the path is gone — the caller decides what a vanished file means.
// Any other stat error still throws.
function statOrUndefined(absPath: string): fs.Stats | undefined {
  try {
    return fs.statSync(absPath)
  } catch (err: unknown) {
    if (typeof err === "object" && err !== null && "code" in err && (err as { code: unknown }).code === "ENOENT") {
      return undefined
    }
    throw err
  }
}

// Re-exported so callers can narrow a result's conflict list without importing the full types module.
export type { Conflict }
