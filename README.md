# Primitiv

**The design system contract keeping teams and agents in sync.**

Retrieval gives you data. Reconciliation gives you truth.

<video src="https://github.com/user-attachments/assets/deb63812-72ea-4651-b248-31d817725d10" controls muted></video>

## The problem

Design-system knowledge is spread across code, Figma, Storybook, and documentation. When those sources drift, people reconcile the differences through experience; AI coding agents often fall back to generic patterns that work but do not belong in the product.

Primitiv gives every agent the same current design context through a machine-readable contract and a read-only MCP interface. It helps agents reuse what exists, follow established decisions, and surface inconsistencies before they ship.

Primitiv runs locally. Your code never leaves your machine.

## Quick start

Run these commands from your project root:

```bash
npx @ai-by-design/primitiv init
npx @ai-by-design/primitiv build
npx @ai-by-design/primitiv serve
```

`init` sets up Primitiv for the current project, `build` creates its design contract, and `serve` makes that contract available to MCP-compatible agents.

See the [Primitiv documentation](https://primitiv.design/docs) for installation, configuration, commands, and integration guides.

> [!IMPORTANT]
> Keep Primitiv configured at project level. A global MCP configuration can serve the wrong project's contract when you switch repositories.

## Capabilities

- Bring design context from your codebase, Figma, and Storybook together
- Make existing tokens, components, rules, and rationale available to agents
- Surface conflicts, drift, and hardcoded token misuse
- Provide read-only access from MCP-compatible agents and editors
- Verify that the contract stays current in CI

## Project links

- [Documentation](https://primitiv.design/docs)
- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security](./SECURITY.md)
- [Issues](https://github.com/AI-by-design/primitiv/issues)
- [Apache-2.0 license](./LICENSE)
