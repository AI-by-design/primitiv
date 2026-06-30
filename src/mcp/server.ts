import * as fs from "node:fs"
import * as path from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { z } from "zod"
import { normalizeRuleCategory, RULE_CATEGORIES } from "../inferrer"
import type { LintCategory, PrimitivContract, Rationale, TokenCategory } from "../types"
import { LINT_CATEGORIES, primitivContractSchema, summarizeValidationIssues, TOKEN_CATEGORIES } from "../types"

export class PrimitivMCPServer {
  private server: McpServer
  private contract: PrimitivContract | null = null
  private watcher: fs.FSWatcher | null = null
  private derivedNameIndex: Record<string, string[]> | null = null

  constructor(private contractPath: string) {
    this.server = new McpServer({
      name: "primitiv",
      version: "0.3.0"
    })
    this.loadContract()
    this.registerTools()
    this.watchContract()
  }

  // Transport is injectable so tests can drive the real tool surface over an in-memory
  // pair; production callers take the stdio default.
  async start(transport: Transport = new StdioServerTransport()): Promise<void> {
    await this.server.connect(transport)
  }

  async stop(): Promise<void> {
    this.watcher?.close()
    await this.server.close()
  }

  private loadContract(): void {
    if (!fs.existsSync(this.contractPath)) return
    try {
      const raw = fs.readFileSync(this.contractPath, "utf-8")
      const parsed: unknown = JSON.parse(raw)
      const result = primitivContractSchema.safeParse(parsed)
      if (!result.success) {
        // Structurally invalid (e.g. truncated mid-rebuild). Keep any previously
        // loaded good contract rather than dropping it — a transient bad write
        // shouldn't take a running server's data offline.
        process.stderr.write(
          `primitiv: ignoring malformed contract at ${this.contractPath} (${summarizeValidationIssues(result.error)}). Run \`primitiv build\` to regenerate.\n`
        )
        return
      }
      this.contract = parsed as PrimitivContract
      this.derivedNameIndex = null
      this.warnIfMismatched()
    } catch {
      process.stderr.write(
        `primitiv: failed to parse contract at ${this.contractPath} (invalid JSON). Run \`primitiv build\` to regenerate.\n`
      )
    }
  }

