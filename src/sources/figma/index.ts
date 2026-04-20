import type { ComponentMap, FigmaSource, Source, TokenMap } from "../../types"

type FigmaRawValue =
  | number
  | string
  | { type: "VARIABLE_ALIAS"; id: string }
  | { r: number; g: number; b: number; a: number }

interface FigmaVariable {
  id: string
  name: string
  remote?: boolean
  resolvedType: string
  variableCollectionId: string
  valuesByMode?: Record<string, FigmaRawValue>
}

interface FigmaVariableCollection {
  name?: string
  defaultModeId?: string
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

  constructor(private config: FigmaSource) {}

  async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }> {
    const [tokens, components] = await Promise.all([this.extractTokens(), this.extractComponents()])
    return { tokens, components }
  }

  private async fetchFigma<T>(endpoint: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${endpoint}`, {
      headers: { "X-Figma-Token": this.config.token }
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(
        `Figma API error (${res.status}): ${res.statusText}${body ? ` — ${body}` : ""}. ` +
          `Check your token and fileId in primitiv.config.js.`
      )
    }
    return (await res.json()) as T
  }

  private async extractTokens(): Promise<TokenMap> {
    const tokens: TokenMap = {
      colors: {},
      spacing: {},
      typography: {},
      borderRadius: {},
      shadows: {}
    }

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

      tokens[category][name] = {
        name,
        value: resolved,
        source: {
          adapter: "figma",
          metadata: {
            variableId: variable.id,
            collectionName: collection?.name
          }
        }
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

      components[name] = {
        name,
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
      return `${raw}px`
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

  private categorize(resolvedType: string, name: string): string {
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
