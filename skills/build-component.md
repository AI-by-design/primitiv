---
name: build-component
description: Build or modify a UI component using the project's Primitiv design contract. Use for component reuse, composition, or scaffolding in an existing project.
---

# Build Component

Use the contract before writing UI code. Preserve the user's requested scope and the project's framework, file placement, server/client conventions, and prop patterns.

## Load and validate

- Check available MCP tools and the project's Primitiv config/contract. If setup is absent, use project instructions and existing code; perform normal setup when authorized. Missing classifications or guidance never require a documentation exercise before coding.
- When all three discovery tools are available, start with `get_component_catalog {}`; validate `project.sourceRoot` against this project and use `project.configPath`, `generatedAt`, and health to resolve freshness. On older servers, call `get_design_context` with no args for `sourceRoot` and warnings. Follow the Primitiv block in AGENTS.md / CLAUDE.md: do not use a different project's contract; when identity is unknown or the contract is stale, rebuild/fix the configured source within the authorized workflow. Surface a blocker only when available evidence cannot resolve it.
- Call `get_conflicts`; inspect actionable fixes and pending governance decisions relevant to the work. Use `get_inferred_rules` and existing code to resolve conventions. Ask a focused question only for a material ambiguity that evidence cannot settle.

## Discover reusable components

When `get_component_catalog`, `find_components`, and `get_component_context` are available, use this path:

1. Use the validated catalog from the initial call. Check source and guidance health, classification coverage, supported filter values, `snapshotId`, and `reload`. Unknown guidance health means unknown, not healthy absence. A stale/reload-failed snapshot is last-good data; resolve freshness before relying on it for a final choice. `contract-unavailable` has no snapshot: repair/build the configured contract when authorized before retrying.
2. Use a known canonical ID directly in detail. Resolve a known name through `get_component { name, context: <working file or directory>, detail: "api" }` to obtain its exact ID, then request detail against the catalog's snapshot. Otherwise turn the task's purpose and likely atomic level into search hints, using only supported catalog values.
3. Call `find_components { level?, intents?, intentMatch?, kind?, scope?, limit?, cursor? }`. Default pages contain 20 entries, maximum 50. All supplied dimensions combine with AND; intents default to `any`, with `all` only when every requested intent is required. `scope` is the working file/directory under existing scope rules, not an invented folder taxonomy. Inspect reusable `component` and `icon` kinds; a template/atomic level never overrides kind or scope eligibility.
4. Shortlist descriptions and usage are previews, with explicit completeness flags. Request `get_component_context { id, snapshotId, sections: ["api", "guidance"] }` before selecting a candidate. Add `"relationships"` or `"source"` when needed to understand composition or implementation evidence. Preserve authored-vs-source descriptions and declared-vs-observed evidence.
5. Follow `nextCursor` with the same normalized filters for search, or the same ID/snapshot/sections for detail. Retain returned sections across pages. For `continuation.format: "json-fragment"`, concatenate `continuation.text` in cursor order for that section and JSON.parse only when `sectionComplete` is true. Continue until the requested detail is complete. On `snapshot-changed`, discard the old shortlist/detail, obtain the new catalog, and restart discovery; never combine revisions. On `record-too-large`, request fewer detail sections or inspect the authored/source file identified by the contract rather than treating an incomplete response as complete guidance.
6. A zero filtered result does not establish absence. Before creating a duplicate, relax speculative level/intent/scope filters and explicitly search `find_components { unclassified: "either", kind?, scope? }` without the classification filters that exclude those records. Coverage reports `missing-level` and `missing-intents` separately; use those narrower searches when relevant. Page through relevant candidates until the reuse decision is supported. Missing labels remain searchable and must never falsely justify net-new work.

On servers without all three discovery tools, fall back to `get_design_context { category: "components" }` and `get_component { name, context: <working file or directory>, detail: "api" }`. Older contracts may have no classifications. Request `"usage"` for bounded observed values, `"relationships"` for sorted `uses` and derived `usedBy` counts, or `"all"` when those sections matter. Follow an ambiguous response's instruction: working scope, then `rationale.when` versus the user's intent, then a focused question if still unresolved. Do not pick arbitrarily.

## Choose and build

- Reuse the existing API when suitable; otherwise compose existing primitives. Build net-new only after the broader and unclassified searches support that choice, and explain the reason briefly.
- Read `rationale.avoidWhen[].condition`; when a condition matches the task, inspect its `alternative.componentId`. Follow legacy `rationale.alternatives` when applicable, including deprecation replacements. Track visited canonical IDs, follow at most four alternative hops, and stop on a cycle or unresolved reference. At the limit, return to the task and available evidence; ask only if a material choice remains unresolved. `rationale.pairsWith` entries are advisory, not required dependencies.
- Relationship counts and observed usage are static JSX evidence, never runtime popularity. Observed values may be truncated; dynamic values, spreads, unresolved imports, and missing edges do not prove absent composition or unrestricted APIs.
- Resolve visual values through the token ladder: existing component, then token reference in the project's syntax. Before writing a raw visual literal, inspect `get_violations` and available tokens with `get_design_context { category: "tokens" }`; use an applicable `suggestion.token`. Respect authored token rationale and deprecation alternatives. Implement the interactive states required by the task.
- When modifying a component, review its relevant authored guidance entry. Update established guidance within the task's authorization; uncertain levels/intents remain proposals, not invented project facts.

## Verify and record

Verify the code against the selected declared API, guidance, tokens, and project conventions, and run the relevant checks. Reading guidance alone does not prove adherence. Run `primitiv build` within the authorized workflow to refresh code/guidance evidence, then verify relevant health and the resulting component details. In test-run evidence record the chosen IDs and actual served `snapshotId` for each selection (or explicitly note that a legacy server supplied no revision).
