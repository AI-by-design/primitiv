---
name: build-component
description: Build a UI component using the project's design contract. Use when the user asks to build, create, or scaffold a component.
---

# Build Component

Mode: BUILD. One component at a time. Contract before code.

Contract validation, token rules, and rationale handling are defined in the Primitiv block in CLAUDE.md / AGENTS.md — this skill is the build procedure that applies them; it does not restate them.

## 1. Load + validate
- Check for Primitiv (`.mcp.json` or `primitiv.contract.json`) — if missing, fall back to CLAUDE.md only.
- Call `get_design_context { category: "all" }`, then validate per the Primitiv block (sourceRoot matches this project; warnings empty) before using any of it.
- Call `get_conflicts` — if `actionableCount > 0`, surface each `suggestedFix` and ask the user to resolve first; if `pendingDecisionCount > 0`, warn that manual governance config is needed.

## 2. Confirm the spec
With the user: name, props, states, variants, composition, and project conventions (framework, server vs client, file location). Don't invent conventions — call `get_inferred_rules` and match the codebase's own naming and prop-shape patterns.

## 3. Reuse before you build
Never recreate a component the contract already has. Components carry a `kind` (`component` | `screen` | `provider` | `icon` | `other`) — only `component` and `icon` are reusable UI; treat the rest as tagged noise, not reuse targets. Then:
1. Look it up — `get_component { name }`.
2. Found → use it; load its full record (props, variants, rationale) and conform to its API, don't redesign it.
3. Not found but composable → assemble from existing contract primitives, not from scratch.
4. Genuinely new → tell the user it's net-new, then build to the conventions from step 2.

## 4. Build (token ladder)
Resolve every visual value through the contract, in order:
1. An existing component (tokens already baked in — step 3).
2. A token reference in the project's form (`var(--token)`, utility class, theme path).
3. Never a raw literal. About to write `bg-[#hex]` or `p-[8px]`? Call `get_violations` — if a matching `suggestion.token` exists, use it.

All interactive states required. Prefer rationale-matched tokens and components; never use one marked `deprecated: true` — use its `alternatives`.

## 5. Self-check + record
- Verify against the contract: token usage, naming vs `get_inferred_rules`, prop shapes vs the component you reused.
- Run `primitiv build` — update the contract with the new component.
