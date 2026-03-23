import * as fs from "fs"
import { PrimitivContract, TokenMap, ComponentMap, Conflict, PrimitivConfig } from "../types"
import { inferRules } from "../inferrer"

export class ContractBuilder {
  constructor(private config: PrimitivConfig) { }

  build(
    sources: Array<{
      name: string
      tokens: TokenMap
      components: ComponentMap
    }>
  ): PrimitivContract {
    const conflicts: Conflict[] = []
    const mergedTokens = this.mergeTokens(sources, conflicts)
    const mergedComponents = this.mergeComponents(sources, conflicts)
    const inferredRules = inferRules(mergedTokens, mergedComponents)

    const contract: PrimitivContract = {
      version: "0.1.0",
      generatedAt: new Date().toISOString(),
      sources: sources.map(s => s.name),
      sourceRoot: "",
      tokens: mergedTokens,
      components: mergedComponents,
      conflicts,
      inferredRules
    }

    return contract
  }

  save(contract: PrimitivContract): void {
    fs.writeFileSync(
      this.config.output.path,
      JSON.stringify(contract, null, 2),
      "utf-8"
    )
  }

  private mergeTokens(
    sources: Array<{ name: string; tokens: TokenMap; components: ComponentMap }>,
    conflicts: Conflict[]
  ): TokenMap {
    const merged: TokenMap = {
      colors: {},
      spacing: {},
      typography: {},
      borderRadius: {},
      shadows: {}
    }

    const seen: Record<string, Record<string, { source: string; value: string }>> = {}

    for (const source of sources) {
      for (const [category, tokens] of Object.entries(source.tokens)) {
        if (!merged[category]) merged[category] = {}
        if (!seen[category]) seen[category] = {}

        for (const [name, token] of Object.entries(tokens)) {
          if (seen[category][name]) {
            if (seen[category][name].value !== token.value) {
              const existingConflict = conflicts.find(
                c => c.type === "token" && c.name === `${category}.${name}`
              )

              if (existingConflict) {
                existingConflict.sources.push({ source: source.name, value: token.value })
                const fix = this.buildFixMessage("token", existingConflict.name, existingConflict.sources)
                existingConflict.suggestedFix = fix.suggestedFix
                existingConflict.actionable = fix.actionable
              } else {
                const conflictSources = [
                  { source: seen[category][name].source, value: seen[category][name].value },
                  { source: source.name, value: token.value }
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
            seen[category][name] = { source: source.name, value: token.value }
          }
        }
      }
    }

    return merged
  }

  private mergeComponents(
    sources: Array<{ name: string; tokens: TokenMap; components: ComponentMap }>,
    conflicts: Conflict[]
  ): ComponentMap {
    const merged: ComponentMap = {}

    for (const source of sources) {
      for (const [name, component] of Object.entries(source.components)) {
        if (merged[name] && merged[name].source !== source.name) {
          const conflictSources = [
            { source: merged[name].source, value: merged[name].path },
            { source: source.name, value: component.path }
          ]
          const fix = this.buildFixMessage("component", name, conflictSources)
          conflicts.push({
            type: "component",
            name,
            sources: conflictSources,
            resolution: "pending",
            suggestedFix: fix.suggestedFix,
            actionable: fix.actionable
          })

          if (this.config.governance.sourceOfTruth === source.name) {
            merged[name] = component
          }
        } else {
          merged[name] = component
        }
      }
    }

    return merged
  }

  private buildFixMessage(
    conflictType: "token" | "component",
    name: string,
    sources: Array<{ source: string; value: string }>
  ): { suggestedFix: string; actionable: boolean } {
    const sot = this.config.governance.sourceOfTruth
    const winner = sources.find(s => s.source === sot)
    const losers = sources.filter(s => s.source !== sot)

    if (conflictType === "token") {
      if (winner) {
        return {
          suggestedFix: `Token '${name}' conflicts across sources. ` +
            `'${sot}' is the source of truth (value: '${winner.value}'). ` +
            `Update ${losers.map(s => `'${s.source}'`).join(", ")} to match, ` +
            `or change \`governance.sourceOfTruth\` in primitiv.config.js.`,
          actionable: true
        }
      }
      return {
        suggestedFix: `Token '${name}' conflicts across sources (${sources.map(s => `${s.source}: '${s.value}'`).join(", ")}). ` +
          `No source of truth is configured for these sources. ` +
          `Set \`governance.sourceOfTruth\` in primitiv.config.js to resolve.`,
        actionable: false
      }
    }

    if (winner) {
      return {
        suggestedFix: `Component '${name}' is defined in multiple sources. ` +
          `'${sot}' is the source of truth (path: '${winner.value}'). ` +
          `Remove the duplicate from ${losers.map(s => `'${s.source}'`).join(", ")}, ` +
          `or change \`governance.sourceOfTruth\` in primitiv.config.js.`,
        actionable: true
      }
    }
    return {
      suggestedFix: `Component '${name}' is defined in multiple sources (${sources.map(s => `${s.source}: '${s.value}'`).join(", ")}). ` +
        `Set \`governance.sourceOfTruth\` in primitiv.config.js to resolve.`,
      actionable: false
    }
  }
}