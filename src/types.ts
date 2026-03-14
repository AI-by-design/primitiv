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

// The resolved contract — single source of truth
export interface PrimitivContract {
  version: string
  generatedAt: string
  sources: string[]
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
  source: string
  references?: string[]
}

export interface ComponentMap {
  [name: string]: Component
}

export interface Component {
  name: string
  path: string
  source: string
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
    source: string
    value: string
  }>
  resolved?: string
  resolution?: "auto" | "manual" | "pending"
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