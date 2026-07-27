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
- `src/scanner/` — `CodebaseScanner`, reads tokens and components from the codebase
- `src/sources/figma/` — `FigmaAdapter` (Figma Variables + components via the REST API)
- `src/sources/storybook/` — `StorybookAdapter` (Storybook manifest)
- `src/contract/` — `ContractBuilder`, assembles the contract from all sources
- `src/inferrer/` — `inferRules()`, the inferred-rules layer
- `src/mcp/` — `PrimitivMCPServer` loads the contract JSON and registers the read-only MCP tools
- `src/init/` — project detection and wiring (writes `primitiv.config.js`, MCP config, agent blocks, the `build-component` skill)
- `src/types.ts` — **all shared interfaces live here** — `SourceProvenance` tracks where every token/component came from (adapter, file, line, metadata)

**Runtime features in the MCP server** (not all obvious from the module list):
- **Contract age warning** — `PrimitivMCPServer` emits a `STALE` warning in tool responses when `generatedAt` is more than 24 hours old
- **Hot reload** — `serve` watches `primitiv.contract.json` and reloads it (debounced ~50ms) when rebuilds land, so agents see fresh data without restarting the server
- **Source-root mismatch warning** — the server flags cases where the contract's `sourceRoot` does not match the project the MCP is running inside (catches configs pointing at the wrong project)
- **Auto-installed skill** — `primitiv init` drops `.claude/commands/build-component.md` so Claude Code gains a `/build-component` slash command with no extra setup

## Primitiv-Specific Rules

These rules are specific to Primitiv's architecture. Deviations need a comment explaining why.

**8. All shared types live in `src/types.ts`.** No exceptions. Per-module type files create drift between scanners and the contract — a `Token` defined locally in `inferrer.ts` will silently diverge from the canonical one in `types.ts`. A type used in only one file can stay local; anything that crosses module boundaries goes in `src/types.ts`.

**9. Adapters implement a single `scan()` interface.** Every source adapter is a class with `async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }>`. No variants, no overloads. New adapters go in `src/sources/<name>/`, get wired into `build()` in `src/index.ts`, and add their config type to `src/types.ts`.

**10. MCP tools return both surfaces (forward-looking).** New MCP tools must return both `content` (text array for LLM consumers) and `structuredContent` (typed payload for programmatic consumers). All tools are read-only (`readOnlyHint: true`). Errors set `isError: true` with a message naming the exact CLI command to fix the issue. Existing read-only tools that return only `content` may stay text-only until they have a programmatic consumer that needs them — see `get_violations` in `src/mcp/server.ts` for the pattern to copy.

**11. Conflicts surface, never silence.** When `ContractBuilder` finds the same token or component defined in multiple sources, it must record the conflict in the contract — even if `governance.sourceOfTruth` resolves which value wins. The provenance of the losing source stays. Unresolved conflicts are marked `"pending"`. Silent overwrites are a bug.

**12. Validate at boundaries, trust internals.** Use `zod` to validate input at the MCP tool boundary and at config load. Once data is past the boundary, trust it — don't re-validate between internal modules. Validation noise is worse than no validation; pick one layer (the boundary) and enforce it strictly there.

**13. Provenance is mandatory.** Every token and component in the contract carries `SourceProvenance` (adapter, file, line, metadata). Never drop provenance for convenience or to make a diff cleaner — it's the audit trail for every governance decision and the basis for every actionable error message Primitiv surfaces.

**14. Keep suggestion matching uniform.** Token-misuse suggestions live in `src/lint/`. Add a per-category normalizer rather than re-implementing match logic inline, so every category goes through one lookup path.

## Coding Discipline

These rules apply across the codebase regardless of module.

**1. Module code order.** Public exports at the top of the file, internal helpers at the bottom. A reader should see what a module exposes within the first screen. Function declarations hoist, so order doesn't break anything.

**2. No premature exports.** Only export what is used outside the module. Every export is a contract you have to maintain. If a helper is only called within this file, leave it unexported.

**3. Object parameters at 3+.** If a function takes three or more parameters, use a single object parameter instead. Call sites become self-documenting and adding a parameter later isn't a breaking change.

```ts
// Good
function buildContract(opts: { config: Config; sources: Source[]; cwd: string }) { ... }

// Avoid
function buildContract(config: Config, sources: Source[], cwd: string) { ... }
```

**4. Classes for stateful modules.** If a module owns state — caches, watchers, file handles, intervals — wrap it in a class with explicit init/cleanup. Don't hide state in module-level `let` bindings. Export a singleton when only one instance makes sense (e.g. `PrimitivMCPServer`).

**5. Private methods at the bottom.** Inside a class, public methods first, private methods after. Mark anything only used internally as `private`. The public interface should be readable in one scroll.

**6. Test behavior, not implementation.** Tests should break when the contract breaks, not when an internal helper is renamed. Don't assert on internal method names, intermediate data shapes, or implementation details that aren't part of the contract. Exceptions: helpers with tricky logic (parsers, normalizers) where focused unit tests aid debugging, and invariants that span many callers.

**7. No auto-commits.** Never run `git commit` or `git push` without explicit user approval. Always ask before staging changes, even when the work is obviously done.

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