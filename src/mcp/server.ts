import * as fs from "node:fs"
import * as path from "node:path"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { normalizeRuleCategory, RULE_CATEGORIES } from "../inferrer"
import { safeDisplayText } from "../safe-display"
import type { Component, LintCategory, PrimitivContract, Rationale, TokenCategory } from "../types"
import { LINT_CATEGORIES, primitivContractSchema, summarizeValidationIssues, TOKEN_CATEGORIES } from "../types"

export class PrimitivMCPServer {
  private server: McpServer
  private contract: PrimitivContract | null = null
  private watcher: fs.FSWatcher | null = null
  private derivedNameIndex: Record<string, string[]> | null = null
  private derivedUsedByIndex: Record<string, Record<string, number>> | null = null
  private validatedRelationshipFacts: Record<string, RelationshipFacts> = {}

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
      this.derivedUsedByIndex = null
      this.validatedRelationshipFacts = {}
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

  private usedByIndex(facts: Record<string, RelationshipFacts>): Record<string, Record<string, number>> {
    if (!this.contract) return {}
    if (this.derivedUsedByIndex) return this.derivedUsedByIndex

    const index: Record<string, Record<string, number>> = {}
    for (const ownerId of Object.keys(this.contract.components).sort(compareStrings)) {
      const ownerFacts = facts[ownerId]
      for (const targetId of Object.keys(ownerFacts.uses ?? {}).sort(compareStrings)) {
        if (!index[targetId]) index[targetId] = {}
        index[targetId][ownerId] = ownerFacts.uses?.[targetId] ?? 0
      }
    }

    this.derivedUsedByIndex = Object.fromEntries(
      Object.keys(index)
        .sort(compareStrings)
        .map((targetId) => [targetId, sortCountMap(index[targetId])])
    )
    return this.derivedUsedByIndex
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

    // A source that failed when this contract was built means its data may be missing —
    // agents must know they're reading a partial picture, not a complete one.
    for (const [name, status] of Object.entries(this.contract.sourceStatuses ?? {})) {
      if (status.status !== "failed") continue
      warnings.push(
        `SOURCE FAILED: the '${name}' scan failed when this contract was built${status.error ? ` (${status.error})` : ""}. ` +
          `Its data may be missing from the contract. Fix the source and run: ${rebuildCmd}`
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
          files: ["AGENTS.md or CLAUDE.md (adds Primitiv instructions; CLAUDE.md references AGENTS.md when both exist)"]
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
        annotations: { readOnlyHint: true },
        inputSchema: {
          category: z.string().optional(),
          tokenCategory: z.string().optional()
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
            ...(this.contract.sourceStatuses ? { sourceStatuses: this.contract.sourceStatuses } : {}),
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
          tokens: Record<
            string,
            {
              name: string
              value: string
              references?: string[]
              rationale?: Rationale
              modes?: Record<string, string>
            }
          >
        ) =>
          Object.fromEntries(
            Object.entries(tokens).map(([k, t]) => [
              k,
              {
                name: t.name,
                value: t.value,
                ...(t.references ? { references: t.references } : {}),
                ...(t.rationale ? { rationale: t.rationale } : {}),
                ...(t.modes ? { modes: t.modes } : {})
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
                source: projectCompactSource(c.source),
                propCount: Object.keys(c.props ?? {}).length,
                propNames: Object.keys(c.props ?? {}).sort(compareStrings),
                ...(c.rationale ? { rationale: c.rationale } : {})
              }
            ])
          )
        }
        if (category === "all" || category === "conflicts") {
          const page = projectConflictPage(this.contract.conflicts)
          if (!page.success) return this.err(page.error)
          result.conflicts = page.items
          result.conflictCount = page.total
          result.pendingConflicts = page.pending
          result.conflictsTruncated = page.items.length < page.total
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
          "Omit category to search all. Use this when you know the token name. For a broad overview of all tokens, use get_design_context with category 'tokens' instead.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          name: z.string(),
          category: z.string().optional()
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
          "Look up a component by name or id. Read-only, no side effects. Pass context (your current working file or directory) so same-name components resolve by path scope. Returns the component JSON (with its id) when the lookup resolves to exactly one component, or an error listing available names if not found. Detail is opt-in: pass 'api' for the component's declared prop contract, 'usage' for static JSX-site counts and observed prop values, 'relationships' for sorted outgoing uses and derived incoming usedBy counts, or 'all' for every projection. These are static source-site facts, never runtime frequency. When several components share the name and neither governance nor scope decides, returns { ambiguous, matches, instruction } — follow the instruction: match each candidate's rationale.when against the user's intent, and if that doesn't decide, ask the user; never pick arbitrarily. Use this when you need implementation details for a known component to reuse it rather than recreate it. For a list of all components, use get_design_context with category 'components' instead.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          name: z.string(),
          // Optional by design: a name-only lookup must keep working (and fall through to
          // the ambiguous payload on multi-match), never fail validation.
          context: z.string().optional(),
          detail: componentDetailSchema.optional()
        }
      },
      async (args) => {
        if (!this.contract) return this.noContract()
        const components = this.contract.components

        // Direct hit — `name` may already be a qualified id (`components/ui/Card`, `figma:Card`).
        if (components[args.name]) return this.componentResponse({ id: args.name, detail: args.detail })

        const ids = this.nameIndex()[args.name] ?? []
        if (ids.length === 0) {
          const available = [...new Set(Object.values(components).map((c) => c.displayName ?? c.name))]
            .sort()
            .join(", ")
          return this.err(`Component '${args.name}' not found. Available: ${available}`)
        }
        if (ids.length === 1) return this.componentResponse({ id: ids[0], detail: args.detail })

        // Resolution order: governance → scope → hand the decision to the agent's ladder
        // (rationale.when vs intent, then ask the user). The contract decides what it can;
        // the agent never free-chooses.
        const governed = this.contract.conflicts.find(
          (c) => c.type === "component" && c.name === args.name && c.resolved !== undefined && ids.includes(c.resolved)
        )
        if (governed?.resolved !== undefined) {
          const id = governed.resolved
          return this.componentResponse({
            id,
            detail: args.detail,
            resolvedBy: "governance.sourceOfTruth"
          })
        }

        if (args.context) {
          const scoped = resolveByScope(
            ids.map((id) => ({ id, dir: components[id].scope ?? idDirectory(id) })),
            args.context
          )
          if (scoped !== null) return this.componentResponse({ id: scoped, detail: args.detail, resolvedBy: "scope" })
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
          "Get conflicts between design sources. Read-only, no side effects. Returns JSON with conflict count, actionable count, and a list of conflicts with type, name, resolution status, and suggested fixes. Pass type: 'all' | 'token' | 'component' (default 'all'). Pass status: 'all' | 'pending' | 'resolved' (default 'pending'). Use this to audit disagreements between sources (e.g. Figma vs codebase). For resolved design values, use get_token or get_component instead.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: z.string().optional(),
          status: z.string().optional()
        }
      },
      async (args) => {
        if (!this.contract) return this.noContract()
        const type = args.type || "all"
        const status = args.status || "pending"
        const parsedConflicts = parseConflictProjectionInputs(this.contract.conflicts)
        if (!parsedConflicts.success) return this.err(parsedConflicts.error)
        let conflicts = parsedConflicts.items
        if (type !== "all") conflicts = conflicts.filter((c) => c.type === type)
        if (status !== "all")
          conflicts = conflicts.filter((c) =>
            status === "pending" ? c.resolution === "pending" : c.resolution !== "pending"
          )
        const page = projectParsedConflictPage(conflicts)
        if (!page.success) return this.err(page.error)
        return this.json({
          count: page.total,
          actionableCount: page.actionable,
          pendingDecisionCount: page.pendingDecision,
          truncated: page.items.length < page.total,
          conflicts: page.items
        })
      }
    )

