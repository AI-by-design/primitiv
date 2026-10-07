import type { AtomicLevel, Component, ComponentIntent, ComponentKind, PrimitivContract } from "../types"

export interface SnapshotOptions {
  /** Only explicitly known temporary checkout prefixes are portable. */
  temporaryRoots?: readonly string[]
}

export interface DiscoveryReloadState {
  state: "ready" | "reload-failed"
  stale: boolean
}

export interface DiscoveryIndex {
  readonly snapshotId: string
  readonly contract: Readonly<PrimitivContract>
  readonly ids: readonly string[]
  readonly byKind: Readonly<Record<string, readonly string[]>>
  readonly byLevel: Readonly<Record<string, readonly string[]>>
  readonly byIntent: Readonly<Record<string, readonly string[]>>
  readonly usedBy: Readonly<Record<string, Readonly<Record<string, number>>>>
}

export interface ComponentQuery {
  level?: AtomicLevel
  intents?: ComponentIntent[]
  intentMatch?: "any" | "all"
  kind?: ComponentKind
  /** Current working file or directory; uses the existing path segment containment rule. */
  scope?: string
  unclassified?: "missing-level" | "missing-intents" | "either"
  limit?: number
  cursor?: string
}

export type ComponentContextSection = "api" | "guidance" | "relationships" | "source"
export interface ComponentContextRequest {
  id: string
  snapshotId: string
  sections?: ComponentContextSection[]
  cursor?: string
}

export interface ClassificationCoverage {
  total: number
  withLevel: number
  withIntents: number
  complete: number
  missingLevel: number
  missingIntents: number
  missingEither: number
}

export interface DiscoveryMeta {
  snapshotId: string
  reload: DiscoveryReloadState
}

export interface ComponentCatalog extends DiscoveryMeta {
  total: number
  counts: { kind: Record<string, number>; level: Record<string, number>; intent: Record<string, number> }
  coverage: ClassificationCoverage
  supported: {
    levels: readonly AtomicLevel[]
    intents: readonly ComponentIntent[]
    kinds: readonly ComponentKind[]
    intentMatch: readonly ["any", "all"]
    unclassified: readonly ["missing-level", "missing-intents", "either"]
    order: "id"
    defaultLimit: number
    maxLimit: number
  }
  health: {
    sources: Record<string, { status: string }>
    guidance: { state: "known" | "unknown"; total?: number; truncated?: boolean; complete?: boolean }
  }
}

export interface ComponentPreview {
  id: string
  name: string
  kind: ComponentKind | "unknown"
  classification?: Component["classification"]
  description?: { text: string; origin: "authored" | "source"; complete: boolean }
  usage?: { text: string; complete: boolean }
  preview: true
}

export interface ComponentShortlist extends DiscoveryMeta {
  items: ComponentPreview[]
  total: number
  returned: number
  coverage: ClassificationCoverage
  matchingCoverage: ClassificationCoverage
  excluded: number
  order: "id"
  hasMore: boolean
  nextCursor?: string
}

export interface ComponentContext extends DiscoveryMeta {
  id: string
  name: string
  kind: ComponentKind | "unknown"
  classification?: Component["classification"]
  complete: boolean
  sections?: Partial<Record<ComponentContextSection, unknown>>
  /** Concatenate text for this section in cursor order, then JSON.parse its complete value. */
  continuation?: {
    section: ComponentContextSection
    format: "json-fragment"
    encoding: "json"
    assembly: "concatenate-then-json-parse"
    sectionComplete: boolean
    text: string
    offset: number
    totalCharacters: number
    unit: "utf16"
  }
  nextCursor?: string
}

export interface DiscoveryError extends DiscoveryMeta {
  error: {
    code: "invalid-query" | "invalid-cursor" | "snapshot-changed" | "not-found" | "record-too-large"
    message: string
  }
}

/** Serialize this object directly as the MCP tool result; both payload copies count toward the budget. */
export interface DiscoveryEnvelope<T> {
  content: Array<{ type: "text"; text: string }>
  structuredContent: T | DiscoveryError
  isError?: true
}
