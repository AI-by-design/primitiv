import * as fs from "node:fs"
import * as path from "node:path"
import type { ComponentMap, PropDefinition, Source, StorybookSource, TokenMap } from "../../types"
import { parseArgTypes } from "./argTypes"

interface StorybookEntry {
  type?: string
  title?: string
  name?: string
  importPath?: string
  id?: string
}

interface StorybookManifest {
  entries?: Record<string, StorybookEntry>
  stories?: Record<string, StorybookEntry>
}

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

    for (const entry of Object.values(entries)) {
      // Skip docs-only entries
      if (entry.type === "docs") continue

      const title = entry.title || ""
      const storyName = entry.name || ""
      const importPath = entry.importPath || ""

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

      const props = this.extractProps(data.importPath)

      components[name] = {
        name,
        source: {
          adapter: "storybook",
          file: data.importPath,
          metadata: { storyIds: data.storyIds, title }
        },
        variants: data.variants,
        props
      }
    }

    return components
  }

  private extractProps(importPath: string | undefined): Record<string, PropDefinition> {
    // Prop extraction requires a filesystem root and a relative importPath from the Storybook manifest.
    if (!this.config.sourceRoot || !importPath) return {}
    const resolved = path.resolve(this.config.sourceRoot, importPath)
    if (!fs.existsSync(resolved)) return {}
    try {
      const source = fs.readFileSync(resolved, "utf-8")
      return parseArgTypes(source)
    } catch {
      return {}
    }
  }

  private async fetchManifest(): Promise<StorybookManifest> {
    const base = this.config.url.replace(/\/$/, "")
    const endpoints = ["/index.json", "/stories.json"]

    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${base}${endpoint}`)
        if (res.ok) return (await res.json()) as StorybookManifest
      } catch {}
    }

    throw new Error(
      `Could not reach Storybook at ${this.config.url}. ` +
        `Make sure Storybook is running (npx storybook dev) and the URL is correct in primitiv.config.js.`
    )
  }
}
