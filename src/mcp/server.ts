import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import * as fs from "fs"
import { PrimitivContract } from "../types"

export class PrimitivMCPServer {
  private server: McpServer
  private contract: PrimitivContract | null = null

  constructor(private contractPath: string) {
    this.server = new McpServer({
      name: "primitiv",
      version: "0.1.0"
    })
    this.loadContract()
    this.registerTools()
  }

  private loadContract(): void {
    if (fs.existsSync(this.contractPath)) {
      const raw = fs.readFileSync(this.contractPath, "utf-8")
      this.contract = JSON.parse(raw)
    }
  }

  private noContract() {
    return {
      content: [{ type: "text" as const, text: "No contract found. Run `primitiv build` first." }],
      isError: true as const
    }
  }

  private registerTools(): void {
    const s = this.server as any

    s.registerTool(
      "get_design_context",
      {
        description: "Get the resolved design system context before building UI. Pass category: 'all' | 'tokens' | 'components' | 'conflicts'. Pass tokenCategory to filter tokens: colors, spacing, typography, borderRadius, shadows. Pass empty string to skip.",
        inputSchema: {
          category: z.string(),
          tokenCategory: z.string()
        }
      },
      async (args: { category: string; tokenCategory: string }) => {
        if (!this.contract) return this.noContract()
        const category = args.category || "all"
        const result: Record<string, unknown> = {}
        if (category === "all" || category === "tokens") {
          result.tokens = args.tokenCategory
            ? { [args.tokenCategory]: this.contract.tokens[args.tokenCategory] || {} }
            : this.contract.tokens
        }
        if (category === "all" || category === "components") {
          result.components = this.contract.components
        }
        if (category === "all" || category === "conflicts") {
          result.conflicts = this.contract.conflicts
          result.conflictCount = this.contract.conflicts.length
          result.pendingConflicts = this.contract.conflicts.filter(c => c.resolution === "pending").length
        }
        result.generatedAt = this.contract.generatedAt
        result.sources = this.contract.sources
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
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
            return { content: [{ type: "text" as const, text: JSON.stringify({ ...tokens[args.name], category: cat }, null, 2) }] }
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
        return { content: [{ type: "text" as const, text: JSON.stringify(component, null, 2) }] }
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
        return { content: [{ type: "text" as const, text: JSON.stringify({ count: conflicts.length, conflicts }, null, 2) }] }
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
          content: [{ type: "text" as const, text: JSON.stringify({ count: rules.length, generatedAt: inferredRules.generatedAt, rules }, null, 2) }]
        }
      }
    )
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport()
    await this.server.connect(transport)
  }
}