    this.server.registerTool(
      "get_inferred_rules",
      {
        description:
          "Get the design rules inferred from your codebase patterns. Read-only, no side effects. Returns JSON with a list of rules including category, pattern, and confidence, or an error if no rules have been generated yet. Pass category to filter: spacing, colors, typography, borderRadius, naming, components. Omit category to get all. Use this to understand implicit conventions the codebase follows. For explicit design token values, use get_token. For source conflicts, use get_conflicts.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          category: z.string().optional()
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
            generatedAt: this.contract.generatedAt,
            rules: inferredRules.rules
          })
        }
        const category = normalizeRuleCategory(args.category)
        if (!RULE_CATEGORIES.includes(category)) {
          return this.err(
            `Unknown rule category '${args.category}'. Valid categories: ${RULE_CATEGORIES.join(", ")}. Omit category to get all.`
          )
        }
        const rules = inferredRules.rules.filter((r) => r.category === category)
        return this.json({ count: rules.length, generatedAt: this.contract.generatedAt, rules })
      }
    )

    this.server.registerTool(
      "get_violations",
      {
        description:
          "Get hardcoded token values: literals in source code typed inline instead of referencing a design token, bypassing the contract. Read-only, no side effects. Returns JSON with a count, suggestion-coverage stats, and a list with file:line:column, the captured literal, the surrounding utility (e.g. 'bg-[#ff0000]'), and an optional smart-match suggestion when a contract token has the same value. " +
          `Pass category to filter: 'all' | ${LINT_CATEGORIES.map((c) => `'${c}'`).join(" | ")} (hardcoded values are only detected for these). ` +
          "Call this BEFORE generating UI with literal values — prefer the suggested token over a hardcoded literal. For available tokens to use instead, use get_design_context or get_token.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          category: z.string().optional()
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

  private componentResponse(opts: {
    id: string
    detail?: ComponentDetail
    resolvedBy?: ComponentResolution
  }): CallToolResult {
    if (!this.contract) return this.noContract()
    const component = this.contract.components[opts.id]
    // Keep the default payload intentionally stable and compact. Components are an
    // additive contract surface, so spreading here would silently expose every future
    // evidence field through MCP (including bounded-but-still-large story evidence).
    const base = projectDefaultComponent(component)
    const payload: Record<string, unknown> = {
      id: opts.id,
      ...(opts.resolvedBy ? { resolvedBy: opts.resolvedBy } : {}),
      ...base
    }
    if (!opts.detail) return this.json(payload)

    // Contract leaves stay opaque at load for legacy compatibility. Validate exactly the
    // facts each opt-in projection will expose; malformed unrelated leaves must not make a
    // narrower selector fail.
    if (opts.detail === "api" || opts.detail === "all") {
      const api = this.validateApiFacts(opts.id)
      if (!api.success) return this.err(api.error)
      payload.api = projectApiFacts(api.facts)
    }

    if (opts.detail === "usage" || opts.detail === "all") {
      const usage = this.validateUsageFacts(opts.id)
      if (!usage.success) return this.err(usage.error)
      payload.usage = projectUsageFacts(usage.facts)
    }

    if (opts.detail === "relationships" || opts.detail === "all") {
      const validated = this.validateRelationshipFacts(Object.keys(this.contract.components))
      if (!validated.success) return this.err(validated.error)
      const facts = validated.facts[opts.id]
      const usedBy = this.usedByIndex(validated.facts)
      payload.relationships = {
        uses: sortCountMap(facts.uses ?? {}),
        usedBy: usedBy[opts.id] ?? {}
      }
    }
    return this.json(payload)
  }

  private validateRelationshipFacts(
    ids: string[]
  ): { success: true; facts: Record<string, RelationshipFacts> } | { success: false; error: string } {
    if (!this.contract) return { success: true, facts: {} }
    const facts: Record<string, RelationshipFacts> = {}
    for (const id of ids.sort(compareStrings)) {
      const cached = this.validatedRelationshipFacts[id]
      if (cached) {
        facts[id] = cached
        continue
      }
      const parsed = relationshipFactsSchema.safeParse(this.contract.components[id])
      if (!parsed.success) return { success: false, error: invalidRelationshipFacts(id, parsed.error) }
      this.validatedRelationshipFacts[id] = parsed.data
      facts[id] = parsed.data
    }
    return { success: true, facts }
  }

  private validateApiFacts(id: string): { success: true; facts: ApiFacts } | { success: false; error: string } {
    if (!this.contract) return { success: true, facts: {} }
    const parsed = apiFactsSchema.safeParse(this.contract.components[id])
    if (!parsed.success) return { success: false, error: invalidApiFacts(id, parsed.error) }
    const rawProps = parsed.data.props
    if (rawProps === undefined) return { success: true, facts: {} }
    if (!rawProps || typeof rawProps !== "object" || Array.isArray(rawProps)) {
      return {
        success: false,
        error: `API facts for component '${id}' are malformed (props: expected a property map). Run \`primitiv build\` to regenerate the contract.`
      }
    }
    const facts: ApiFacts = Object.create(null) as ApiFacts
    for (const name of Object.keys(rawProps).sort(compareStrings)) {
      const definition = propDefinitionSchema.safeParse((rawProps as Record<string, unknown>)[name])
      if (!definition.success) return { success: false, error: invalidApiFacts(id, definition.error) }
      facts[name] = definition.data
    }
    return { success: true, facts }
  }

  private validateUsageFacts(id: string): { success: true; facts: UsageFacts } | { success: false; error: string } {
    if (!this.contract) return { success: true, facts: { sites: 0 } }
    const parsed = usageFactsSchema.safeParse(this.contract.components[id])
    if (!parsed.success) return { success: false, error: invalidUsageFacts(id, parsed.error) }
    return { success: true, facts: parsed.data.usage ?? { sites: 0 } }
  }
}

const DEFAULT_CONFLICT_PAGE_LIMIT = 25
const MAX_CONFLICT_PAGE_BYTES = 512 * 1024
const projectionStringSchema = z.string().max(4096)
const projectionPathSchema = z.array(projectionStringSchema).max(64)
const structuredConflictValueSchema = z.unknown().superRefine((value, context) => {
  const error = structuredConflictValueError(value)
  if (error) context.addIssue({ code: "custom", message: error })
})

type ConflictProjectionInput = {
  type: "token" | "component"
  name: string
  sources: Array<{
    source: Record<string, unknown>
    value: string
    structuredValue?: unknown
    componentId?: string
    factPath?: string[]
  }>
  resolved?: string
  resolution?: "auto" | "manual" | "pending"
  suggestedFix?: string
  actionable?: boolean
  fieldPath?: string[]
  componentIds?: string[]
  comparison?: "exact" | "subset"
  fieldResolution?: Record<string, unknown>
}

const conflictSourceProjectionSchema = z.object({
  source: z.object({
    adapter: z.enum(["codebase", "figma", "storybook"]),
    file: projectionStringSchema.optional(),
    line: z.number().int().positive().optional(),
    metadata: z
      .record(projectionStringSchema, structuredConflictValueSchema)
      .refine((value) => Object.keys(value).length <= 100, { message: "must contain at most 100 keys" })
      .optional()
  }),
  value: projectionStringSchema,
  structuredValue: structuredConflictValueSchema.optional(),
  componentId: projectionStringSchema.optional(),
  factPath: projectionPathSchema.optional()
})

const conflictProjectionSchema = z
  .object({
    type: z.enum(["token", "component"]),
    name: projectionStringSchema,
    sources: z.array(conflictSourceProjectionSchema).max(100),
    resolved: projectionStringSchema.optional(),
    resolution: z.enum(["auto", "manual", "pending"]).optional(),
    suggestedFix: z
      .string()
      .max(16 * 1024)
      .optional(),
    actionable: z.boolean().optional(),
    fieldPath: projectionPathSchema.optional(),
    componentIds: z.array(projectionStringSchema).max(100).optional(),
    comparison: z.enum(["exact", "subset"]).optional(),
    fieldResolution: z
      .object({
        adapter: z.enum(["codebase", "figma", "storybook"]),
        componentIds: z.array(projectionStringSchema).max(100),
        fieldPath: projectionPathSchema,
        structuredValue: structuredConflictValueSchema
      })
      .optional()
  })
  .superRefine((conflict, context) => {
    if (conflict.fieldPath !== undefined && conflict.resolved !== undefined) {
      context.addIssue({ code: "custom", message: "field conflicts cannot carry an identity resolution" })
    }
    if (conflict.fieldResolution !== undefined) {
      if (conflict.fieldPath === undefined) {
        context.addIssue({ code: "custom", message: "field resolution requires a field path" })
      } else if (!samePath(conflict.fieldPath, conflict.fieldResolution.fieldPath)) {
        context.addIssue({ code: "custom", message: "field resolution path must match the conflict field path" })
      }
    }
  })

function projectConflictPage(conflicts: unknown[]) {
  const parsed = parseConflictProjectionInputs(conflicts)
  if (!parsed.success) return parsed
  return projectParsedConflictPage(parsed.items)
}

function parseConflictProjectionInputs(
  conflicts: unknown[]
): { success: true; items: ConflictProjectionInput[] } | { success: false; error: string } {
  const parsed: ConflictProjectionInput[] = []
  for (const conflict of conflicts) {
    const result = conflictProjectionSchema.safeParse(conflict)
    if (!result.success) {
      return {
        success: false,
        error: `Conflict projection is malformed (${summarizeValidationIssues(result.error)}). Run \`primitiv build\` to regenerate the contract.`
      }
    }
    parsed.push(result.data as ConflictProjectionInput)
  }
  return { success: true, items: parsed }
}

function projectParsedConflictPage(conflicts: ConflictProjectionInput[]):
  | {
      success: true
      items: Record<string, unknown>[]
      total: number
      pending: number
      actionable: number
      pendingDecision: number
    }
  | { success: false; error: string } {
  const items = conflicts.slice(0, DEFAULT_CONFLICT_PAGE_LIMIT).map(projectConflict)
  const pageBytes = new TextEncoder().encode(JSON.stringify(items)).byteLength
  if (pageBytes > MAX_CONFLICT_PAGE_BYTES) {
    return {
      success: false,
      error: `Conflict projection exceeds the ${MAX_CONFLICT_PAGE_BYTES}-byte limit. Reduce the retained conflict evidence.`
    }
  }
  return {
    success: true,
    items,
    total: conflicts.length,
    pending: conflicts.filter((conflict) => conflict.resolution === "pending").length,
    actionable: conflicts.filter((conflict) => conflict.actionable === true).length,
    pendingDecision: conflicts.filter((conflict) => conflict.actionable === false).length
  }
}

function projectConflict(conflict: ConflictProjectionInput): Record<string, unknown> {
  return {
    type: conflict.type,
    name: safeDisplayText(conflict.name),
    resolution: conflict.resolution,
    actionable: conflict.actionable ?? false,
    ...(conflict.suggestedFix !== undefined ? { suggestedFix: safeDisplayText(conflict.suggestedFix, 1_024) } : {}),
    ...(conflict.fieldPath !== undefined ? { fieldPath: conflict.fieldPath } : {}),
    ...(conflict.componentIds !== undefined ? { componentIds: conflict.componentIds } : {}),
    ...(conflict.comparison !== undefined ? { comparison: conflict.comparison } : {}),
    ...(conflict.fieldResolution !== undefined ? { fieldResolution: conflict.fieldResolution } : {}),
    sources: conflict.sources.map((source) => ({
      source: projectConflictSource(source.source),
      value: safeDisplayText(source.value, 4_096),
      ...(source.structuredValue !== undefined ? { structuredValue: source.structuredValue } : {}),
      ...(source.componentId !== undefined ? { componentId: source.componentId } : {}),
      ...(source.factPath !== undefined ? { factPath: source.factPath } : {})
    }))
  }
}

function projectConflictSource(source: Record<string, unknown>): Record<string, unknown> {
  return {
    adapter: source.adapter,
    ...(typeof source.file === "string" ? { file: safeDisplayText(source.file, 1_024) } : {}),
    ...(typeof source.line === "number" ? { line: source.line } : {}),
    ...(source.metadata !== undefined ? { metadata: source.metadata } : {})
  }
}

function samePath(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((part, index) => part === b[index])
}

function structuredConflictValueError(root: unknown): string | undefined {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    nodes += 1
    if (nodes > 1_000) return "must contain at most 1000 values"
    if (current.depth > 16) return "must be at most 16 levels deep"
    const value = current.value
    if (value === null || typeof value === "boolean") continue
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "numbers must be finite"
      continue
    }
    if (typeof value === "string") {
      if (value.length > 64 * 1024) return "strings must contain at most 65536 characters"
      continue
    }
    if (Array.isArray(value)) {
      if (value.length > 100) return "arrays must contain at most 100 values"
      for (const child of value) pending.push({ value: child, depth: current.depth + 1 })
      continue
    }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
      if (keys.length > 100) return "objects must contain at most 100 keys"
      if (keys.some((key) => key.length > 4096)) return "object keys must contain at most 4096 characters"
      for (const key of keys) pending.push({ value: record[key], depth: current.depth + 1 })
      continue
    }
    return "must contain only JSON-compatible values"
  }
  return undefined
}

