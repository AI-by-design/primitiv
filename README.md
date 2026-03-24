# Primitiv

The design contract layer for your agents.

Primitiv is the design contract layer for agent-first codebases. It sits above your design sources — Figma, codebase, Storybook, token files — scans them, actively reconciles conflicts between them, and infers the design rules your codebase is already following. The result is a single machine-readable contract exposed via MCP. Unlike read-only retrieval tools, Primitiv doesn't just surface what exists — it resolves what's true. Any agentic tool that connects gets one authoritative answer before it builds anything. Your code never leaves your machine.

## The problem

Design-relevant information in most codebases is spread across sources that were never meant to stay in sync — Figma files, token definitions, Storybook docs, and the codebase itself. They drift. Humans can reconcile the gaps by inference and judgment. Agents cannot.

When an agent encounters inconsistent or missing design context, it falls back on generalised patterns from its training data. The result is UI that works but doesn't fit — components recreated instead of reused, tokens hardcoded, naming conventions ignored.

For teams with large or long-lived codebases, the problem runs deeper still. Years of design decisions exist only in the code — patterns that were never written down, conventions that spread by imitation. Primitiv addresses both: it sits above all your sources, resolves conflicts between them, surfaces the rules your codebase is already following, and exposes a single machine-readable contract via MCP. Any agent that connects gets one consistent answer before it builds anything.

## How it works

```
Any source                      Primitiv                    Your agent

Figma           ──┐
Codebase        ──┤──► scan ──► reconcile ──► contract ──► MCP ──► Cursor / Claude Code / Codex / Windsurf / any MCP-compatible tool
Storybook       ──┤
Tokens file     ──┤
Any adapter     ──┘
```

1. **Scan** — Primitiv ingests from any configured source via adapters
2. **Reconcile** — Conflicts between sources are surfaced and resolved according to your governance configuration
3. **Infer** — Design rules are extracted from actual codebase patterns and written into the contract
4. **Contract** — A single `primitiv.contract.json` is written as the canonical reference
5. **MCP** — Agents call `get_design_context` before building and receive the resolved contract

---

## Getting started

### Install

```bash
npm install @ai-by-design/primitiv
# or
bun add @ai-by-design/primitiv
```

### Quick start

**1. Run init in your project root:**

```bash
bunx @ai-by-design/primitiv init
```

Primitiv detects your framework, TypeScript, Tailwind, Figma token files, and Storybook automatically and generates a tailored `primitiv.config.js`.

**2. Build your contract:**

```bash
bunx @ai-by-design/primitiv build
```

**3. Start the MCP server:**

```bash
bunx @ai-by-design/primitiv serve
```

`primitiv init` writes a `.mcp.json` to your project root automatically, so Cursor, Claude Code, and any other MCP-compatible tool will pick up the server without manual config.

From this point, every agent that builds UI in your codebase calls `get_design_context` first and gets your resolved design contract back.

### CLI

| Command | Description |
|---------|-------------|
| `primitiv init [dir]` | Detect your project and generate `primitiv.config.js` |
| `primitiv build [config]` | Scan sources, resolve conflicts, write the contract |
| `primitiv serve [config]` | Start the MCP server |

### MCP tools

| Tool | Description |
|------|-------------|
| `get_design_context` | Get all tokens, components, conflicts, and inferred rules. Pass `category: "all"` to get everything. |
| `get_token` | Look up a specific token by name |
| `get_component` | Look up a specific component and its props |
| `get_conflicts` | Get unresolved conflicts between sources |
| `get_inferred_rules` | Get the design rules Primitiv has extracted from your codebase patterns |

Primitiv works with any tool that speaks MCP — it is not tied to a specific editor or agent ecosystem.

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

- **`STALE CONTRACT`** — the contract is outdated. The warning includes the exact command to rebuild, e.g.: `bunx @ai-by-design/primitiv build /path/to/your/primitiv.config.js`
- **`CONTRACT MISMATCH`** — the server is serving a contract from a different project. This usually means Primitiv is in your global editor MCP config. Remove it from there and re-run `primitiv init` in the correct project.

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

### Local setup

```bash
git clone https://github.com/AI-by-design/primitiv.git
cd primitiv
bun install
bun run build
```

### Running in development

To run the MCP server against local source without a build step, point your MCP config directly at the source file. Bun runs TypeScript directly so changes are picked up on the next server restart:

```json
{
  "mcpServers": {
    "primitiv": {
      "command": "bun",
      "args": ["/path/to/primitiv/src/cli.ts", "serve", "./primitiv.config.js"]
    }
  }
}
```

The MCP server also hot-reloads `primitiv.contract.json` automatically whenever `primitiv build` runs.

### Build commands

```bash
bun run build   # Compile TypeScript → dist/
bun run dev     # Run src/index.ts directly via ts-node
bun run lint    # ESLint on src/**/*.ts
```

### Architecture

```
src/
├── cli.ts          Entry point — routes init / build / serve
├── index.ts        Exports build() and serve()
├── types.ts        All shared interfaces — define types here, not inline
├── scanner/        CodebaseScanner — extracts tokens and components from the filesystem
├── contract/       ContractBuilder — merges sources, detects conflicts, applies governance
├── inferrer/       inferRules() — derives design rules from token and component patterns
├── mcp/            PrimitivMCPServer — loads the contract and registers MCP tools
└── init/           init() — detects framework and writes primitiv.config.js
```

See `CLAUDE.md` for conventions on adding new sources, MCP tools, and types.

### Releases

Releases are managed by [Release Please](https://github.com/googleapis/release-please). Commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

| Prefix | Effect |
|--------|--------|
| `fix: ...` | Patch release (0.1.0 → 0.1.1) |
| `feat: ...` | Minor release (0.1.0 → 0.2.0) |
| `feat!: ...` or `BREAKING CHANGE:` | Major release |
| `chore:`, `docs:`, `refactor:` | No release |

On merge to `main`, Release Please opens a release PR. Merging that PR tags the release and publishes to the package registry automatically.

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
- [x] MCP server with 5 tools
- [x] `primitiv init` — project detection and config generation
- [x] Inferred rules — extract design rules from actual codebase patterns
- [x] AGENTS.md / CLAUDE.md integration — `primitiv init` writes agent instructions to the project's agent config file, ensuring `get_design_context` is called before any UI build without manual prompting
- [x] Project-scoped MCP config — `primitiv init` writes a project-level MCP config so the server is scoped to the current project, not a global user-level server
- [x] `build-component` skill — `primitiv init` installs a Claude Code slash command that queries the contract before building any UI component
- [x] Remediation steps on conflicts — conflicts include a `suggestedFix` and `actionable` flag so agents know exactly what to do, not just what's wrong
- [x] Published to npm — available as `@ai-by-design/primitiv`

## License

MIT
