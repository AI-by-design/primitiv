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

Primitiv also checks local JSX usage against each codebase component's complete finite prop domains. Known out-of-domain values produce a pending `within-source` conflict, even under `auto-resolve`. Align the JSX usage or widen the declared domain to resolve it. `warn` reports these conflicts without blocking; `error` and `verify --strict` exit with code 2. Dynamic values and incomplete domains remain unknown.

When component evidence cannot be compared, `primitiv verify` reports a short diagnostic summary. Use `primitiv verify --verbose` for the reasons, or `--json` for a structured report. Diagnostics explain uncertainty and do not count as conflicts or directly fail verification; changes to them can still make the saved contract stale. `--fast` reports saved diagnostics instead of rebuilding them.

Agents can read diagnostic counts in the MCP summary and paginated details through `get_design_context` with `category: "diagnostics"`.

## Component drift in CI

Run `primitiv verify` against your saved contract to check declared prop facts, finite variant values, observed JSX values, and component relationships. Verification also compares Storybook default args, story args, and control choices, including mapped values. Story labels and other presentation metadata do not count as API drift. Observations and examples describe static source evidence, not runtime frequency or breaking-change severity.

For example, changing a `Button` usage from `size="sm"` to `size="lg"` is detected even when the number of JSX sites stays the same. Drift messages identify the component ID and field path, such as `components/Button` and `usage.props.size`.

Normal verification scans current sources in memory and uses their current conflicts for reporting and governance. Introducing or fixing an out-of-domain JSX value takes effect in verification immediately. The saved contract remains the drift baseline and is never rewritten by verification: run `primitiv build` to refresh it, then verify again. MCP continues serving the saved contract until it is rebuilt and reloaded.

Failed sources and incomplete or truncated evidence cannot prove that an unavailable fact was removed or that a conflict was resolved. Verification reports available changes and comparison uncertainty. Older contracts remain readable; newly available evidence makes them stale until rebuilt.

Stale evidence exits with code 1, or 2 under `--strict`. Pending conflicts exit with code 2 under `error` governance or `--strict`; warn-only conflicts do not independently fail verification. `--fast` uses saved findings and file modification times instead of scanning current API evidence, so use normal verification in CI. Use `--json` for the verification result and `--verbose` for comparison diagnostic details.

## Project links

- [Documentation](https://primitiv.design/docs)
- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Security](./SECURITY.md)
- [Issues](https://github.com/AI-by-design/primitiv/issues)
- [Apache-2.0 license](./LICENSE)

### Optional component guidance schemas

The package root exports optional classification and richer rationale schemas for
consumer validation. This schema increment does not yet integrate their
validation, canonical attachment, health production, or reference resolution
into `build`, `verify`, or MCP tools. The current rationale loader continues its
existing behavior; it does not promise to move classification into the component's
canonical `classification` field. Token rationale stays unchanged.

Every classification field is optional. `classification.atomicLevel` accepts
`atom`, `molecule`, `organism`, `template`, or `page`;
`classification.intents` accepts any combination of `navigation`, `input`,
`feedback`, `content-display`, and `call-to-action`. Intents normalize to a sorted
set. No labels are inferred or required, including for providers. `Component.kind`
continues to describe the scanner's export category.

Component annotations retain `why`, `when`, `deprecated`, `alternatives`,
`examples`, and `tags`, and add these optional fields:

| Field | Shape and meaning |
| --- | --- |
| `description` | Nonblank authored explanation; does not overwrite the source description. |
| `avoidWhen` | Ordered `{ condition, alternative?: { componentId } }` entries. |
| `pairsWith` | Ordered `{ description, component?: { componentId } }` entries; suggestions, not required dependencies. |
| `classification` | Optional atomic level and intent set, stored separately from component rationale in the canonical contract representation. |

References use an exact existing qualified component ID, such as
`components/search/FilterPanel` or `storybook:Search/Filters`. Schema validation
checks the reference's syntax and bounds; it cannot establish whether a target
exists. Existing `alternatives` remain prose. Empty annotations and empty intent
lists are valid. Null annotations and blank newly introduced prose are invalid;
legacy empty prose remains valid. Ordered examples, avoidance entries, and
pairings preserve their order and meaningful whitespace.

See the original equivalent [YAML](examples/guidance/rationale.yml) and
[JSON](examples/guidance/rationale.json) examples. Existing file selection remains
`primitiv.rationale.yml` by default; JSON requires an explicit `rationale.path`.
The examples describe the new validation representation, with a partially
annotated inventory.

```ts
import { validateRationaleMap } from "@ai-by-design/primitiv"

const result = validateRationaleMap({
  components: {
    "components/ui/SearchField": {
      classification: { atomicLevel: "molecule", intents: ["input", "navigation"] },
      description: "Search the current list."
    }
  }
})
if (result.success) {
  console.log(result.data, result.warnings)
} else {
  console.log(result.issues, result.warnings)
}
```

Use `validateComponentAnnotation` or `validateRationaleMap` at authoring
boundaries when warnings matter. They return exact structured field paths,
unknown-field warnings, and duplicate-intent notices alongside known validated
fields. Unknown authored keys do not activate behavior. The lower-level Zod
schemas strip unknown authored keys without returning warnings. These authoring
validators return full notices and are not a bounded transport: callers must
bound raw input and notices before sharing them. Do not expose parser errors,
raw file contents, or secrets in shared diagnostics. Imported contracts retain
opaque extension fields through the existing outer contract schema.

New prose is limited to 8 KiB UTF-8 per field, reference IDs to 2 KiB, avoidance
and pairing lists to 32 entries each, and serialized newly introduced annotation
data to 64 KiB. Legacy fields are not retroactively bounded. Oversize new data
is rejected, never silently truncated. `GUIDANCE_LIMITS` exports these budgets.

The root also exports `guidanceOriginSchema`, `guidanceSourceStateSchema`,
`guidanceDiagnosticSchema`, and `guidanceHealthSchema` plus matching shared types.
They define future generated evidence, not author-supplied annotations. Origin
records identify source, authored key, and `id` or `unique-name` binding. Locators
are project-relative paths or `external:<logical-name>` (letters, digits, dots,
underscores, or hyphens); external locators identify a source without leaking a
local absolute path or claiming it is pinned by a checkout SHA.

Health uses `schemaVersion: 1`, `sources`, `total`, `byCode`, `items`, and
`truncated`. Source states contain `sourceId`, `selection`, `readState`,
`validEntries`, `invalidEntries`, `boundEntries`, `unboundEntries`, and `complete`.
Completeness means validation, binding, and reference assessment has sufficient
coverage, not that all annotations are valid or all targets resolve. Invalid
entries can coexist with complete assessment. A default absent source has zero
entries; a configured missing source is a failed read and cannot be complete.
An old contract without `guidanceHealth` has unknown health.

Diagnostic items retain entry keys, component/target IDs when known, structured
field paths, and bounded messages. Counts include omitted diagnostics: `byCode`
sums to `total`, retained counts cannot exceed code totals, and `truncated` is
true exactly when items were omitted. Up to 100 items fit within a 256 KiB
serialized UTF-8 health envelope; messages have a 512-byte limit and paths have
up to 32 segments. Producers must retain truthful counts when reducing items to
fit the envelope. Truncation or incomplete source coverage cannot prove that a
particular annotation was safely removed or a winner was valid. Consumers must
keep affected or unproven scopes unknown unless retained entry-specific evidence
establishes their state; schema validity alone is no completeness certificate.
