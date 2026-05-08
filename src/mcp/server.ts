import * as fs from "node:fs"
import * as path from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type { PrimitivContract, Rationale } from "../types"

export class PrimitivMCPServer {
  private server: McpServer
  private contract: PrimitivContract | null = null
  private watcher: fs.FSWatcher | null = null

  constructor(private contractPath: string) {
    this.server = new McpServer({
      name: "primitiv",
      version: "0.2.0"
    })
    this.loadContract()
    this.registerTools()
    this.watchContract()
  }

  private loadContract(): void {
    if (fs.existsSync(this.contractPath)) {
      try {
        const raw = fs.readFileSync(this.contractPath, "utf-8")
        this.contract = JSON.parse(raw)
        this.warnIfMismatched()
      } catch {
        process.stderr.write(`primitiv: failed to parse contract at ${this.contractPath}\n`)
      }
    }
  }

  private warnIfMismatched(): void {
    if (!this.contract?.sourceRoot) return
    const expectedRoot = path.dirname(path.resolve(this.contractPath))
    if (this.contract.sourceRoot !== expectedRoot) {
      process.stderr.write(
        `primitiv: ⚠️  CONTRACT MISMATCH — this contract was built from a different project.\n` +
          `  Contract sourceRoot: ${this.contract.sourceRoot}\n` +
          `  Expected (contract file location): ${expectedRoot}\n` +
          `  Run \`primitiv build\` in the correct project to fix this.\n`
      )
    }
  }

  private getContractWarnings(): string[] {
    const warnings: string[] = []
    if (!this.contract) return warnings

    // Use npx in warning messages — it's the universal fallback every node user has.
    // The user's actual MCP command (chosen at init time) may be bunx/pnpm dlx/yarn dlx,
    // but we can't know that at runtime without storing it in the contract.
    const rebuildCmd = this.contract.configPath
      ? `npx @ai-by-design/primitiv build ${this.contract.configPath}`
      : `npx @ai-by-design/primitiv build`

    if (this.contract.sourceRoot) {
      const expectedRoot = path.dirname(path.resolve(this.contractPath))
      if (this.contract.sourceRoot !== expectedRoot) {
        warnings.push(
          `CONTRACT MISMATCH: this contract was built from a different project (${this.contract.sourceRoot}), ` +
            `not the current one (${expectedRoot}). ` +
            `Run: ${rebuildCmd}`
        )
      }
    }

    const ageMs = Date.now() - new Date(this.contract.generatedAt).getTime()
    const ageHours = Math.floor(ageMs / (1000 * 60 * 60))
    if (ageHours >= 24) {
      const ageDays = Math.floor(ageHours / 24)
      warnings.push(`STALE CONTRACT: built ${ageDays} day${ageDays === 1 ? "" : "s"} ago. Run: ${rebuildCmd}`)
    }

    return warnings
  }

  private watchContract(): void {
    const contractDir = path.dirname(this.contractPath)
    const contractFile = path.basename(this.contractPath)
    let debounce: ReturnType<typeof setTimeout> | null = null

    try {
      this.watcher = fs.watch(contractDir, { persistent: false }, (_, filename) => {
        if (filename !== contractFile) return
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => this.loadContract(), 50)
      })
    } catch {
      process.stderr.write(`primitiv: could not watch ${contractDir} for contract changes\n`)
    }

