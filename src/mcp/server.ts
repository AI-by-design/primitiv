import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import * as fs from "fs"
import * as path from "path"
import { PrimitivContract } from "../types"

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

    const rebuildCmd = this.contract.configPath
      ? `bunx @ai-by-design/primitiv build ${this.contract.configPath}`
      : `bunx @ai-by-design/primitiv build`

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
      warnings.push(
        `STALE CONTRACT: built ${ageDays} day${ageDays === 1 ? "" : "s"} ago. Run: ${rebuildCmd}`
      )
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
    process.on("SIGINT", () => { cleanup(); process.exit() })
    process.on("SIGTERM", () => { cleanup(); process.exit() })
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
    // @ts-ignore TS2589: SDK's dual Zod v3/v4 AnySchema union hits TypeScript's instantiation depth limit.
    // Runtime is correct — this is a known tsc limitation with this SDK version.
    this.server.registerTool(
      "get_design_context",
      {
        description: "Get the resolved design system context before building UI. Default (no category) returns a summary of counts and names. Pass category: 'all' | 'tokens' | 'components' | 'conflicts' to get full detail. Pass tokenCategory to filter tokens: colors, spacing, typography, borderRadius, shadows.",
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
            pendingConflicts: this.contract.conflicts.filter(c => c.resolution === "pending").length,
          })
        }

        const stripSource = (tokens: Record<string, { name: string; value: string; references?: string[] }>) =>
          Object.fromEntries(Object.entries(tokens).map(([k, t]) => [
            k,
            { name: t.name, value: t.value, ...(t.references ? { references: t.references } : {}) }
          ]))

        const result: Record<string, unknown> = {}
        if (category === "all" || category === "tokens") {
          result.tokens = args.tokenCategory
            ? { [args.tokenCategory]: stripSource(this.contract.tokens[args.tokenCategory] || {}) }
            : Object.fromEntries(Object.entries(this.contract.tokens).map(([cat, tokens]) => [cat, stripSource(tokens)]))
        }
        if (category === "all" || category === "components") {
          result.components = Object.fromEntries(
            Object.entries(this.contract.components).map(([k, c]) => [
              k,
              { name: c.name, source: c.source, propCount: Object.keys(c.props ?? {}).length }
            ])
          )
        }
        if (category === "all" || category === "conflicts") {
          result.conflicts = this.contract.conflicts
          result.conflictCount = this.contract.conflicts.length
          result.pendingConflicts = this.contract.conflicts.filter(c => c.resolution === "pending").length
        }
        result.generatedAt = this.contract.generatedAt
        result.sources = this.contract.sources
        return this.json(result)
      }
    )

    this.server.registerTool(
      "get_token",
      {
        description: "Look up a specific design token by name. Pass category to narrow search: colors, spacing, typography, borderRadius, shadows. Pass empty string to search all.",
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
          if (tokens && tokens[args.name]) {
            return this.json({ ...tokens[args.name], category: cat })
          }
        }
        return this.err(`Token '${args.name}' not found. Use get_design_context with category 'tokens' to see all available tokens.`)
      }
    )

    this.server.registerTool(
      "get_component",
      {
        description: "Look up a specific component by name. Returns source provenance, props, and variants so you can reuse it rather than recreate it.",
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
        description: "Get conflicts between design sources. Pass type: 'all' | 'token' | 'component'. Pass status: 'all' | 'pending' | 'resolved'.",
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
        if (type !== "all") conflicts = conflicts.filter(c => c.type === type)
        if (status !== "all") conflicts = conflicts.filter(c =>
          status === "pending" ? c.resolution === "pending" : c.resolution !== "pending"
        )
        const actionableCount = conflicts.filter(c => c.actionable === true).length
        const pendingDecisionCount = conflicts.filter(c => c.actionable === false).length
        return this.json({
          count: conflicts.length,
          actionableCount,
          pendingDecisionCount,
          conflicts: conflicts.map(c => ({
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
        description: "Get the design rules inferred from your codebase patterns. Pass category to filter: spacing, color, typography, border-radius, naming, components. Pass empty string to get all.",
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
          ? inferredRules.rules.filter(r => r.category === args.category)
          : inferredRules.rules
        return this.json({ count: rules.length, generatedAt: inferredRules.generatedAt, rules })
      }
    )
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
  }
}
