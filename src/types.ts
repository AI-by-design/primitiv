import type * as t from "@babel/types"
import { z } from "zod"

// Core types for Primitiv

export interface PrimitivConfig {
  sources: {
    codebase?: CodebaseSource
    figma?: FigmaSource
    storybook?: StorybookSource
  }
  governance: {
    sourceOfTruth: "codebase" | "figma" | "storybook" | "manual"
    onConflict: "error" | "warn" | "auto-resolve"
  }
  output: {
    path: string
  }
  // Optional per-token / per-component rationale: why it exists and when to use it.
  // Load from a sidecar YAML (default: ./primitiv.rationale.yml) or inline.
  rationale?: {
    path?: string
    inline?: RationaleMap
  }
}

export interface Rationale {
  why?: string
  when?: string
  deprecated?: boolean
  alternatives?: string[]
  examples?: string[]
  tags?: string[]
}

export interface RationaleMap {
  // Keys are dotted token paths: "colors.primary", "spacing.sm".
  tokens?: Record<string, Rationale>
  // Keys are component names as they appear in the contract.
  components?: Record<string, Rationale>
}

export interface CodebaseSource {
  root: string
  patterns: string[]
  ignore: string[]
  // `optional: false` marks the source required: a failed scan fails the whole build.
  // Default (true/absent): a failed scan is recorded in sourceStatuses and the build
  // continues. The governance.sourceOfTruth is always required regardless of this flag.
  optional?: boolean
}

export interface ComponentAnalysisModule {
  content: string
  file: string
  program: t.Program
}

export interface FigmaSource {
  token: string
  fileId: string
  // Explicit mappings keyed by Figma's publish-stable variable `key` (and mode `modeId`).
  // They are opt-in declarations, never name-based inference.
  numericUnits?: Record<string, string>
  tokenAliases?: Record<string, string>
  modeAliases?: Record<string, string>
  optional?: boolean
}

export interface StorybookSource {
  url: string
  // Optional: filesystem path where Storybook's `importPath` entries resolve.
  // When set, the adapter reads story source files to extract argTypes as props.
  // Usually the project root. Resolved relative to primitiv.config.js when relative.
  sourceRoot?: string
  optional?: boolean
}

export interface Source {
  scan(): Promise<{ tokens: TokenMap; components: ComponentMap }>
}

// Source provenance — tracks where every token and component came from
export interface SourceProvenance {
  adapter: "codebase" | "figma" | "storybook"
  file?: string
  line?: number
  metadata?: Record<string, unknown>
}

// Scan outcome per known source, recorded on every build so the contract can
// distinguish "not configured" (skipped) from "configured but failed" (failed).
// One field covering every source — not a failures-only error list — so consumers
// (verify, the MCP server, a future diff engine) read one complete picture.
export type SourceScanStatus = "ok" | "failed" | "skipped"

export interface SourceStatus {
  status: SourceScanStatus
  // Present on "ok": what the scan contributed.
  tokens?: number
  components?: number
  // Present on "failed": sanitized message — status code + short reason only,
  // never a response body or URL (the contract gets committed and fed to LLMs).
  error?: string
}

// The resolved contract — single source of truth
export interface PrimitivContract {
  version: string
  generatedAt: string
  sources: string[]
  sourceRoot: string
  configPath: string
  tokens: TokenMap
  components: ComponentMap
  // displayName → component ids. The lookup bridge from the bare names agents know
  // ("Card") to the qualified keys in `components`. Optional so pre-0.3 contracts load.
  componentNameIndex?: Record<string, string[]>
  conflicts: Conflict[]
  inferredRules?: InferredRules
  // Optional so older contract files (pre-1.6) load without crashing.
  violations?: Violation[]
  // Optional so pre-2.2 contracts load. Keyed "codebase" | "figma" | "storybook".
  sourceStatuses?: Record<string, SourceStatus>
}

export interface TokenMap {
  colors: Record<string, Token>
  spacing: Record<string, Token>
  typography: Record<string, Token>
  borderRadius: Record<string, Token>
  shadows: Record<string, Token>
  [key: string]: Record<string, Token>
}

// The canonical token-category vocabulary — the single source of truth for the category set.
// Every category-assigning function is typed against this (so a misspelled or unaccounted-for
// category is a compile error, not a silent miscategorization), and `emptyTokenMap()` seeds
// from it (so the "starter" map never drifts from the real set). Adding a category is a one-line
// change here. ("other" is the on-demand fallback bucket, created lazily when a token matches no
// category — deliberately not seeded into the empty map.)
export const TOKEN_CATEGORIES = [
  "colors",
  "spacing",
  "sizes",
  "typography",
  "borderRadius",
  "shadows",
  "zIndex",
  "breakpoints",
  "motion"
] as const

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number]