const componentDetailSchema = z.enum(["api", "usage", "relationships", "all"])
type ComponentDetail = z.infer<typeof componentDetailSchema>
type ComponentResolution = "scope" | "governance.sourceOfTruth"

const relationshipCountSchema = z.number().int().positive()
const propValueSchema = z.union([z.string(), z.number().finite(), z.boolean()])
const observedPropValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
const propDefinitionSchema = z.object({
  type: z.string().optional(),
  required: z.boolean().optional(),
  default: z.string().optional(),
  values: z.array(propValueSchema).optional(),
  kind: z.enum(["boolean", "text", "variant", "instance-swap"]).optional(),
  preferredValues: z
    .array(
      z.object({
        type: z.enum(["component", "component-set"]),
        key: z.string().min(1)
      })
    )
    .optional()
})
const apiFactsSchema = z.looseObject({
  // Parse each own key manually in validateApiFacts: z.record drops an own `__proto__`
  // property, but Figma property names are opaque data and must survive byte-for-byte.
  props: z.unknown().optional()
})
const usageProjectionSchema = z.looseObject({
  sites: relationshipCountSchema,
  props: z.record(z.string(), z.array(observedPropValueSchema)).optional(),
  truncatedProps: z.array(z.string()).optional()
})
const usageFactsSchema = z.looseObject({ usage: usageProjectionSchema.optional() })
const relationshipFactsSchema = z.looseObject({
  uses: z.record(z.string(), relationshipCountSchema).optional()
})
type RelationshipFacts = z.infer<typeof relationshipFactsSchema>
type ApiFacts = Record<string, z.infer<typeof propDefinitionSchema>>
type UsageFacts = z.infer<typeof usageProjectionSchema>

