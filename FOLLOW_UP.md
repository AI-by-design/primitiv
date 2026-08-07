# Follow-up — 6 August 2026

## Remaining work

### Triage MCP SDK transitive advisories — reviewed 6 August 2026

Upgraded `@modelcontextprotocol/sdk` from 1.29.0 to 1.30.0. As of 6 August 2026, `bun audit` reported 28 transitive advisories in the SDK's broad HTTP/server dependency tree: `express > body-parser > qs` (moderate `GHSA-q8mj-m7cp-5q26`), `@hono/node-server` (moderate `GHSA-frvp-7c67-39w9`), `ajv > fast-uri` (five high advisories), `express-rate-limit > ip-address` (one high and one moderate advisory), and `hono` (18 HTTP/adapter/JSX advisories).

The shipped `primitiv serve` CLI imports only `McpServer` and `StdioServerTransport`; it starts no HTTP, SSE, or Streamable HTTP listener. Its MCP server is a local, process-spawned stdio service with read-only tools. The advisories concern HTTP request parsing, static serving, CORS/cookies, Lambda adapters, SSR/JSX, and URI/IP address handling, so they are not reachable through Primitiv's built-in MCP transport. This assessment does not cover consumers that instantiate `PrimitivMCPServer` with a custom transport.

No override was added. SDK 1.30.0 permits the fixed `@hono/node-server` 2.0.5 line, but retaining the lockfile's existing 1.x resolution is lower risk than forcing an unused HTTP adapter upgrade.

Next steps:

- On each MCP SDK upgrade, rerun `bun audit` and review the remaining dependency paths.
- Upgrade when the SDK's normal dependency resolution removes the advisories, or add an override only when a specific reachable path requires it.
- Add an override only when it is narrow, compatible, and backed by a specific risk assessment.

### Optional design decision: top-level build timestamp

`inferredRules.generatedAt` is now deterministic. The top-level `contract.generatedAt` still changes on each build intentionally: MCP freshness warnings and `primitiv verify --fast` use it.

Only revisit this if byte-for-byte stable full contract files become more valuable than those freshness features.

## Housekeeping

- Local `main` is synced with GitHub at `8f3cadd` (`v2.8.0`).
- Optionally delete the merged local feature branches after confirming no further local inspection is needed.

## Completed today

PRs #97–#103 are merged. There are no open GitHub issues.
