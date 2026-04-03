# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run build       # Compile TypeScript → dist/
bun run dev         # Run src/index.ts directly via ts-node
bun run start       # Run compiled dist/index.js
bun run lint        # ESLint on src/**/*.ts
```

There are no tests configured yet.

## Architecture

Primitiv is a TypeScript reconciliation layer that scans design sources, resolves conflicts between them, and exposes a single machine-readable contract via MCP.

**Data flow:**
```
Config → scan() per source → ContractBuilder.build() → primitiv.contract.json → MCP server
```

**Entry points:**
- `src/cli.ts` — shebang CLI, routes `init` / `build` / `serve` to `src/index.ts`
- `src/index.ts` — exports `build(configPath?)` and `serve(configPath?)`

**Modules:**
- `src/scanner/` — `CodebaseScanner` extracts tokens (CSS custom properties, TS color literals) and React components from the filesystem via glob
- `src/sources/figma/` — `FigmaAdapter` scans Figma Variables (tokens) and components via the REST API
- `src/sources/storybook/` — `StorybookAdapter` scans components and variants via the Storybook manifest (`index.json` / `stories.json`)
- `src/contract/` — `ContractBuilder` merges token/component maps across sources, detects conflicts, applies governance rules, calls the inferrer
- `src/inferrer/` — `inferRules()` derives design rules (spacing scale, color semantics, naming conventions, etc.) from token and component patterns
- `src/mcp/` — `PrimitivMCPServer` loads the contract JSON and registers 5 read-only MCP tools
- `src/init/` — detects framework, Tailwind, Figma tokens, Storybook and writes a starter `primitiv.config.js`
- `src/types.ts` — **all shared interfaces live here** — `SourceProvenance` tracks where every token/component came from (adapter, file, line, metadata)

## Key conventions (from `.cursor/rules/`)

**Types:** All types and interfaces must be defined in `src/types.ts`.

**Sources/adapters:** Each source is a class with `async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }>`. New adapters go in `src/sources/<name>/`. Wire them into `build()` in `src/index.ts` and add their config type to `src/types.ts`.

**MCP tools:** All tools are read-only (`readOnlyHint: true`). Return both `content` (text array) and `structuredContent` (parsed data). Errors set `isError: true` with actionable guidance pointing to the CLI command needed to fix the issue.

**Governance:** When token or component names conflict across sources, `ContractBuilder` surfaces the conflict and resolves it using `governance.sourceOfTruth` from the config — never silently. Unresolved conflicts are marked `"pending"`.

## Stack

TypeScript (strict), `@modelcontextprotocol/sdk`, `zod` (tool input validation), `glob`, `chalk`, `ora`. Compiles to CommonJS via `tsc`. No framework, no test runner yet.