function invalidApiFacts(id: string, error: z.ZodError): string {
  return (
    `API facts for component '${id}' are malformed (${summarizeValidationIssues(error)}). ` +
    "Run `primitiv build` to regenerate the contract."
  )
}

function invalidUsageFacts(id: string, error: z.ZodError): string {
  return (
    `Observed usage facts for component '${id}' are malformed (${summarizeValidationIssues(error)}). ` +
    "Run `primitiv build` to regenerate the contract."
  )
}

function invalidRelationshipFacts(id: string, error: z.ZodError): string {
  return (
    `Relationship facts for component '${id}' are malformed (${summarizeValidationIssues(error)}). ` +
    "Run `primitiv build` to regenerate the contract."
  )
}

function projectApiFacts(props: ApiFacts): Record<string, unknown> {
  const projected: Record<string, unknown> = {
    propCount: Object.keys(props).length,
    propNames: Object.keys(props).sort(compareStrings)
  }
  if (Object.keys(props).length > 0) {
    projected.props = Object.fromEntries(
      Object.entries(props)
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([name, definition]) => [name, projectPropDefinition(definition)])
    )
  }
  return projected
}

function projectPropDefinition(definition: z.infer<typeof propDefinitionSchema>): Record<string, unknown> {
  return {
    ...(definition.type !== undefined ? { type: definition.type } : {}),
    ...(definition.required !== undefined ? { required: definition.required } : {}),
    ...(definition.default !== undefined ? { default: definition.default } : {}),
    ...(definition.values !== undefined ? { values: sortPrimitiveValues(definition.values) } : {}),
    ...(definition.kind !== undefined ? { kind: definition.kind } : {}),
    ...(definition.preferredValues !== undefined
      ? { preferredValues: sortPreferredValues(definition.preferredValues) }
      : {})
  }
}

