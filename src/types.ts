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
}

export interface ComponentMap {
  [name: string]: Component
}

export interface Component {
  name: string
  source: SourceProvenance
  variants?: string[]
  props?: Record<string, PropDefinition>
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
  category: 'spacing' | 'color' | 'typography' | 'border-radius' | 'naming' | 'components'
  rule: string
  confidence: 'high' | 'medium' | 'low'
  evidence: string[]
}

export interface InferredRules {
  generatedAt: string
  rules: InferredRule[]
}