    const cleanup = () => this.watcher?.close()
    process.on("exit", cleanup)
    process.on("SIGINT", () => {
      cleanup()
      process.exit()
    })
    process.on("SIGTERM", () => {
      cleanup()
      process.exit()
    })
  }

  private text(t: string) {
    return { content: [{ type: "text" as const, text: t }] }
  }

  private json(v: unknown) {
    return this.text(JSON.stringify(v, null, 2))
  }

  private err(msg: string) {
    return { content: [{ type: "text" as const, text: msg }], isError: true as const }
  }

  private noContract() {
    return this.err(`No contract found at ${this.contractPath}. Run \`primitiv build\` first.`)
  }

  private registerTools(): void {
    this.server.registerTool(
      "get_design_context",
      {
        description:
          "Get the resolved design system context before building UI. Read-only, no side effects. Default (no category) returns a JSON summary of token counts, component names, conflict counts, and contract metadata. Pass category: 'all' | 'tokens' | 'components' | 'conflicts' to get full detail. Pass tokenCategory to filter tokens: colors, spacing, typography, borderRadius, shadows. Use this as the first call to understand what exists. For lookups by name, use get_token or get_component instead.",
        inputSchema: {
          category: z.string(),
          tokenCategory: z.string()
        }
      },
      async (args) => {
        if (!this.contract) return this.noContract()
        const category = args.category || "summary"

        if (category === "summary") {
          const tokenCounts: Record<string, number> = {}
          for (const [cat, tokens] of Object.entries(this.contract.tokens)) {
            tokenCounts[cat] = Object.keys(tokens).length
          }
          const ageMs = Date.now() - new Date(this.contract.generatedAt).getTime()
          const contractAgeHours = Math.floor(ageMs / (1000 * 60 * 60))
          const warnings = this.getContractWarnings()
          return this.json({
            ...(warnings.length > 0 ? { warnings } : {}),
            sourceRoot: this.contract.sourceRoot ?? "(unknown — rebuild with latest primitiv)",
            generatedAt: this.contract.generatedAt,
            contractAgeHours,
            sources: this.contract.sources,
            tokenCounts,
            componentNames: Object.keys(this.contract.components),
            componentCount: Object.keys(this.contract.components).length,
            conflictCount: this.contract.conflicts.length,
            pendingConflicts: this.contract.conflicts.filter((c) => c.resolution === "pending").length,
            violationCount: (this.contract.violations ?? []).length
          })
        }

        const stripSource = (
          tokens: Record<string, { name: string; value: string; references?: string[]; rationale?: Rationale }>
        ) =>
          Object.fromEntries(
            Object.entries(tokens).map(([k, t]) => [
              k,
              {
                name: t.name,
                value: t.value,
                ...(t.references ? { references: t.references } : {}),
                ...(t.rationale ? { rationale: t.rationale } : {})
              }
            ])
          )

        const result: Record<string, unknown> = {}
        if (category === "all" || category === "tokens") {
          result.tokens = args.tokenCategory
            ? { [args.tokenCategory]: stripSource(this.contract.tokens[args.tokenCategory] || {}) }
            : Object.fromEntries(
                Object.entries(this.contract.tokens).map(([cat, tokens]) => [cat, stripSource(tokens)])
              )
        }
        if (category === "all" || category === "components") {
          result.components = Object.fromEntries(
            Object.entries(this.contract.components).map(([k, c]) => [
              k,
              {
                name: c.name,
                source: c.source,
                propCount: Object.keys(c.props ?? {}).length,
                ...(c.rationale ? { rationale: c.rationale } : {})
              }
            ])
          )
        }
        if (category === "all" || category === "conflicts") {
          result.conflicts = this.contract.conflicts
          result.conflictCount = this.contract.conflicts.length
          result.pendingConflicts = this.contract.conflicts.filter((c) => c.resolution === "pending").length
        }
        result.generatedAt = this.contract.generatedAt
        result.sources = this.contract.sources
        return this.json(result)
      }
    )

    this.server.registerTool(
      "get_token",
      {
        description:
          "Look up a specific design token by name. Read-only, no side effects. Returns the token's name, value, and category, or an error if not found. Pass category to narrow search: colors, spacing, typography, borderRadius, shadows. Pass empty string to search all. Use this when you know the token name. For a broad overview of all tokens, use get_design_context with category 'tokens' instead.",
        inputSchema: {
          name: z.string(),
          category: z.string()
        }
      },
      async (args) => {
        if (!this.contract) return this.noContract()
        const categories = args.category ? [args.category] : Object.keys(this.contract.tokens)
        for (const cat of categories) {
          const tokens = this.contract.tokens[cat]
          if (tokens?.[args.name]) {
            return this.json({ ...tokens[args.name], category: cat })
          }
        }
        return this.err(
          `Token '${args.name}' not found. Use get_design_context with category 'tokens' to see all available tokens.`
        )
      }
    )

    this.server.registerTool(
      "get_component",
      {
        description:
          "Look up a specific component by name. Read-only, no side effects. Returns JSON with source provenance, props, and variants, or an error listing available components if not found. Use this when you need implementation details for a known component to reuse it rather than recreate it. For a list of all component names, use get_design_context with category 'components' instead.",
        inputSchema: {
          name: z.string()
        }
      },
      async (args) => {
        if (!this.contract) return this.noContract()
        const component = this.contract.components[args.name]
        if (!component) {
          const available = Object.keys(this.contract.components).join(", ")
          return this.err(`Component '${args.name}' not found. Available: ${available}`)
        }
        return this.json(component)
      }
    )

    this.server.registerTool(
      "get_conflicts",
      {
        description:
          "Get conflicts between design sources. Read-only, no side effects. Returns JSON with conflict count, actionable count, and a list of conflicts with type, name, resolution status, and suggested fixes. Pass type: 'all' | 'token' | 'component'. Pass status: 'all' | 'pending' | 'resolved'. Use this to audit disagreements between sources (e.g. Figma vs codebase). For resolved design values, use get_token or get_component instead.",
        inputSchema: {
          type: z.string(),
          status: z.string()
        }
      },
      async (args) => {
        if (!this.contract) return this.noContract()
        const type = args.type || "all"
        const status = args.status || "pending"
        let conflicts = this.contract.conflicts
        if (type !== "all") conflicts = conflicts.filter((c) => c.type === type)
        if (status !== "all")
          conflicts = conflicts.filter((c) =>
            status === "pending" ? c.resolution === "pending" : c.resolution !== "pending"
          )
        const actionableCount = conflicts.filter((c) => c.actionable === true).length
        const pendingDecisionCount = conflicts.filter((c) => c.actionable === false).length
        return this.json({
          count: conflicts.length,
          actionableCount,
          pendingDecisionCount,
          conflicts: conflicts.map((c) => ({
            type: c.type,
            name: c.name,
            resolution: c.resolution,
            actionable: c.actionable ?? false,
            suggestedFix: c.suggestedFix,
            sources: c.sources
          }))
        })
      }
    )

    this.server.registerTool(
      "get_inferred_rules",
      {
        description:
          "Get the design rules inferred from your codebase patterns. Read-only, no side effects. Returns JSON with a list of rules including category, pattern, and confidence, or an error if no rules have been generated yet. Pass category to filter: spacing, color, typography, border-radius, naming, components. Pass empty string to get all. Use this to understand implicit conventions the codebase follows. For explicit design token values, use get_token. For source conflicts, use get_conflicts.",
        inputSchema: {
          category: z.string()
        }
      },
      async (args) => {
        if (!this.contract) return this.noContract()
        const inferredRules = this.contract.inferredRules
        if (!inferredRules || inferredRules.rules.length === 0) {
          return this.err("No inferred rules found. Run `primitiv build` to generate them.")
        }
        const rules = args.category
          ? inferredRules.rules.filter((r) => r.category === args.category)
          : inferredRules.rules
        return this.json({ count: rules.length, generatedAt: inferredRules.generatedAt, rules })
      }
    )

    this.server.registerTool(
      "get_violations",
      {
        description:
          "Get token-misuse violations: hardcoded literals in source code that bypass the design contract. Read-only, no side effects. Returns JSON with violation count, suggestion-coverage stats, and a list of violations with file:line:column, the captured literal, the surrounding utility (e.g. 'bg-[#ff0000]'), and an optional smart-match suggestion when a contract token has the same value. Pass category to filter: 'all' | 'colors' | 'spacing' | 'typography' | 'borderRadius' | 'shadows'. Call this BEFORE generating UI with literal values — prefer the suggested token over a hardcoded literal. For available tokens to use instead, use get_design_context or get_token.",
        inputSchema: {
          category: z.string()
        }
      },
      async (args) => {
        if (!this.contract) return this.noContract()
        const all = this.contract.violations
        if (all === undefined) {
          return this.err(
            "Contract has no violations field — likely built with an older Primitiv. Run `primitiv build` to refresh."
          )
        }
        const filtered =
          args.category && args.category !== "all" ? all.filter((v) => v.category === args.category) : all
        const withSuggestion = filtered.filter((v) => v.suggestion !== undefined).length
        return this.json({
          count: filtered.length,
          withSuggestion,
          withoutSuggestion: filtered.length - withSuggestion,
          violations: filtered
        })
      }
    )
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
  }
}