// A fresh, empty token map carrying every canonical category. The one place a blank TokenMap is
// produced — call this instead of hand-typing the category list, so the set lives in exactly one
// spot. Every contract therefore lists all categories (some empty), a stable shape for consumers.
export function emptyTokenMap(): TokenMap {
  return Object.fromEntries(TOKEN_CATEGORIES.map((category) => [category, {}])) as TokenMap
}

// The lint surface is its own, narrower vocabulary: token-misuse detection only covers color and
// spacing literals. Kept separate from TOKEN_CATEGORIES so neither pollutes the other — so
// get_violations advertises exactly these and never the full token set.
export const LINT_CATEGORIES = ["colors", "spacing"] as const

export type LintCategory = (typeof LINT_CATEGORIES)[number]

export interface Token {
  name: string
  value: string
  source: SourceProvenance
  references?: string[]
  rationale?: Rationale
  // Theme-scoped values keyed by mode (`dark`, `light`, `dim`, …). `value` is the default —
  // the value under `:root`/unscoped selectors — while each entry here is the SAME token's value
  // under a theme selector (`.dark`, `[data-theme="dim"]`) or `@media (prefers-color-scheme: …)`.
  // A theme value is the token in another mode, not a separate token, so it lives here instead of
  // spawning a `-dark` name or a false cross-value conflict. Mirrors Figma's valuesByMode with a
  // default mode: future non-default Figma modes land in this field with no schema change. Absent
  // when the token has no theme variants.
  modes?: Record<string, string>
  // Provenance for each theme-mode value. This stays separate from `source`, whose value tracks
  // the default token only: governance may legitimately select a default from one source and a
  // mode from another. Optional for backwards compatibility with existing contracts.
  modeSources?: Record<string, SourceProvenance>
}

// A token name defined more than once with DIFFERENT values inside one source.
// Cross-source conflict detection can never see these — each source's token map is
// collapsed before merging — so the scanner reports them and ContractBuilder surfaces
// them as pending conflicts (rule 11: conflicts surface, never silence). Same-value
// duplicates are harmless and not reported.
export interface TokenRedefinition {
  category: string
  name: string
  // The definition the contract keeps (first write wins).
  kept: { value: string; source: SourceProvenance }
  // Later definitions with different values, in scan order.
  discarded: Array<{ value: string; source: SourceProvenance }>
}

// Keyed by component id, not bare name, so same-name components coexist instead of
// overwriting each other. Codebase ids are path-qualified: the file's path relative to the
// scan root, sans extension (`components/ui/Card`), with `#Name` appended only when the
// component's name doesn't match its filename (`components/ui/Card#CardHeader` for a
// compound sibling; normalized match, so `card-header.tsx` ↔ `CardHeader` and `index.*` ↔
// folder name). Figma/Storybook components have no fs path; their ids are source-prefixed
// (`figma:<published-key>` for Figma's published identity, `storybook:<display-name>` for the
// existing Storybook identity) so they can never collide with path ids.
export interface ComponentMap {
  [id: string]: Component
}

export type ComponentKind = "component" | "screen" | "provider" | "icon" | "other"

export interface Component {
  name: string
  // The bare export name (`Card`) — what humans and agents call it. The map key is the
  // qualified id; lookups by name go through the contract's componentNameIndex.
  displayName?: string
  // Optional source-provided description (for example, a published Figma component description).
  description?: string
  // What the AST scanner judged this export to be. Reusable UI = "component";
  // screens/providers/icons are tagged (not dropped) so consumers can filter noise.
  kind?: ComponentKind
  // Optional explicit override for path-scope resolution when the file's own path
  // isn't the right scope (e.g. a shared component that should win in one app area).
  scope?: string
  source: SourceProvenance
  variants?: string[]
  props?: Record<string, PropDefinition>
  // Qualified target component id → statically resolved local JSX opening-site count.
  // Static source evidence only, never runtime frequency. Omitted when no edges exist.
  uses?: Record<string, number>
  // Statically resolved local JSX sites that target this component. Presence means at
  // least one site; zero is represented by absence. Observed props are bounded static
  // source evidence from explicit JSX attributes, never runtime-frequency claims.
  usage?: {
    sites: number
    props?: Record<string, Array<string | number | boolean | null>>
    // Sorted prop names whose distinct observed values exceeded the retained bound.
    truncatedProps?: string[]
  }
  rationale?: Rationale
  [key: string]: unknown
}

