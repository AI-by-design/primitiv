# Primitiv

**The design system contract keeping teams and agents in sync.**

Retrieval gives you data. Reconciliation gives you truth.

<video src="https://github.com/user-attachments/assets/deb63812-72ea-4651-b248-31d817725d10" controls muted></video>

Primitiv sits above your design sources — Figma, codebase, Storybook, token files — scans them, reconciles conflicts between them, and exposes a single machine-readable contract via MCP. Any agent that connects gets one authoritative answer before it builds. Your code never leaves your machine.

## Quick start

```bash
npx @ai-by-design/primitiv init     # detect your stack, write config + MCP registration
npx @ai-by-design/primitiv build    # scan sources, resolve conflicts, write the contract
npx @ai-by-design/primitiv serve    # start the MCP server
```

`init` writes a `.mcp.json` to your project root, so Cursor, Claude Code, Codex, Windsurf, and any other MCP-compatible tool pick up the server without manual config. `primitiv init` is safe to re-run — it keeps your `primitiv.config.js` and refreshes the other wiring (MCP config, agent instructions, skill files, CI workflow).

If your project is on GitHub, `init` also installs `.github/workflows/primitiv-verify.yml` — a workflow that runs `primitiv verify --strict` on every PR and push. Pair it with branch protection on your default branch and the merge is blocked when an agent ships UI that breaks the contract or sneaks a hardcoded value past it.

From here, every agent that builds UI calls `get_design_context` first, then `get_violations` before generating any literal value — and gets your resolved design contract back.

## The problem

Design-relevant information is spread across Figma, tokens, Storybook, and the codebase itself — sources that were never meant to stay in sync. Humans reconcile the drift by inference; agents can't, so they fall back on training-data patterns and build UI that works but doesn't fit.

Primitiv resolves it: one contract, built from every source, served live to every agent.

## How it works

```
Any source                      Primitiv                    Your agent

Figma           ──┐
Codebase        ──┤──► scan ──► reconcile ──► contract ──► MCP ──► Cursor / Claude Code / Codex / Windsurf / any MCP-compatible tool
Storybook       ──┤
Tokens file     ──┤
Any adapter     ──┘
```

1. **Scan** — Primitiv ingests from any configured source via adapters. The codebase scanner parses TypeScript/JSX structurally (AST, not regex): every component in a file is captured at its definition site and classified by `kind`, theme tokens are pulled across all categories, and component-internal CSS variables are separated from the global design-token scale
2. **Reconcile** — Conflicts between sources are surfaced and resolved according to your governance configuration
3. **Infer** — Design rules are extracted from actual codebase patterns and written into the contract
4. **Contract** — A single `primitiv.contract.json` is written as the canonical reference
5. **MCP** — Agents call `get_design_context` before building and receive the resolved contract

---

## Install

```bash
npm install @ai-by-design/primitiv
# or
bun add @ai-by-design/primitiv
```

### CLI

| Command | Description |
|---------|-------------|
| `primitiv init [dir]` | Detect your project (framework, TypeScript, Tailwind, Figma, Storybook, package manager) and generate `primitiv.config.js`. Also writes a project-scoped MCP config, refreshes a Primitiv block in `AGENTS.md` and `CLAUDE.md`, installs a `verify --strict` GitHub Actions workflow, and drops a `/build-component` skill for Claude Code. |
| `primitiv build [config]` | Scan sources, resolve conflicts, lint for token misuse, write the contract |
| `primitiv serve [config]` | Start the MCP server against the built contract. Hot-reloads when the contract file changes. |
| `primitiv verify [config]` | Re-run `build` and exit non-zero if conflicts are unresolved, token misuse is detected, or the contract is stale. Flags: `--strict`, `--json`, `--fast`. Intended for CI. |

`init` detects Next, Nuxt, Astro, SvelteKit, Remix, Expo, Qwik, Vite, Solid, and React. Package manager is read from the lockfile (`bun.lock` → `bunx`, `pnpm-lock.yaml` → `pnpm dlx`, `yarn.lock` → `yarn dlx`, otherwise `npx`) and used in the generated MCP config.

