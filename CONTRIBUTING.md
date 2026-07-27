# Contributing to Primitiv

Thanks for your interest in contributing. Primitiv is small and actively evolving — bug reports, feature ideas, and PRs are all welcome.

## Before you start

- **Bug reports and feature requests** — please [open an issue](https://github.com/AI-by-design/primitiv/issues/new). Include the version (`primitiv --version` or your `package.json` entry), what you ran, what you expected, and what happened.
- **Larger changes** — open an issue first to discuss the approach before investing time in a PR.
- **Small fixes** (typos, docs, obvious bugs) — go straight to a PR.

All contributions are licensed under [Apache-2.0](./LICENSE).

## Local setup

```bash
git clone https://github.com/AI-by-design/primitiv.git
cd primitiv
bun install
bun run build
```

## Running in development

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

## Build commands

```bash
bun run build   # Compile TypeScript → dist/
bun run dev     # Run src/index.ts directly via ts-node
bun run lint    # Biome lint on src/
bun run fmt     # Biome format --write on src/
bun test        # Run the test suite (bun:test)
```

Before opening a PR, make sure `bun lint`, `bun test`, and `bun run build` all pass.

## Architecture

```
src/
├── cli.ts          Entry point — routes init / build / serve / verify
├── index.ts        Exports build() and serve()
├── types.ts        All shared interfaces — define types here, not inline
├── scanner/        CodebaseScanner — extracts tokens and components from the filesystem
├── sources/        Source adapters — Figma, Storybook
├── contract/       ContractBuilder — assembles the contract from all sources
├── inferrer/       inferRules() — the inferred-rules layer
├── lint/           Token-misuse detection
├── rationale/      Loads primitiv.rationale.yml into the contract
├── mcp/            PrimitivMCPServer — loads the contract and registers the 6 MCP tools
├── init/           init() — detects framework and writes primitiv.config.js + project wiring
└── verify/         verify() — re-runs build and exits non-zero for CI
```

See [CLAUDE.md](./CLAUDE.md) for module conventions, coding rules, and the Primitiv-specific architectural rules adapters and tools must follow.

## Commits and releases

Releases are managed by [Release Please](https://github.com/googleapis/release-please). Commit messages must follow the [Conventional Commits](https://www.conventionalcommits.org/) format:

| Prefix | Effect |
|--------|--------|
| `fix: ...` | Patch release (0.1.0 → 0.1.1) |
| `feat: ...` | Minor release (0.1.0 → 0.2.0) |
| `feat!: ...` or `BREAKING CHANGE:` | Major release |
| `chore:`, `docs:`, `refactor:` | No release |

On merge to `main`, Release Please opens a release PR. Merging that PR tags the release and publishes to npm automatically via OIDC trusted publishing.

## Code of Conduct

Participation in this project is governed by the [Contributor Covenant Code of Conduct](./CODE_OF_CONDUCT.md). Report unacceptable behavior to ana.state88@gmail.com.