export interface PropDefinition {
  type?: string
  required?: boolean
  default?: string
  // Complete finite literal values declared by the prop type, preserving primitive types.
  values?: Array<string | number | boolean>
  // Source-neutral category for evidence that does not map cleanly to a language type.
  kind?: "boolean" | "text" | "variant" | "instance-swap"
  // Recommended instance-swap targets; unlike `values`, these are not an exhaustive domain.
  preferredValues?: Array<{
    type: "component" | "component-set"
    key: string
  }>
}

export interface Conflict {
  type: "token" | "component"
  name: string
  sources: Array<{
    source: SourceProvenance
    value: string
  }>
  resolved?: string
  resolution?: "auto" | "manual" | "pending"
  suggestedFix?: string
  actionable?: boolean
}

export interface InferredRule {
  id: string
  category: "spacing" | "colors" | "typography" | "borderRadius" | "naming" | "components"
  rule: string
  confidence: "high" | "medium" | "low"
  evidence: string[]
}

export interface InferredRules {
  // New contracts use the enclosing contract's generatedAt timestamp. Keep this optional
  // so contracts written before that consolidation still load without migration.
  generatedAt?: string
  rules: InferredRule[]
}

// A token-misuse violation: a hardcoded literal in component code that
// bypasses the contract. Surfaced by `primitiv build` and `primitiv verify`.
export interface Violation {
  type: "token-misuse"
  // Only colors and spacing are linted today (see LINT_CATEGORIES); typed against that surface
  // so the contract can't claim a violation category the linter never emits.
  category: LintCategory
  // The raw literal as captured (e.g. "#ff0000", "7px").
  found: string
  // The surrounding utility (e.g. "bg-[#ff0000]") for context in the report.
  context: string
  source: { file: string; line: number; column: number }
  // Present iff a contract token's value matches `found` after normalization.
  // The smart-match suggestion that turns the report into a fix.
  suggestion?: {
    token: string
    category: string
    value: string
  }
}

// ─── Boundary validation (Rule 12) ───────────────────────────────────────────
// Two lean schemas guarding Primitiv's two untrusted inputs: the user-authored
// config (loaded via require) and the contract JSON (read by the MCP server and
// by verify). Deliberately shallow — they check the top-level shape consumers
// actually dereference, not every leaf token/component/prop. `looseObject` keeps
// unknown and future fields instead of stripping them (backward-compat: pre-1.6
// contracts, fields added later). Deep value validation would walk thousands of
// tokens on every hot-reload for zero crash-safety gain, and would couple the
// contract schema to the token/prop shapes it has no reason to know about — so
// `tokens`/`components` are validated only as objects, their values left opaque.

const figmaStableKeyMappings = z.record(z.string().min(1), z.string().min(1))

export const primitivConfigSchema = z.looseObject({
  sources: z.looseObject({
    codebase: z
      .looseObject({
        root: z.string(),
        patterns: z.array(z.string()),
        ignore: z.array(z.string()),
        optional: z.boolean().optional()
      })
      .optional(),
    figma: z
      .looseObject({
        token: z.string(),
        fileId: z.string(),
        // Empty keys would act as accidental wildcards for Figma variables that lack a
        // publish-stable key; empty values would erase a token or mode name.
        numericUnits: figmaStableKeyMappings.optional(),
        tokenAliases: figmaStableKeyMappings.optional(),
        modeAliases: figmaStableKeyMappings.optional(),
        optional: z.boolean().optional()
      })
      .optional(),
    storybook: z.looseObject({ url: z.string(), optional: z.boolean().optional() }).optional()
  }),
  governance: z.looseObject({
    sourceOfTruth: z.enum(["codebase", "figma", "storybook", "manual"]),
    onConflict: z.enum(["error", "warn", "auto-resolve"])
  }),
  output: z.looseObject({ path: z.string() })
})

export const primitivContractSchema = z.looseObject({
  version: z.string(),
  generatedAt: z.string(),
  sources: z.array(z.string()),
  tokens: z.record(z.string(), z.unknown()),
  components: z.record(z.string(), z.unknown()),
  conflicts: z.array(z.unknown())
})

// Compact, human-readable reason a config/contract failed validation — the
// actionable tail of every boundary error/warning. Caps at three issues so the
// message stays a single readable line.
export function summarizeValidationIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ")
}
