# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun run build       # Compile TypeScript → dist/
bun run dev         # Run src/index.ts directly via ts-node
bun run start       # Run compiled dist/index.js
bun run lint        # ESLint on src/**/*.ts
bun test            # Run the test suite (bun's built-in runner)
```

Tests live next to the code as `src/**/*.test.ts` and use `bun:test`.

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
- `src/init/` — detects framework, Tailwind, Figma tokens, Storybook and writes a starter `primitiv.config.js`. Also merges an `mcpServers.primitiv` entry into `.mcp.json` / `.cursor/mcp.json`, appends a Primitiv block to `CLAUDE.md` / `AGENTS.md` (idempotent — re-runs refresh the block between `<!-- primitiv -->` markers), installs `.claude/commands/build-component.md`, and adds the server to Codex via `codex mcp add` when `codex` is on PATH
- `src/types.ts` — **all shared interfaces live here** — `SourceProvenance` tracks where every token/component came from (adapter, file, line, metadata)

**Runtime features in the MCP server** (not all obvious from the module list):
- **Contract age warning** — `PrimitivMCPServer` emits a `STALE` warning in tool responses when `generatedAt` is more than 24 hours old
- **Hot reload** — `serve` watches `primitiv.contract.json` and reloads it (debounced ~50ms) when rebuilds land, so agents see fresh data without restarting the server
- **Source-root mismatch warning** — the server flags cases where the contract's `sourceRoot` does not match the project the MCP is running inside (catches configs pointing at the wrong project)
- **Auto-installed skill** — `primitiv init` drops `.claude/commands/build-component.md` so Claude Code gains a `/build-component` slash command with no extra setup

## Key conventions (from `.cursor/rules/`)

**Types:** All types and interfaces must be defined in `src/types.ts`.

**Sources/adapters:** Each source is a class with `async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }>`. New adapters go in `src/sources/<name>/`. Wire them into `build()` in `src/index.ts` and add their config type to `src/types.ts`.

**MCP tools:** All tools are read-only (`readOnlyHint: true`). Return both `content` (text array) and `structuredContent` (parsed data). Errors set `isError: true` with actionable guidance pointing to the CLI command needed to fix the issue.

**Governance:** When token or component names conflict across sources, `ContractBuilder` surfaces the conflict and resolves it using `governance.sourceOfTruth` from the config — never silently. Unresolved conflicts are marked `"pending"`.

## Stack

TypeScript (strict), `@modelcontextprotocol/sdk`, `zod` (tool input validation), `glob`, `chalk`, `ora`. Compiles to CommonJS via `tsc`. Tests use `bun:test` (`bun test`). No application framework.

## Code Quality Rules

**CRITICAL: Always run these checks before completing ANY task that modifies code:**

1. **Lint**: Run `bun lint` - **MUST have ZERO errors AND ZERO warnings**
2. **Format**: Run `bun fmt` - ensure all code is properly formatted
3. **TypeScript check**: Run `bunx tsc --noEmit` to validate all TypeScript files
4. **Build check**: Run `bun run build` to ensure the project builds successfully

> ⚠️ **Do not consider a task complete until:**
> - `bun lint` returns zero warnings and zero errors
> - `bun test` shows all tests passing
> - `bun run build` builds successfully
>
> If you introduce any lint warnings or failing tests, fix them immediately before finishing.

### TypeScript Guidelines

- **Never use `any` type** - always use proper types, `unknown` with type guards, or specific interfaces
- **Never use non-null assertions (`!`)** - use proper type guards or nullish coalescing (`??`)
- Use union types for known string values (e.g., `"pending" | "completed" | "failed"`)
- Prefer interfaces over type aliases for object shapes
- Add explicit return types to functions when the return type is complex