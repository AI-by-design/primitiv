import * as fs from "node:fs"
import { compareConflictsCanonical } from "../conflict-order"
import { inferRules } from "../inferrer"
import { valuesEquivalent } from "../normalize/value"
import { safeDisplayText } from "../safe-display"
import type {
  ComponentMap,
  Conflict,
  ConflictEvidence,
  PrimitivConfig,
  PrimitivContract,
  SourceProvenance,
  SourceStatus,
  Token,
  TokenMap,
  TokenRedefinition
} from "../types"
import { emptyTokenMap, primitivContractSchema, summarizeValidationIssues } from "../types"
import {
  type ComponentReconciliationGroup,
  componentReconciliationGroups,
  reconcileComponentFields
} from "./component-reconciliation"

export class ContractBuilder {
  constructor(private config: PrimitivConfig) {}

  build(
    sources: Array<{
      name: string
      tokens: TokenMap
      components: ComponentMap
      // Same-name-different-value definitions found WITHIN this source — invisible to the
      // cross-source merge below (each source's map is collapsed before it), so the source
      // reports them and they surface as conflicts here (rule 11).
      redefinitions?: TokenRedefinition[]
    }>,
    options: { sourceStatuses?: Record<string, SourceStatus> } = {}
  ): PrimitivContract {
    const orderedSources = [...sources].sort((a, b) => compareStrings(a.name, b.name))
    const conflicts: Conflict[] = []
    const mergedTokens = this.mergeTokens(orderedSources, conflicts)
    const { components, nameIndex } = this.mergeComponents(orderedSources)
    const groups = componentReconciliationGroups(
      components,
      nameIndex,
      this.config.reconciliation?.componentMappings,
      options.sourceStatuses
    )
    const nameResolutions = this.componentNameResolutions(components, nameIndex, groups)
    conflicts.push(
      ...reconcileComponentFields({
        groups,
        config: this.config,
        sourceStatuses: options.sourceStatuses
      })
    )
    if (this.config.governance.onConflict === "auto-resolve") this.autoResolveConflicts(conflicts)
    // Folded in AFTER the merge + auto-resolve passes on purpose: mergeTokens appends to
    // existing conflicts by name, and a same-source dispute must never share a record with
    // (or be auto-resolved alongside) a cross-source one — a source can't arbitrate itself.
    conflicts.push(...this.redefinitionConflicts(orderedSources))
    assertGeneratedConflictScopes(conflicts)
    this.sortConflicts(conflicts)
    const inferredRules = inferRules(mergedTokens, components)

    const contract: PrimitivContract = {
      // 0.3.0: component keys went bare-name → qualified id (breaking shape change).
      version: "0.3.0",
      generatedAt: new Date().toISOString(),
      sources: orderedSources.map((source) => source.name),
      sourceRoot: "",
      configPath: "",
      tokens: mergedTokens,
      components,
      componentNameIndex: nameIndex,
      ...(Object.keys(nameResolutions).length > 0 ? { componentNameResolutions: nameResolutions } : {}),
      conflicts,
      inferredRules,
      ...(options.sourceStatuses ? { sourceStatuses: sortSourceStatuses(options.sourceStatuses) } : {})
    }

    assertValidContractBoundary(contract, "Generated contract")
    return contract
  }

  save(contract: PrimitivContract): void {
    assertValidContractBoundary(contract, "Contract write")
    fs.writeFileSync(this.config.output.path, JSON.stringify(contract, null, 2), "utf-8")
  }

