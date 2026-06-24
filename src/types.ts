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
}

export interface FigmaSource {
  token: string
  fileId: string
}

export interface StorybookSource {
  url: string
  // Optional: filesystem path where Storybook's `importPath` entries resolve.
  // When set, the adapter reads story source files to extract argTypes as props.
  // Usually the project root. Resolved relative to primitiv.config.js when relative.
  sourceRoot?: string
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
}

// Keyed by component id, not bare name, so same-name components coexist instead of
// overwriting each other. Codebase ids are path-qualified: the file's path relative to the
// scan root, sans extension (`components/ui/Card`), with `#Name` appended only when the
// component's name doesn't match its filename (`components/ui/Card#CardHeader` for a
// compound sibling; normalized match, so `card-header.tsx` ↔ `CardHeader` and `index.*` ↔
// folder name). Figma/Storybook components have no fs path; their ids are source-prefixed
// (`figma:Card`, `storybook:Card`) so they can never collide with path ids.
export interface ComponentMap {
  [id: string]: Component
}

export type ComponentKind = "component" | "screen" | "provider" | "icon" | "other"

export interface Component {
  name: string
  // The bare export name (`Card`) — what humans and agents call it. The map key is the
  // qualified id; lookups by name go through the contract's componentNameIndex.
  displayName?: string
  // What the AST scanner judged this export to be. Reusable UI = "component";
  // screens/providers/icons are tagged (not dropped) so consumers can filter noise.
  kind?: ComponentKind
  // Optional explicit override for path-scope resolution when the file's own path
  // isn't the right scope (e.g. a shared component that should win in one app area).
  scope?: string
  source: SourceProvenance
  variants?: string[]
  props?: Record<string, PropDefinition>
  rationale?: Rationale
  [key: string]: unknown
}

export interface PropDefinition {
  type: string
  required: boolean
  default?: string
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
  generatedAt: string
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
