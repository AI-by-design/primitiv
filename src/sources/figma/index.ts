import type { ComponentMap, FigmaSource, Source, SourceProvenance, TokenCategory, TokenMap } from "../../types"
import { emptyTokenMap } from "../../types"

type FigmaRawValue =
  | number
  | string
  | { type: "VARIABLE_ALIAS"; id: string }
  | { r: number; g: number; b: number; a: number }

interface FigmaVariable {
  id: string
  name: string
  key?: string
  remote?: boolean
  resolvedType: string
  variableCollectionId: string
  valuesByMode?: Record<string, FigmaRawValue>
  hiddenFromPublishing?: boolean
}

interface FigmaVariableCollection {
  name?: string
  defaultModeId?: string
  modes?: Array<{ modeId?: string; name?: string }>
}

interface FigmaComponentMeta {
  name?: string
  node_id?: string
  key?: string
}

interface FigmaVariablesResponse {
  meta?: {
    variables?: Record<string, FigmaVariable>
    variableCollections?: Record<string, FigmaVariableCollection>
  }
}

interface FigmaComponentsResponse {
  meta?: {
    components?: FigmaComponentMeta[]
  }
}

export class FigmaAdapter implements Source {
  private baseUrl = "https://api.figma.com/v1"
  // Per-request, rather than per scan: variables and components are independent Figma
  // endpoints and either one may stall. Keep this internal until a demonstrated project
  // need calls for a configurable policy.
  private requestTimeoutMs = 30_000

  constructor(private config: FigmaSource) {}