### MCP tools

| Tool | Description |
|------|-------------|
| `get_design_context` | Get tokens, components, conflicts, inferred rules, and violation count. Default (no category) returns a summary with counts. Pass `category: "all" \| "tokens" \| "components" \| "conflicts"` for full detail. Filter tokens with `tokenCategory`: `colors`, `spacing`, `sizes`, `typography`, `borderRadius`, `shadows`, `zIndex`, `breakpoints`, `motion`. |
| `get_token` | Look up a specific token by name. Pass `category` to narrow search (e.g. `"colors"`, `"spacing"`, `"borderRadius"`); aliases like `"radius"` / `"z-index"` are normalized. |
| `get_component` | Look up a specific component by name. Returns props, variants, source provenance, and `kind` — `component`, `screen`, `provider`, `icon`, or `other`, so agents reuse real UI and skip screens/providers/icons. |
| `get_conflicts` | Get conflicts between sources. Pass `type: "all" \| "token" \| "component"` and `status: "all" \| "pending" \| "resolved"`. Returns `actionableCount` and `pendingDecisionCount` alongside the list. |
| `get_inferred_rules` | Get the design rules Primitiv has extracted from your codebase patterns. Pass `category` to filter. |
| `get_violations` | List token-misuse violations — hardcoded literals in source that bypass the contract. Smart-matched to a suggested token when the literal matches one. Pass `category: "all" \| "colors" \| "spacing"` to filter. |

All tools are read-only — they never modify your code or contract. Primitiv works with any tool that speaks MCP — it is not tied to a specific editor or agent ecosystem.

### Using Primitiv across multiple projects

Primitiv runs **one MCP server process per project**, each pointed at that project's contract. This is intentional — each project has its own resolved contract, and there is no global shared state.

`primitiv init` writes a project-scoped MCP config automatically. **Do not add Primitiv to your editor's global MCP config** — if you do, the global server will keep serving one project's contract regardless of which project your agent is working in.

#### Per-editor setup

| Editor | Project-level config | Global config (avoid for Primitiv) |
|--------|---------------------|--------------------------------------|
| **Claude Code** | `.mcp.json` at repo root ✅ | `~/.claude/settings.json` |
| **Cursor** | `.cursor/mcp.json` at repo root ✅ | `~/.cursor/mcp.json` |
| **Windsurf** | `.windsurf/mcp_config.json` at repo root ✅ | `~/.codeium/windsurf/mcp_config.json` |
| **Zed** | `.zed/settings.json` at repo root ✅ | `~/.config/zed/settings.json` |

`primitiv init` detects which editor config exists and writes to the right project-level file. If none exists, it creates `.mcp.json` (works with Claude Code and most modern editors).

#### Switching between projects

Each project needs its own `primitiv init` + `primitiv build`. When you switch projects in your editor, the project-scoped MCP config is loaded automatically — no manual switching needed, as long as you haven't added Primitiv to the global config.

If you already added Primitiv to your global editor config, remove it:

```bash
# Cursor — edit ~/.cursor/mcp.json and remove the "primitiv" entry
# Windsurf — edit ~/.codeium/windsurf/mcp_config.json and remove "primitiv"
```

#### Stale or mismatched contract warnings

If `get_design_context` returns a `warnings` array, stop and resolve before proceeding:

- **`STALE CONTRACT`** — the contract is outdated. The warning includes the exact command to rebuild, e.g.: `npx @ai-by-design/primitiv build /path/to/your/primitiv.config.js`
- **`CONTRACT MISMATCH`** — the server is serving a contract from a different project. This usually means Primitiv is in your global editor MCP config. Remove it from there and re-run `primitiv init` in the correct project.

### CI / GitHub Actions

