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
      version: "0.1.0"
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
      } catch {
        process.stderr.write(`primitiv: failed to parse contract at ${this.contractPath}\n`)
      }
    }
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

    process.on("exit", () => this.watcher?.close())
    process.on("SIGINT", () => { this.watcher?.close(); process.exit() })
  }

  private noContract() {
    return {
      content: [{ type: "text" as const, text: `No contract found at ${this.contractPath}. Run \`primitiv build\` first.` }],
      isError: true as const
    }
  }

  private registerTools(): void {
    const s = this.server as any

    s.registerTool(
      "get_design_context",
      {
        description: "Get the resolved design system context before building UI. Default (no category) returns a summary of counts and names. Pass category: 'all' | 'tokens' | 'components' | 'conflicts' to get full detail. Pass tokenCategory to filter tokens: colors, spacing, typography, borderRadius, shadows.",
        inputSchema: {
          category: z.string(),
          tokenCategory: z.string()
        }
      },
      async (args: { category: string; tokenCategory: string }) => {
        if (!this.contract) return this.noContract()
        const category = args.category || "summary"

        if (category === "summary") {
          const tokenCounts: Record<string, number> = {}
          for (const [cat, tokens] of Object.entries(this.contract.tokens)) {
            tokenCounts[cat] = Object.keys(tokens).length
          }
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                tokenCounts,
                componentNames: Object.keys(this.contract.components),
                componentCount: Object.keys(this.contract.components).length,
                conflictCount: this.contract.conflicts.length,
                pendingConflicts: this.contract.conflicts.filter(c => c.resolution === "pending").length,
                generatedAt: this.contract.generatedAt,
                sources: this.contract.sources
              })
            }]
          }
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
              { name: c.name, path: c.path, propCount: Object.keys(c.props ?? {}).length }
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
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] }
      }
    )

    s.registerTool(
      "get_token",
      {
        description: "Look up a specific design token by name. Pass category to narrow search: colors, spacing, typography, borderRadius, shadows. Pass empty string to search all.",
        inputSchema: {
          name: z.string(),
          category: z.string()
        }
      },
      async (args: { name: string; category: string }) => {
        if (!this.contract) return this.noContract()
        const categories = args.category ? [args.category] : Object.keys(this.contract.tokens)
        for (const cat of categories) {
          const tokens = this.contract.tokens[cat]
          if (tokens && tokens[args.name]) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ ...tokens[args.name], category: cat }) }] }
          }
        }
        return {
          content: [{ type: "text" as const, text: `Token '${args.name}' not found. Use get_design_context with category 'tokens' to see all available tokens.` }],
          isError: true as const
        }
      }
    )

    s.registerTool(
      "get_component",
      {
        description: "Look up a specific component by name. Returns path, props, and source so you can reuse it rather than recreate it.",
        inputSchema: {
          name: z.string()
        }
      },
      async (args: { name: string }) => {
        if (!this.contract) return this.noContract()
        const component = this.contract.components[args.name]
        if (!component) {
          const available = Object.keys(this.contract.components).join(", ")
          return {
            content: [{ type: "text" as const, text: `Component '${args.name}' not found. Available: ${available}` }],
            isError: true as const
          }
        }
        return { content: [{ type: "text" as const, text: JSON.stringify(component) }] }
      }
    )

    s.registerTool(
      "get_conflicts",
      {
        description: "Get conflicts between design sources. Pass type: 'all' | 'token' | 'component'. Pass status: 'all' | 'pending' | 'resolved'.",
        inputSchema: {
          type: z.string(),
          status: z.string()
        }
      },
      async (args: { type: string; status: string }) => {
        if (!this.contract) return this.noContract()
        const type = args.type || "all"
        const status = args.status || "pending"
        let conflicts = this.contract.conflicts
        if (type !== "all") conflicts = conflicts.filter(c => c.type === type)
        if (status !== "all") conflicts = conflicts.filter(c =>
          status === "pending" ? c.resolution === "pending" : c.resolution !== "pending"
        )
        return { content: [{ type: "text" as const, text: JSON.stringify({ count: conflicts.length, conflicts }) }] }
      }
    )

    s.registerTool(
      "get_inferred_rules",
      {
        description: "Get the design rules inferred from your codebase patterns. Pass category to filter: spacing, color, typography, border-radius, naming, components. Pass empty string to get all.",
        inputSchema: {
          category: z.string()
        }
      },
      async (args: { category: string }) => {
        if (!this.contract) return this.noContract()
        const inferredRules = this.contract.inferredRules
        if (!inferredRules || inferredRules.rules.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No inferred rules found. Run `primitiv build` to generate them." }],
            isError: true as const
          }
        }
        const rules = args.category
          ? inferredRules.rules.filter(r => r.category === args.category)
          : inferredRules.rules
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ count: rules.length, generatedAt: inferredRules.generatedAt, rules }) }]
        }
      }
    )
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
  }
}