  private mergeTokens(
    sources: Array<{ name: string; tokens: TokenMap; components: ComponentMap }>,
    conflicts: Conflict[]
  ): TokenMap {
    const merged: TokenMap = emptyTokenMap()

    const seen: Record<string, Record<string, { adapter: string; value: string }>> = {}

    for (const source of sources) {
      for (const [category, tokens] of Object.entries(source.tokens)) {
        if (!merged[category]) merged[category] = {}
        if (!seen[category]) seen[category] = {}

        for (const [name, token] of Object.entries(tokens)) {
          if (seen[category][name]) {
            if (!valuesEquivalent(seen[category][name].value, token.value, category)) {
              const existingConflict = conflicts.find((c) => c.type === "token" && c.name === `${category}.${name}`)

              if (existingConflict) {
                existingConflict.sources.push({ source: token.source, value: token.value })
                const fix = this.buildFixMessage("token", existingConflict.name, existingConflict.sources)
                existingConflict.suggestedFix = fix.suggestedFix
                existingConflict.actionable = fix.actionable
              } else {
                const firstToken = merged[category][name]
                const conflictSources = [
                  { source: firstToken.source, value: firstToken.value },
                  { source: token.source, value: token.value }
                ]
                const fix = this.buildFixMessage("token", `${category}.${name}`, conflictSources)
                conflicts.push({
                  type: "token",
                  scope: "cross-source",
                  name: `${category}.${name}`,
                  sources: conflictSources,
                  resolution: "pending",
                  suggestedFix: fix.suggestedFix,
                  actionable: fix.actionable
                })
              }

              if (this.config.governance.sourceOfTruth === source.name) {
                // Default and mode values are independent evidence. Selecting a new default
                // must never discard a mode the incoming source simply did not provide.
                const existing = merged[category][name]
                merged[category][name] = this.withRetainedModes(token, existing)
                // Later sources must compare with the elected value, not the first source's
                // value. This matters as soon as a third token-producing adapter participates.
                seen[category][name] = { adapter: source.name, value: token.value }
              }
            }
            this.mergeModes(merged[category][name], token, source.name, category, name, conflicts)
          } else {
            merged[category][name] = this.copyTokenWithModeSources(token)
            seen[category][name] = { adapter: source.name, value: token.value }
          }
        }
      }
    }

    return merged
  }

  private copyTokenWithModeSources(token: Token): Token {
    if (!token.modes || Object.keys(token.modes).length === 0) return { ...token }
    const modes = { ...token.modes }
    const modeSources = Object.fromEntries(
      Object.keys(modes).map((mode) => [mode, token.modeSources?.[mode] ?? token.source])
    ) as Record<string, SourceProvenance>
    return { ...token, modes, modeSources }
  }

  private withRetainedModes(next: Token, existing: Token): Token {
    const selected = this.copyTokenWithModeSources(next)
    if (!existing.modes || Object.keys(existing.modes).length === 0) return selected
    return { ...selected, modes: { ...existing.modes }, modeSources: { ...existing.modeSources } }
  }

  private mergeModes(
    merged: Token,
    incoming: Token,
    sourceName: string,
    category: string,
    name: string,
    conflicts: Conflict[]
  ): void {
    if (!incoming.modes || Object.keys(incoming.modes).length === 0) return
    if (!merged.modes) merged.modes = {}
    if (!merged.modeSources) merged.modeSources = {}

    for (const [mode, value] of Object.entries(incoming.modes)) {
      const incomingSource = incoming.modeSources?.[mode] ?? incoming.source
      const existingValue = merged.modes[mode]
      if (existingValue === undefined) {
        merged.modes[mode] = value
        merged.modeSources[mode] = incomingSource
        continue
      }
      if (valuesEquivalent(existingValue, value, category)) continue

      const existingSource = merged.modeSources[mode] ?? merged.source
      const conflictName = `${category}.${name}.modes.${mode}`
      const existingConflict = conflicts.find((c) => c.type === "token" && c.name === conflictName)
      if (existingConflict) {
        existingConflict.sources.push({ source: incomingSource, value })
        const fix = this.buildFixMessage("token", conflictName, existingConflict.sources)
        existingConflict.suggestedFix = fix.suggestedFix
        existingConflict.actionable = fix.actionable
      } else {
        const conflictSources = [
          { source: existingSource, value: existingValue },
          { source: incomingSource, value }
        ]
        const fix = this.buildFixMessage("token", conflictName, conflictSources)
        conflicts.push({
          type: "token",
          scope: "cross-source",
          name: conflictName,
          sources: conflictSources,
          resolution: "pending",
          suggestedFix: fix.suggestedFix,
          actionable: fix.actionable
        })
      }

      if (this.config.governance.sourceOfTruth === sourceName) {
        merged.modes[mode] = value
        merged.modeSources[mode] = incomingSource
      }
    }
  }