`primitiv init` auto-installs `.github/workflows/primitiv-verify.yml` when the project's remote is on GitHub. The workflow runs `verify --strict` on every pull request and push to your default branch, and fails the check on **unresolved conflicts**, **token misuse**, or a **stale contract**.

To turn the failed check into a hard merge gate, enable branch protection on the default branch — `init` prints the exact settings URL after install (`https://github.com/<owner>/<repo>/settings/branches`).

The workflow uses `npx --yes @ai-by-design/primitiv verify --strict`, so it works regardless of your project's package manager. Two notes:

- **Monorepos** — the workflow runs at repo root. If `primitiv.config.js` lives in a subdirectory, add a `working-directory:` to the verify step in the generated YAML.
- **Pinning** — `npx --yes @ai-by-design/primitiv` fetches the latest version. To pin, edit the workflow's `run:` line to `npx --yes @ai-by-design/primitiv@1.5.2 verify --strict` (or your chosen version).

#### Verify exit codes

| Code | Meaning |
|------|---------|
| `0` | Contract is fresh, conflicts resolved, no token misuse |
| `1` | Stale contract OR token misuse detected (warning level, default) |
| `2` | Unresolved conflicts, OR `--strict` escalation of stale / token misuse |
| `3` | No config or contract found |

The workflow is idempotent — re-running `primitiv init` refreshes the block between `# <!-- primitiv -->` markers, preserving any content you've added outside them.

### Token misuse

Every `primitiv build` and `primitiv verify` scans your source for hardcoded literals that bypass the contract — Tailwind arbitrary values like `bg-[#ff0000]` or `p-[8px]`. When a literal matches the value of a token already in your contract, the violation is smart-matched to a suggested replacement:

```
$ primitiv verify

! 3 token misuses detected:
  - src/components/Button.tsx:14  bg-[#ff0000] → use --color-destructive
  - src/components/Card.tsx:7     p-[8px]      → use --spacing-2
  - src/components/Hero.tsx:22    text-[#abcdef] → no matching token
```

Violations surface through the `get_violations` MCP tool so agents see the same list before generating UI. Suppress an intentional one-off with a directive on the line above:

```tsx
// primitiv-ignore-next-line
<div className="bg-[#fef3c7]" /> // intentional — promo banner
```

### Rationale layer

A YAML sidecar (`primitiv.rationale.yml`) lets you annotate tokens with **why** they exist, **when** to use them, whether they're **deprecated**, and what **alternatives** to prefer:

```yaml
# primitiv.rationale.yml

color.brand:
  why: "Primary action colour across all surfaces"
  when: "CTAs, primary navigation, focus rings"

color.primary.old:
  deprecated: true
  why: "Replaced by color.brand in v2 — old hue failed WCAG AA on dark surfaces"
  alternatives: [color.brand]
```

Agents reading the contract via MCP prefer annotated tokens, refuse deprecated ones, and surface the reasoning when asked. The rationale layer is authored by humans — it documents intent, not structure.

### Configuration

```js
// primitiv.config.js
module.exports = {
  sources: {
    codebase: {
      root: "./src",
      patterns: ["**/*.css", "**/*.ts", "**/*.tsx"],
      ignore: ["node_modules", "dist", ".next"]
    },
    // figma: {
    //   token: process.env.FIGMA_ACCESS_TOKEN,
    //   fileId: "your-figma-file-id"
    // },
    // storybook: {
    //   url: "http://localhost:6006"
    // }
  },
  governance: {
    sourceOfTruth: "codebase", // "codebase" | "figma" | "storybook" | "manual"
    onConflict: "warn"         // "error" | "warn" | "auto-resolve"
  },
  output: {
    path: "./primitiv.contract.json"
  }
}
```

---

## Contributing

Bug reports, feature ideas, and PRs are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, the architecture map, commit conventions, and the release flow. Participation is governed by the [Code of Conduct](./CODE_OF_CONDUCT.md). For security reports, see [SECURITY.md](./SECURITY.md) — please don't open a public issue.

