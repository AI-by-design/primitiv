# Primitiv demo

A minimal, realistic design system — 40 tokens, 2 components, per-token rationale — that Primitiv scans and reconciles. Use this directory to see what Primitiv produces end-to-end.

## Run it

```bash
cd examples/demo

# After installing @ai-by-design/primitiv from npm:
primitiv build
primitiv serve

# From this repo, before publishing:
node ../../dist/cli.js build
node ../../dist/cli.js serve
```

## What you get

- **`primitiv.contract.json`** — the reconciled output. Tokens with source provenance and rationale, components with props + rationale, inferred rules (spacing scale, naming convention, dark-mode detection).
- **MCP server** — serves `get_design_context`, `get_token`, `get_component`, `get_conflicts`, `get_inferred_rules` so any MCP-capable agent can query the contract at prompt time.

## What this demo does NOT cover

- Multi-source reconciliation (Figma + Storybook + code). The demo is codebase-only so it runs with no credentials. Uncomment the `figma` or `storybook` sources in `primitiv.config.js` and add your own to see conflicts surface.
- Deprecation flow. To see it, set `deprecated: true` on any rationale entry in `primitiv.rationale.yml` — agents reading the contract will refuse that token and suggest `alternatives`.
