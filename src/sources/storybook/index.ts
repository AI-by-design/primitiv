import { Source, StorybookSource, TokenMap, ComponentMap } from "../../types"

export class StorybookAdapter implements Source {
  constructor(private config: StorybookSource) {}

  async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }> {
    const components = await this.extractComponents()
    return {
      tokens: { colors: {}, spacing: {}, typography: {}, borderRadius: {}, shadows: {} },
      components
    }
  }

  private async extractComponents(): Promise<ComponentMap> {
    const manifest = await this.fetchManifest()
    const entries = manifest.entries || manifest.stories || {}
    const components: ComponentMap = {}

    // Group stories by component title
    const grouped: Record<string, { variants: string[]; storyIds: string[]; importPath?: string }> = {}

    for (const entry of Object.values(entries) as any[]) {
      // Skip docs-only entries
      if (entry.type === "docs") continue

      const title: string = entry.title || ""
      const storyName: string = entry.name || ""
      const importPath: string = entry.importPath || ""

      if (!title) continue

      if (!grouped[title]) {
        grouped[title] = { variants: [], storyIds: [], importPath }
      }
      if (storyName) grouped[title].variants.push(storyName)
      if (entry.id) grouped[title].storyIds.push(entry.id)
      if (!grouped[title].importPath && importPath) {
        grouped[title].importPath = importPath
      }
    }

    for (const [title, data] of Object.entries(grouped)) {
      // Component name is the last segment of the title path
      const name = title.split("/").pop()?.trim() || title
      if (!name) continue

      components[name] = {
        name,
        source: {
          adapter: "storybook",
          file: data.importPath,
          metadata: { storyIds: data.storyIds, title }
        },
        variants: data.variants,
        props: {}
      }
    }

    return components
  }

  private async fetchManifest(): Promise<any> {
    const base = this.config.url.replace(/\/$/, "")
    const endpoints = ["/index.json", "/stories.json"]

    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${base}${endpoint}`)
        if (res.ok) return res.json()
      } catch {
        continue
      }
    }

    throw new Error(
      `Could not reach Storybook at ${this.config.url}. ` +
      `Make sure Storybook is running (npx storybook dev) and the URL is correct in primitiv.config.js.`
    )
  }
}