---

## Design principles

**Source-agnostic** — Primitiv does not assume any particular toolchain. Sources are configured via adapters, and new adapters can be added for any system that holds design-relevant information. Works with Figma, Storybook, token files, raw codebase — or any combination.

**Contract over documentation** — The output is a machine-readable contract, not human-readable documentation. It is designed to be consumed by agents, not read by people.

**Active reconciliation, not retrieval** — Primitiv does not answer questions about what exists in your codebase. It resolves conflicts between sources and produces something authoritative. The distinction matters: retrieval gives you data, reconciliation gives you truth.

**Inferred before prescribed** — Primitiv surfaces the rules your codebase is already following before asking you to write any. The inferred rules are a starting point, not a final answer.

**Governance is explicit** — When sources conflict, the resolution is not silent. Conflicts are surfaced, logged, and resolved according to rules you define. Nothing is resolved by guessing.

**Local-first and private** — Primitiv runs entirely on your machine. Your codebase is never sent to an external service. The contract is a local file; the MCP server is a local process.

**Incrementally adoptable** — Start with a single source. Add more as needed. The contract remains valid at any level of completeness.

## Roadmap

- [x] Codebase scanner (CSS variables, TypeScript tokens, React components)
- [x] Contract builder with conflict detection
- [x] MCP server with 6 read-only tools
- [x] `primitiv init` — project detection and config generation across Next, Nuxt, Astro, SvelteKit, Remix, Expo, Qwik, Vite, Solid, and React
- [x] Package-manager auto-detection — `init` reads the lockfile and writes `bunx` / `pnpm dlx` / `yarn dlx` / `npx` into the generated MCP config
- [x] Inferred rules — extract design rules from actual codebase patterns
- [x] AGENTS.md / CLAUDE.md integration — `primitiv init` writes agent instructions so `get_design_context` is called before any UI build without manual prompting
- [x] Project-scoped MCP config — `primitiv init` writes a project-level MCP config so the server is scoped to the current project, not a global user-level server
- [x] `build-component` skill — `primitiv init` installs a Claude Code slash command that queries the contract before building any UI component
- [x] Remediation steps on conflicts — conflicts include a `suggestedFix` and `actionable` flag so agents know exactly what to do, not just what's wrong
- [x] Published to npm — available as `@ai-by-design/primitiv`
- [x] Figma source adapter — scan Figma Variables and components via the Figma REST API
- [x] Storybook source adapter — scan components and variants via the Storybook manifest
- [x] Source provenance — every token and component in the contract traces back to its origin (file, line number, Figma variable ID, Storybook story ID)
- [x] Token-misuse detection — `build` and `verify` lint for hardcoded Tailwind arbitrary values and smart-match them to existing tokens; exposed via the `get_violations` MCP tool
- [x] Rationale layer — annotate tokens with `why` / `when` / `deprecated` / `alternatives` via `primitiv.rationale.yml`; agents prefer annotated tokens and refuse deprecated ones
- [x] CI enforcement — `primitiv init` auto-installs a GitHub Actions workflow that runs `verify --strict` on every PR, failing on conflicts, token misuse, or stale contracts
- [x] Structural (AST) extraction — the codebase scanner parses TypeScript/JSX with an AST instead of regex: every component is captured at its definition site (incl. `forwardRef` / `memo` / `styled` / factory wrappers) and classified by `kind`; theme tokens are extracted across nine categories (colors, spacing, sizes, typography, border-radius, shadows, z-index, breakpoints, motion) with Tailwind class strings rejected and scale aliases resolved; component-internal CSS variables are separated from the global design-token scale
- [ ] Token relationships — document how tokens relate and what constraints exist between them

## Part of a larger system

Primitiv is the contract layer. It works alongside [Design-workflow](https://github.com/AI-by-design/Design-workflow) — a build system for going from idea to working product with agents. Design-workflow gives agents the process. Primitiv gives them the source of truth.

## License

Apache-2.0