  // displayName → ids. Contracts ≥0.3 carry the index; for older ones (bare-name keys,
  // no displayName) it's derived once per load so name lookups keep working.
  private nameIndex(): Record<string, string[]> {
    if (!this.contract) return {}
    if (this.contract.componentNameIndex) return this.contract.componentNameIndex
    if (!this.derivedNameIndex) {
      const index: Record<string, string[]> = {}
      for (const [id, c] of Object.entries(this.contract.components)) {
        const name = c.displayName ?? c.name
        if (!index[name]) index[name] = []
        index[name].push(id)
      }
      this.derivedNameIndex = index
    }
    return this.derivedNameIndex
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
    const payload = {
      error: "contract_missing",
      contractPath: this.contractPath,
      summary: "Primitiv needs a one-time setup before answering design-system questions.",
      setupCommand: "/primitiv-setup",
      estimatedDuration: "~30 seconds",
      willCreate: [
        {
          group: "Project config + contract",
          files: ["primitiv.config.js", "primitiv.contract.json"]
        },
        {
          group: "Claude Code wiring",
          files: [".claude/commands/build-component.md"]
        },
        {
          group: "Agent instructions",
          files: ["AGENTS.md or CLAUDE.md (appends a Primitiv block)"]
        }
      ],
      willModify: ["MCP config (.mcp.json or .cursor/mcp.json)"],
      uninstall:
        "Delete the files above and remove the Primitiv block from AGENTS.md/CLAUDE.md. Remove the primitiv entry from your MCP config.",
      instruction:
        "Ask the user for consent before running /primitiv-setup. Show the groups above so they know what will change."
    }
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      isError: true as const
    }
  }

  // Fold common/alias spellings to the canonical token-category key so a filter
  // never silently returns empty on e.g. "color"/"radius"/"z-index".
  private normalizeTokenCategory(category: string): string {
    const aliases: Record<string, TokenCategory> = {
      color: "colors",
      colour: "colors",
      colours: "colors",
      shadow: "shadows",
      elevation: "shadows",
      radius: "borderRadius",
      rounded: "borderRadius",
      "border-radius": "borderRadius",
      font: "typography",
      fonts: "typography",
      text: "typography",
      typo: "typography",
      space: "spacing",
      size: "sizes",
      sizing: "sizes",
      "z-index": "zIndex",
      zindex: "zIndex",
      breakpoint: "breakpoints",
      screen: "breakpoints",
      animation: "motion",
      transition: "motion"
    }
    return aliases[category.toLowerCase()] ?? category
  }

  private registerTools(): void {
    this.server.registerTool(
      "get_design_context",
      {
        description:
          "Get the resolved design system context before building UI. Read-only, no side effects. Default (no category) returns a JSON summary of token counts, component names, conflict counts, and contract metadata. Pass category: 'all' | 'tokens' | 'components' | 'conflicts' to get full detail. Pass tokenCategory to filter tokens: " +
          `${TOKEN_CATEGORIES.join(", ")} (unknown/aliased categories return an actionable error, not a silent empty result). ` +
          "Use this as the first call to understand what exists. For lookups by name, use get_token or get_component instead.",
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
            contractVersion: this.contract.version,
            sourceRoot: this.contract.sourceRoot ?? "(unknown — rebuild with latest primitiv)",
            generatedAt: this.contract.generatedAt,
            contractAgeHours,
            sources: this.contract.sources,
            tokenCounts,
            componentNames: [
              ...new Set(Object.values(this.contract.components).map((c) => c.displayName ?? c.name))
            ].sort(),
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
          if (args.tokenCategory) {
            const tc = this.normalizeTokenCategory(args.tokenCategory)
            if (!(tc in this.contract.tokens)) {
              return this.err(
                `Unknown token category '${args.tokenCategory}'. Available: ${Object.keys(this.contract.tokens).join(", ")}. Pass no tokenCategory to get all.`
              )
            }
            result.tokens = { [tc]: stripSource(this.contract.tokens[tc] ?? {}) }
          } else {
            result.tokens = Object.fromEntries(
              Object.entries(this.contract.tokens).map(([cat, tokens]) => [cat, stripSource(tokens)])
            )
          }
        }
        if (category === "all" || category === "components") {
          result.components = Object.fromEntries(
            Object.entries(this.contract.components).map(([id, c]) => [
              id,
              {
                id,
                displayName: c.displayName ?? c.name,
                ...(c.kind ? { kind: c.kind } : {}),
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
          "Look up a specific design token by name. Read-only, no side effects. Returns the token's name, value, and category, or an error if not found. Pass category to narrow search: " +
          `${TOKEN_CATEGORIES.join(", ")} (aliases like 'color'/'radius'/'z-index' are normalized). ` +
          "Pass empty string to search all. Use this when you know the token name. For a broad overview of all tokens, use get_design_context with category 'tokens' instead.",
        inputSchema: {
          name: z.string(),
          category: z.string()
        }
      },
      async (args) => {
        if (!this.contract) return this.noContract()
        const categories = args.category
          ? [this.normalizeTokenCategory(args.category)]
          : Object.keys(this.contract.tokens)
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
          "Look up a component by name or id. Read-only, no side effects. Pass context (your current working file or directory) so same-name components resolve by path scope. Returns the component JSON (with its id) when the lookup resolves to exactly one component, or an error listing available names if not found. When several components share the name and neither governance nor scope decides, returns { ambiguous, matches, instruction } — follow the instruction: match each candidate's rationale.when against the user's intent, and if that doesn't decide, ask the user; never pick arbitrarily. Use this when you need implementation details for a known component to reuse it rather than recreate it. For a list of all components, use get_design_context with category 'components' instead.",
        inputSchema: {
          name: z.string(),
          // Optional by design: a name-only lookup must keep working (and fall through to
          // the ambiguous payload on multi-match), never fail validation.
          context: z.string().optional()
        }
      },
      async (args) => {
        if (!this.contract) return this.noContract()
        const components = this.contract.components

        // Direct hit — `name` may already be a qualified id (`components/ui/Card`, `figma:Card`).
        if (components[args.name]) return this.json({ id: args.name, ...components[args.name] })

        const ids = this.nameIndex()[args.name] ?? []
        if (ids.length === 0) {
          const available = [...new Set(Object.values(components).map((c) => c.displayName ?? c.name))]
            .sort()
            .join(", ")
          return this.err(`Component '${args.name}' not found. Available: ${available}`)
        }
        if (ids.length === 1) return this.json({ id: ids[0], ...components[ids[0]] })

        // Resolution order: governance → scope → hand the decision to the agent's ladder
        // (rationale.when vs intent, then ask the user). The contract decides what it can;
        // the agent never free-chooses.
        const governed = this.contract.conflicts.find(
          (c) => c.type === "component" && c.name === args.name && c.resolved !== undefined && ids.includes(c.resolved)
        )
        if (governed?.resolved !== undefined) {
          const id = governed.resolved
          return this.json({ id, resolvedBy: "governance.sourceOfTruth", ...components[id] })
        }

        if (args.context) {
          const scoped = resolveByScope(
            ids.map((id) => ({ id, dir: components[id].scope ?? idDirectory(id) })),
            args.context
          )
          if (scoped !== null) return this.json({ id: scoped, resolvedBy: "scope", ...components[scoped] })
        }

        // Ambiguous is a governed payload, not an error — the instruction ships in the
        // response so the resolution rules hold even for an agent that never read the docs.
        return this.json({
          ambiguous: true,
          name: args.name,
          matches: ids.map((id) => {
            const c = components[id]
            return {
              id,
              displayName: c.displayName ?? c.name,
              ...(c.kind ? { kind: c.kind } : {}),
              ...(c.source.file ? { file: c.source.file } : {}),
              adapter: c.source.adapter,
              ...(c.rationale ? { rationale: c.rationale } : {})
            }
          }),
          instruction:
            "Resolve by scope against your working path, then by rationale.when vs the user's intent. " +
            "If neither decides, ask the user which component is intended — do not choose arbitrarily."
        })
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
          "Get the design rules inferred from your codebase patterns. Read-only, no side effects. Returns JSON with a list of rules including category, pattern, and confidence, or an error if no rules have been generated yet. Pass category to filter: spacing, colors, typography, borderRadius, naming, components. Pass empty string to get all. Use this to understand implicit conventions the codebase follows. For explicit design token values, use get_token. For source conflicts, use get_conflicts.",
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
        if (!args.category) {
          return this.json({
            count: inferredRules.rules.length,
            generatedAt: inferredRules.generatedAt,
            rules: inferredRules.rules
          })
        }
        const category = normalizeRuleCategory(args.category)
        if (!RULE_CATEGORIES.includes(category)) {
          return this.err(
            `Unknown rule category '${args.category}'. Valid categories: ${RULE_CATEGORIES.join(", ")}. Pass empty string to get all.`
          )
        }
        const rules = inferredRules.rules.filter((r) => r.category === category)
        return this.json({ count: rules.length, generatedAt: inferredRules.generatedAt, rules })
      }
    )

    this.server.registerTool(
      "get_violations",
      {
        description:
          "Get hardcoded token values: literals in source code typed inline instead of referencing a design token, bypassing the contract. Read-only, no side effects. Returns JSON with a count, suggestion-coverage stats, and a list with file:line:column, the captured literal, the surrounding utility (e.g. 'bg-[#ff0000]'), and an optional smart-match suggestion when a contract token has the same value. " +
          `Pass category to filter: 'all' | ${LINT_CATEGORIES.map((c) => `'${c}'`).join(" | ")} (hardcoded values are only detected for these). ` +
          "Call this BEFORE generating UI with literal values — prefer the suggested token over a hardcoded literal. For available tokens to use instead, use get_design_context or get_token.",
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
        // Surface an unknown category instead of silently returning [] (rule 10) — and only the
        // categories the linter actually emits are valid, never the full token vocabulary.
        if (args.category && args.category !== "all" && !LINT_CATEGORIES.includes(args.category as LintCategory)) {
          return this.err(
            `Unknown violation category '${args.category}'. Available: 'all', ${LINT_CATEGORIES.map((c) => `'${c}'`).join(", ")}. Token misuse is only detected for these.`
          )
        }
        const filtered =
          args.category && args.category !== "all" ? all.filter((v) => v.category === args.category) : all
        const withSuggestion = filtered.filter((v) => v.suggestion !== undefined).length
        const payload = {
          count: filtered.length,
          withSuggestion,
          withoutSuggestion: filtered.length - withSuggestion,
          violations: filtered
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload
        }
      }
    )
  }
}

// Pick the candidate whose directory (or explicit scope) most specifically contains the
// agent's working path. Component ids are scan-root-relative while the context path may be
// project-relative or absolute, so containment is segment-based: a candidate matches when
// its directory segments appear contiguously in the context's segments. The deepest unique
// match wins; a tie resolves nothing and falls through to the agent's ladder.
function resolveByScope(candidates: Array<{ id: string; dir: string }>, context: string): string | null {
  const contextSegs = pathSegments(context)
  if (contextSegs.length === 0) return null
  let best: string[] = []
  let bestDepth = 0
  for (const { id, dir } of candidates) {
    const dirSegs = pathSegments(dir)
    if (dirSegs.length === 0 || !containsSegments(contextSegs, dirSegs)) continue
    if (dirSegs.length > bestDepth) {
      best = [id]
      bestDepth = dirSegs.length
    } else if (dirSegs.length === bestDepth) {
      best.push(id)
    }
  }
  return best.length === 1 ? best[0] : null
}

// `components/ui/Card#CardHeader` → `components/ui`; `figma:Card` → `` (no scope).
function idDirectory(id: string): string {
  const noFragment = id.split("#")[0]
  const slash = noFragment.lastIndexOf("/")
  return slash === -1 ? "" : noFragment.slice(0, slash)
}

function pathSegments(p: string): string[] {
  return p.split(/[\\/]+/).filter((s) => s !== "" && s !== "." && s !== "..")
}

function containsSegments(haystack: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}
