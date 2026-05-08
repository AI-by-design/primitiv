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

export interface Token {
  name: string
  value: string
  source: SourceProvenance
  references?: string[]
  rationale?: Rationale
}

export interface ComponentMap {
  [name: string]: Component
}

export interface Component {
  name: string
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
  category: "spacing" | "color" | "typography" | "border-radius" | "naming" | "components"
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
  category: "colors" | "spacing" | "typography" | "borderRadius" | "shadows"
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
