# Primitiv

The reconciliation layer for agentic design systems.

Primitiv sits above your design sources — Figma, codebase, Storybook, token files, or any adapter you configure — scans them, resolves conflicts between them, and surfaces the design rules your codebase is already following. The result is a single machine-readable contract exposed via MCP. Any agentic tool that connects to Primitiv gets one consistent answer before it builds anything.

## The problem

Most product codebases have design-relevant information distributed across multiple sources: design tools (Figma, Sketch), component documentation (Storybook, Zeroheight), token files (Style Dictionary, CSS variables, Tailwind config), and the codebase itself. These sources are maintained independently and frequently drift out of sync.

This has historically been manageable because human developers can infer intent, ask questions, and reconcile inconsistencies themselves. Agentic coding tools cannot. They consume context and execute against what they are given. When the context is inconsistent or incomplete, agents default to generalised patterns from their training data rather than the specific conventions of the product they are working on.

The result is UI that is technically functional but inconsistent with the existing product — components recreated instead of reused, tokens ignored or hardcoded, naming conventions not followed.

For teams with large or long-lived codebases, the problem runs deeper. There is no blank page to start from. Years of organic decisions are embedded in the code — patterns that were never written down, conventions that exist only because everyone followed the person before them. When you need to define the rules your system actually follows, you have no starting point. Primitiv addresses this too. It scans what exists and surfaces the design rules your codebase is already following, whether they were ever intentional or not — giving you a foundation to build from, not a blank page.

Primitiv addresses this by sitting above all existing sources, resolving conflicts between them according to configurable governance rules, surfacing inferred rules from actual codebase patterns, and exposing a single machine-readable contract via MCP. Any agentic tool that connects to Primitiv gets one consistent answer before it builds anything.

## How it works

```
Any source                      Primitiv                    Your agent
                                                           
Figma           ──┐                                       
Codebase        ──┤──► scan ──► reconcile ──► contract ──► MCP ──► Cursor / Claude Code
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
bun add primitiv
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

**3. Add to your MCP config (Cursor / Claude Code):**

```json
{
  "mcpServers": {
    "primitiv": {
      "command": "bun",
      "args": ["/path/to/primitiv/dist/cli.js", "serve", "/path/to/your/project/primitiv.config.js"]
    }
  }
}
```

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

**Source-agnostic** — Primitiv does not assume any particular toolchain. Sources are configured via adapters, and new adapters can be added for any system that holds design-relevant information.

**Contract over documentation** — The output is a machine-readable contract, not human-readable documentation. It is designed to be consumed by agents, not read by people.

**Inferred before prescribed** — Primitiv surfaces the rules your codebase is already following before asking you to write any. The inferred rules are a starting point, not a final answer.

**Governance is explicit** — When sources conflict, the resolution is not silent. Conflicts are surfaced, logged, and resolved according to rules you define. Nothing is resolved by guessing.

**Incrementally adoptable** — Start with a single source. Add more as needed. The contract remains valid at any level of completeness.

## Roadmap

- [x] Codebase scanner (CSS variables, TypeScript tokens, React components)
- [x] Contract builder with conflict detection
- [x] MCP server with 4 tools
- [x] `primitiv init` — project detection and config generation
- [ ] Inferred rules — extract design rules from actual codebase patterns
- [ ] Token relationships — document how tokens relate and what constraints exist between them
- [ ] Remediation steps on conflicts — tell agents what to do, not just what's wrong
- [ ] Figma source adapter (via Figma API)
- [ ] Storybook source adapter (via Component Manifest)
- [ ] `primitiv diff` — show what changed since last build
- [ ] Watch mode — rebuild contract automatically on file changes
- [ ] Conflict auto-resolution
- [ ] publish to npm/JSR

## License

MIT
