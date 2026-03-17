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

## Install

```bash
npm install @ai-by-design/primitiv
# or
bun add @ai-by-design/primitiv
```

## Quick start

**1. Run init in your project root:**

```bash
bunx primitiv init
```

Primitiv detects your framework, TypeScript, Tailwind, Figma token files, and Storybook automatically and generates a tailored `primitiv.config.js`.

**2. Build your contract:**

```bash
bunx primitiv build
```

**3. Start the MCP server:**

```bash
bunx primitiv serve
```

`primitiv init` writes a `.mcp.json` to your project root automatically, so Cursor, Claude Code, and any other MCP-compatible tool will pick up the server without manual config.

From this point, every agent that builds UI in your codebase calls `get_design_context` first and gets your resolved design contract back.

## CLI

| Command | Description |
|---------|-------------|
| `primitiv init [dir]` | Detect your project and generate `primitiv.config.js` |
| `primitiv build [config]` | Scan sources, resolve conflicts, write the contract |
| `primitiv serve [config]` | Start the MCP server |

## MCP tools

| Tool | Description |
|------|-------------|
| `get_design_context` | Get all tokens, components, conflicts, and inferred rules. Pass `category: "all"` to get everything. |
| `get_token` | Look up a specific token by name |
| `get_component` | Look up a specific component and its props |
| `get_conflicts` | Get unresolved conflicts between sources |
| `get_inferred_rules` | Get the design rules Primitiv has extracted from your codebase patterns |

Primitiv works with any tool that speaks MCP — it is not tied to a specific editor or agent ecosystem.

## Configuration

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
- [ ] Token relationships — document how tokens relate and what constraints exist between them
- [ ] Remediation steps on conflicts — tell agents what to do, not just what's wrong
- [ ] Figma source adapter (via Figma API)
- [ ] Storybook source adapter (via Component Manifest)
- [ ] `primitiv diff` — show what changed since last build
- [ ] Watch mode — watch source files and rebuild the contract automatically when they change (the MCP server already hot-reloads the contract on disk changes; this is the missing build trigger)
- [ ] Conflict auto-resolution
- [x] Project-scoped MCP config — `primitiv init` writes a project-level MCP config so the server is scoped to the current project, not a global user-level server
- [ ] publish to npm/JSR

## License

MIT
