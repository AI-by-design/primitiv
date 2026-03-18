# Build Component

Mode: BUILD. One component at a time. Contract before code.

1. Check for Primitiv (`.mcp.json` or `primitiv.contract.json`) — if missing, fall back to CLAUDE.md only
2. Call `get_design_context { category: "all" }` — load full contract
3. Call `get_conflicts` — if `actionableCount > 0`, surface each `suggestedFix` and ask the user to resolve before continuing; if `pendingDecisionCount > 0`, warn the user that manual governance config is needed; if no conflicts, continue
4. Confirm component spec with user: name, props, states, variants, composition, Server vs Client
5. Build — use contract tokens only, no hardcoded values; all interactive states required; reuse existing components before creating new ones
6. Self-check against contract: verify token usage, component naming, prop shapes
7. Run `primitiv build` — update the contract with the new component