function sortPreferredValues(
  values: Array<{ type: "component" | "component-set"; key: string }>
): Array<{ type: "component" | "component-set"; key: string }> {
  const unique = new Map<string, { type: "component" | "component-set"; key: string }>()
  for (const value of values) unique.set(`${value.type}\u0000${value.key}`, value)
  return [...unique.values()].sort((a, b) => compareStrings(a.type, b.type) || compareStrings(a.key, b.key))
}

function projectCompactSource(source: Component["source"]): Record<string, unknown> {
  return {
    adapter: source.adapter,
    ...(source.file !== undefined ? { file: source.file } : {}),
    ...(source.line !== undefined ? { line: source.line } : {})
  }
}

function projectDefaultComponent(component: Component): Record<string, unknown> {
  return {
    name: component.name,
    ...(component.displayName !== undefined ? { displayName: component.displayName } : {}),
    ...(component.description !== undefined ? { description: component.description } : {}),
    ...(component.kind !== undefined ? { kind: component.kind } : {}),
    ...(component.scope !== undefined ? { scope: component.scope } : {}),
    source: component.source,
    ...(component.props !== undefined ? { props: component.props } : {}),
    ...(component.rationale !== undefined ? { rationale: component.rationale } : {})
  }
}

function projectUsageFacts(usage: UsageFacts): Record<string, unknown> {
  const projected: Record<string, unknown> = { sites: usage.sites }
  if (usage.props !== undefined) {
    projected.props = Object.fromEntries(
      Object.entries(usage.props)
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([name, values]) => [name, sortPrimitiveValues(values)])
    )
  }
  if (usage.truncatedProps !== undefined) {
    projected.truncatedProps = [...new Set(usage.truncatedProps)].sort(compareStrings)
  }
  return projected
}

function sortPrimitiveValues<T extends string | number | boolean | null>(values: T[]): T[] {
  const unique = new Map<string, T>()
  for (const value of values) unique.set(value === null ? "null" : `${typeof value}:${String(value)}`, value)
  return [...unique.values()].sort(comparePrimitiveValues)
}

function comparePrimitiveValues(a: string | number | boolean | null, b: string | number | boolean | null): number {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  const rank = (value: string | number | boolean): number =>
    typeof value === "boolean" ? 0 : typeof value === "number" ? 1 : 2
  const aRank = rank(a)
  const bRank = rank(b)
  if (aRank !== bRank) return aRank - bRank
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
  if (typeof a === "number" && typeof b === "number") return a - b
  return a < b ? -1 : a > b ? 1 : 0
}

function sortCountMap(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => compareStrings(a, b)))
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
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