  async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }> {
    const [tokens, components] = await Promise.all([this.extractTokens(), this.extractComponents()])
    return { tokens, components }
  }

  private async fetchFigma<T>(endpoint: string): Promise<T> {
    const signal = AbortSignal.timeout(this.requestTimeoutMs)
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${endpoint}`, {
        headers: { "X-Figma-Token": this.config.token },
        signal
      })
    } catch (err) {
      if (signal.aborted) {
        // This error is persisted in sourceStatuses, so keep it actionable but never
        // include the endpoint, response body, or authentication details.
        throw new Error(
          `Figma API request timed out after ${this.requestTimeoutMs}ms. Check your network connection and try again.`
        )
      }
      throw err
    }
    if (!res.ok) {
      // Status code + statusText only — never the response body. This message ends up in
      // the persisted contract's sourceStatuses, which gets committed and fed to LLMs.
      throw new Error(
        `Figma API error (${res.status}): ${res.statusText}. Check your token and fileId in primitiv.config.js.`
      )
    }
    return (await res.json()) as T
  }

  private async extractTokens(): Promise<TokenMap> {
    const tokens: TokenMap = emptyTokenMap()

    const data = await this.fetchFigma<FigmaVariablesResponse>(`/files/${this.config.fileId}/variables/local`)
    const variables = data.meta?.variables || {}
    const collections = data.meta?.variableCollections || {}

    for (const variable of Object.values(variables)) {
      if (variable.remote) continue

      const collection = collections[variable.variableCollectionId]
      const defaultModeId = collection?.defaultModeId
      if (!defaultModeId) continue

      const rawValue = variable.valuesByMode?.[defaultModeId]
      if (rawValue === undefined || rawValue === null) continue

      // Skip alias variables (references to other variables)
      if (typeof rawValue === "object" && "type" in rawValue && rawValue.type === "VARIABLE_ALIAS") continue

      const resolved = this.resolveValue(variable.resolvedType, rawValue)
      if (!resolved) continue

      const name = this.normalizeName(variable.name)
      const category = this.categorize(variable.resolvedType, name)
      if (!tokens[category]) tokens[category] = {}
      const source: SourceProvenance = {
        adapter: "figma",
        metadata: {
          // variableId is file-local and ephemeral; key is Figma's publish-stable
          // identity — it survives renames, so cross-scan matching must prefer it.
          variableId: variable.id,
          variableKey: variable.key,
          hiddenFromPublishing: variable.hiddenFromPublishing,
          collectionName: collection?.name
        }
      }
      const modes: Record<string, string> = {}
      const modeSources: Record<string, SourceProvenance> = {}
      const namedModes = new Map(
        (collection?.modes ?? [])
          .filter((mode): mode is { modeId: string; name: string } => Boolean(mode.modeId && mode.name))
          .map((mode) => [mode.modeId, mode.name])
      )

      for (const [modeId, modeRawValue] of Object.entries(variable.valuesByMode ?? {})) {
        if (modeId === defaultModeId) continue
        const rawModeName = namedModes.get(modeId)
        if (!rawModeName) continue
        // Normalization is lexical only: "Night" becomes "night", never "dark". Semantic
        // aliases are an explicit future configuration decision, not an adapter guess.
        const mode = this.normalizeModeName(rawModeName)
        if (!mode || mode in modes) continue
        if (typeof modeRawValue === "object" && "type" in modeRawValue && modeRawValue.type === "VARIABLE_ALIAS") {
          continue
        }
        const modeValue = this.resolveValue(variable.resolvedType, modeRawValue)
        if (!modeValue) continue
        modes[mode] = modeValue
        modeSources[mode] = {
          ...source,
          metadata: { ...source.metadata, modeId, modeName: rawModeName }
        }
      }

      tokens[category][name] = {
        name,
        value: resolved,
        source,
        ...(Object.keys(modes).length > 0 ? { modes, modeSources } : {})
      }
    }

    return tokens
  }

  private async extractComponents(): Promise<ComponentMap> {
    const components: ComponentMap = {}
    const data = await this.fetchFigma<FigmaComponentsResponse>(`/files/${this.config.fileId}/components`)
    const entries = data.meta?.components || []

    for (const comp of entries) {
      const name = comp.name
      if (!name) continue

      // Source-prefixed id: Figma components have no fs path, and the prefix guarantees the
      // id can never collide with a codebase path id. Name lookups go through displayName.
      components[`figma:${name}`] = {
        name,
        displayName: name,
        source: {
          adapter: "figma",
          metadata: {
            nodeId: comp.node_id,
            componentKey: comp.key
          }
        },
        props: {}
      }
    }

    return components
  }

  private resolveValue(type: string, raw: FigmaRawValue): string | null {
    if (type === "COLOR" && typeof raw === "object" && "r" in raw) {
      return this.rgbaToHex(raw.r, raw.g, raw.b, raw.a)
    }
    if (type === "FLOAT" && typeof raw === "number") {
      // Figma FLOAT has no CSS-unit semantics. Adding `px` turns valid opacity,
      // weight, z-index, line-height, and motion values into a different value.
      // Preserve the raw number until a user-declared unit mapping exists.
      return String(raw)
    }
    if (type === "STRING" && typeof raw === "string") {
      return raw
    }
    return null
  }

  private rgbaToHex(r: number, g: number, b: number, a: number): string {
    const toHex = (v: number) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, "0")
    const hex = `#${toHex(r)}${toHex(g)}${toHex(b)}`
    return a < 1 ? `${hex}${toHex(a)}` : hex
  }

  private normalizeName(figmaName: string): string {
    // Figma uses "/" separators (e.g., "colors/primary/500") → kebab-case
    return figmaName.replace(/\//g, "-").replace(/\s+/g, "-").toLowerCase()
  }

  private normalizeModeName(figmaModeName: string): string {
    return figmaModeName.trim().replace(/\s+/g, "-").toLowerCase()
  }

  private categorize(resolvedType: string, name: string): TokenCategory {
    if (resolvedType === "COLOR") return "colors"
    if (resolvedType === "STRING") return "typography"
    // FLOAT — categorize by name
    if (name.includes("radius") || name.includes("rounded")) return "borderRadius"
    if (name.includes("shadow")) return "shadows"
    if (name.includes("font") || name.includes("line-height") || name.includes("letter")) return "typography"
    if (name.includes("spacing") || name.includes("margin") || name.includes("padding") || name.includes("gap"))
      return "spacing"
    return "spacing" // default for numeric values
  }
}