  private mergeComponents(sources: Array<{ name: string; tokens: TokenMap; components: ComponentMap }>): {
    components: ComponentMap
    nameIndex: Record<string, string[]>
  } {
    const merged: ComponentMap = Object.create(null) as ComponentMap

    for (const source of sources) {
      for (const [id, component] of Object.entries(source.components)) {
        // Ids are unique by construction (path-qualified for codebase, source-prefixed for
        // figma/storybook), so same-name components coexist instead of overwriting each
        // other. A taken key is a true duplicate — keep the first, mirroring the token path.
        if (!(id in merged)) merged[id] = component
      }
    }

    // The lookup bridge from the bare names agents know to the qualified ids. Sorted for
    // deterministic contract output across rebuilds.
    const nameIndex: Record<string, string[]> = Object.create(null) as Record<string, string[]>
    for (const [id, component] of Object.entries(merged)) {
      const name = component.displayName ?? component.name
      if (!(name in nameIndex)) nameIndex[name] = []
      nameIndex[name].push(id)
    }
    const sortedNameIndex = Object.create(null) as Record<string, string[]>
    for (const name of Object.keys(nameIndex).sort(compareStrings)) {
      sortedNameIndex[name] = nameIndex[name].sort(compareStrings)
    }
    const sortedComponents = Object.create(null) as ComponentMap
    for (const id of Object.keys(merged).sort(compareStrings)) sortedComponents[id] = merged[id]

    return { components: sortedComponents, nameIndex: sortedNameIndex }
  }

  private componentNameResolutions(
    components: ComponentMap,
    nameIndex: Record<string, string[]>,
    groups: ComponentReconciliationGroup[]
  ): Record<string, string> {
    const sourceOfTruth = this.config.governance.sourceOfTruth
    const resolutions: Record<string, string> = Object.create(null) as Record<string, string>
    if (sourceOfTruth === "manual") return resolutions
    for (const name of Object.keys(nameIndex).sort(compareStrings)) {
      const authoritative = nameIndex[name].filter((id) => components[id]?.source.adapter === sourceOfTruth)
      if (authoritative.length === 1) {
        resolutions[name] = authoritative[0]
        continue
      }
      const explicitlyMapped = groups
        .filter(
          (group) =>
            group.explicitlyMapped &&
            group.members.some((member) => (member.component.displayName ?? member.component.name) === name)
        )
        .flatMap((group) => group.members)
        .filter(
          (member) =>
            member.component.source.adapter === sourceOfTruth &&
            (member.component.displayName ?? member.component.name) === name
        )
        .map((member) => member.id)
      const uniqueMapped = [...new Set(explicitlyMapped)].sort(compareStrings)
      if (uniqueMapped.length === 1) resolutions[name] = uniqueMapped[0]
    }
    return resolutions
  }

  // Under onConflict: "auto-resolve", a conflict the source of truth already decides is
  // marked resolution: "auto" so build and verify pass on it. Genuine standoffs — no SoT
  // contender — stay "pending". Under "warn"/"error" even SoT-decided conflicts stay
  // pending on purpose: surfacing beats silencing, and "auto-resolve" is the explicit
  // opt-in. The conflict record itself is never dropped either way (rule 11).
  private autoResolveConflicts(conflicts: Conflict[]): void {
    const sot = this.config.governance.sourceOfTruth
    for (const conflict of conflicts) {
      // A source can never arbitrate a dispute within itself: a conflict whose sources all
      // share one adapter (a same-source redefinition) stays pending regardless of
      // sourceOfTruth — the `some(adapter === sot)` check below would wrongly self-resolve it.
      if (
        conflict.scope === "within-source" ||
        (conflict.scope === undefined && new Set(conflict.sources.map((s) => s.source.adapter)).size < 2)
      ) {
        continue
      }
      const sotDecided =
        conflict.type === "component"
          ? conflict.fieldPath !== undefined
            ? conflict.fieldResolution !== undefined
            : conflict.resolved !== undefined
          : conflict.sources.some((s) => s.source.adapter === sot)
      if (sotDecided) conflict.resolution = "auto"
    }
  }

  private sortConflicts(conflicts: Conflict[]): void {
    for (const conflict of conflicts) conflict.sources.sort(compareConflictEvidence)
    conflicts.sort(compareConflictsCanonical)
  }

