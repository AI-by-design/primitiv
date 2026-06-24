import * as fs from "node:fs"
import { inferRules } from "../inferrer"
import { emptyTokenMap } from "../types"
import type { ComponentMap, Conflict, PrimitivConfig, PrimitivContract, TokenMap } from "../types"

export class ContractBuilder {
  constructor(private config: PrimitivConfig) {}

  build(
    sources: Array<{
      name: string
      tokens: TokenMap
      components: ComponentMap
    }>
  ): PrimitivContract {
    const conflicts: Conflict[] = []
    const mergedTokens = this.mergeTokens(sources, conflicts)
    const { components, nameIndex } = this.mergeComponents(sources, conflicts)
    const inferredRules = inferRules(mergedTokens, components)

    const contract: PrimitivContract = {
      // 0.3.0: component keys went bare-name → qualified id (breaking shape change).
      version: "0.3.0",
      generatedAt: new Date().toISOString(),
      sources: sources.map((s) => s.name),
      sourceRoot: "",
      configPath: "",
      tokens: mergedTokens,
      components,
      componentNameIndex: nameIndex,
      conflicts,
      inferredRules
    }

    return contract
  }

  save(contract: PrimitivContract): void {
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
            if (seen[category][name].value !== token.value) {
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
                  name: `${category}.${name}`,
                  sources: conflictSources,
                  resolution: "pending",
                  suggestedFix: fix.suggestedFix,
                  actionable: fix.actionable
                })
              }

              if (this.config.governance.sourceOfTruth === source.name) {
                merged[category][name] = token
              }
            }
          } else {
            merged[category][name] = token
            seen[category][name] = { adapter: source.name, value: token.value }
          }
        }
      }
    }

    return merged
  }

  private mergeComponents(
    sources: Array<{ name: string; tokens: TokenMap; components: ComponentMap }>,
    conflicts: Conflict[]
  ): { components: ComponentMap; nameIndex: Record<string, string[]> } {
    const merged: ComponentMap = {}

    for (const source of sources) {
      for (const [id, component] of Object.entries(source.components)) {
        // Ids are unique by construction (path-qualified for codebase, source-prefixed for
        // figma/storybook), so same-name components coexist instead of overwriting each
        // other. A taken key is a true duplicate — keep the first, mirroring the token path.
        if (!merged[id]) merged[id] = component
      }
    }

    // The lookup bridge from the bare names agents know to the qualified ids. Sorted for
    // deterministic contract output across rebuilds.
    const nameIndex: Record<string, string[]> = {}
    for (const [id, component] of Object.entries(merged)) {
      const name = component.displayName ?? component.name
      if (!nameIndex[name]) nameIndex[name] = []
      nameIndex[name].push(id)
    }
    for (const ids of Object.values(nameIndex)) ids.sort()

    // Cross-source conflict detection moved from key-equality to displayName grouping —
    // keys stopped colliding across sources once they became qualified ids. Same-name
    // within one source is coexistence (surfaced via the index and resolved at lookup
    // time by scope/rationale), never a conflict; hard conflicts stay reserved for
    // cross-source disagreements.
    for (const [name, ids] of Object.entries(nameIndex)) {
      if (ids.length < 2) continue
      const adapters = new Set(ids.map((id) => merged[id].source.adapter))
      if (adapters.size < 2) continue

      const conflictSources = ids.map((id) => ({
        source: merged[id].source,
        value: merged[id].source.file || merged[id].source.adapter
      }))
      const fix = this.buildFixMessage("component", name, conflictSources)
      const sotIds = ids.filter((id) => merged[id].source.adapter === this.config.governance.sourceOfTruth)
      conflicts.push({
        type: "component",
        name,
        sources: conflictSources,
        // When the source of truth owns exactly one contender, record the governed winner
        // so get_component returns it instead of escalating. Every contender stays in the
        // component map either way — provenance is never dropped.
        ...(sotIds.length === 1 ? { resolved: sotIds[0] } : {}),
        resolution: "pending",
        suggestedFix: fix.suggestedFix,
        actionable: fix.actionable
      })
    }

    return { components: merged, nameIndex }
  }

  private buildFixMessage(
    conflictType: "token" | "component",
    name: string,
    sources: Array<{ source: { adapter: string }; value: string }>
  ): { suggestedFix: string; actionable: boolean } {
    const sot = this.config.governance.sourceOfTruth
    const winner = sources.find((s) => s.source.adapter === sot)
    const losers = sources.filter((s) => s.source.adapter !== sot)

    if (conflictType === "token") {
      if (winner) {
        return {
          suggestedFix:
            `Token '${name}' conflicts across sources. ` +
            `'${sot}' is the source of truth (value: '${winner.value}'). ` +
            `Update ${losers.map((s) => `'${s.source.adapter}'`).join(", ")} to match, ` +
            `or change \`governance.sourceOfTruth\` in primitiv.config.js.`,
          actionable: true
        }
      }
      return {
        suggestedFix:
          `Token '${name}' conflicts across sources (${sources.map((s) => `${s.source.adapter}: '${s.value}'`).join(", ")}). ` +
          `No source of truth is configured for these sources. ` +
          `Set \`governance.sourceOfTruth\` in primitiv.config.js to resolve.`,
        actionable: false
      }
    }

    if (winner) {
      return {
        suggestedFix:
          `Component '${name}' is defined in multiple sources. ` +
          `'${sot}' is the source of truth (path: '${winner.value}'). ` +
          `Remove the duplicate from ${losers.map((s) => `'${s.source.adapter}'`).join(", ")}, ` +
          `or change \`governance.sourceOfTruth\` in primitiv.config.js.`,
        actionable: true
      }
    }
    return {
      suggestedFix:
        `Component '${name}' is defined in multiple sources (${sources.map((s) => `${s.source.adapter}: '${s.value}'`).join(", ")}). ` +
        `Set \`governance.sourceOfTruth\` in primitiv.config.js to resolve.`,
      actionable: false
    }
  }
}