  // A token defined more than once with different values inside ONE source becomes a
  // pending conflict carrying every definition's provenance. Kept separate from the
  // cross-source records (never merged by name) and never auto-resolved.
  private redefinitionConflicts(sources: Array<{ name: string; redefinitions?: TokenRedefinition[] }>): Conflict[] {
    const out: Conflict[] = []
    for (const source of sources) {
      for (const redef of source.redefinitions ?? []) {
        const all = [redef.kept, ...redef.discarded]
        const displayName = safeDisplayText(`${redef.category}.${redef.name}`)
        const displaySource = safeDisplayText(source.name)
        out.push({
          type: "token",
          scope: "within-source",
          name: `${redef.category}.${redef.name}`,
          sources: all.map((d) => ({ source: d.source, value: d.value })),
          resolution: "pending",
          actionable: true,
          suggestedFix:
            `Token '${displayName}' is defined ${all.length} times within '${displaySource}' with different values. ` +
            `Review the labelled source evidence. ` +
            `Remove the other definition${redef.discarded.length === 1 ? "" : "s"} so one value remains.`
        })
      }
    }
    return out
  }

  private buildFixMessage(
    conflictType: "token" | "component",
    name: string,
    sources: Array<{ source: { adapter: string }; value: string }>
  ): { suggestedFix: string; actionable: boolean } {
    const sot = this.config.governance.sourceOfTruth
    const winner = sources.find((s) => s.source.adapter === sot)
    const losers = sources.filter((s) => s.source.adapter !== sot)
    const displayName = safeDisplayText(name)
    const displaySourceOfTruth = safeDisplayText(sot)

    if (conflictType === "token") {
      if (winner) {
        return {
          suggestedFix:
            `Token '${displayName}' conflicts across sources. ` +
            `'${displaySourceOfTruth}' is the source of truth. Review the labelled source evidence, then ` +
            `update ${losers.map((s) => `'${safeDisplayText(s.source.adapter)}'`).join(", ")} to match, ` +
            `or change \`governance.sourceOfTruth\` in primitiv.config.js.`,
          actionable: true
        }
      }
      return {
        suggestedFix:
          `Token '${displayName}' conflicts across sources. Review the labelled source evidence. ` +
          `No source of truth is configured for the participating sources. ` +
          `Set \`governance.sourceOfTruth\` in primitiv.config.js to resolve.`,
        actionable: false
      }
    }

    if (winner) {
      return {
        suggestedFix:
          `Component '${displayName}' is defined in multiple sources. ` +
          `'${displaySourceOfTruth}' is the source of truth. Review the labelled source evidence, then ` +
          `remove the duplicate from ${losers.map((s) => `'${safeDisplayText(s.source.adapter)}'`).join(", ")}, ` +
          `or change \`governance.sourceOfTruth\` in primitiv.config.js.`,
        actionable: true
      }
    }
    return {
      suggestedFix:
        `Component '${displayName}' is defined in multiple sources. Review the labelled source evidence. ` +
        `Set \`governance.sourceOfTruth\` in primitiv.config.js to resolve.`,
      actionable: false
    }
  }
}

function compareConflictEvidence(a: ConflictEvidence, b: ConflictEvidence): number {
  return (
    compareStrings(a.source.adapter, b.source.adapter) ||
    compareStrings(a.componentId ?? "", b.componentId ?? "") ||
    compareStrings(JSON.stringify(a.factPath ?? []), JSON.stringify(b.factPath ?? [])) ||
    compareStrings(a.value, b.value)
  )
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function assertGeneratedConflictScopes(conflicts: Conflict[]): void {
  if (conflicts.some((conflict) => conflict.scope === undefined)) {
    throw new Error("Internal conflict construction error: every newly generated conflict must declare its scope.")
  }
}

function assertValidContractBoundary(
  contract: PrimitivContract,
  operation: "Generated contract" | "Contract write"
): void {
  const result = primitivContractSchema.safeParse(contract)
  if (result.success) return
  throw new Error(
    `${operation} rejected unsafe or oversized machine identifiers (${summarizeValidationIssues(result.error)}). ` +
      "Fix the source IDs or reconciliation.componentMappings, then rebuild."
  )
}

function sortSourceStatuses(statuses: Record<string, SourceStatus>): Record<string, SourceStatus> {
  return Object.fromEntries(
    Object.keys(statuses)
      .sort(compareStrings)
      .map((name) => [name, { ...statuses[name] }])
  )
}
