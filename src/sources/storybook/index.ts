import * as path from "node:path"
import type { ComponentMap, DemonstratedStory, PropDefinition, Source, StorybookSource, TokenMap } from "../../types"
import { emptyTokenMap } from "../../types"
import { parseArgTypes } from "./argTypes"
import { MAX_MANIFEST_BYTES, MAX_METADATA_STRING_BYTES, MAX_STORIES_PER_COMPONENT } from "./limits"
import { readStoryFile, SUPPORTED_STORY_FILE_EXTENSIONS } from "./resolveStoryFile"

interface StorybookManifest {
  entries?: Record<string, unknown>
  stories?: Record<string, unknown>
}

interface ManifestStory extends DemonstratedStory {
  title: string
}

interface SourceEvidence {
  props: Record<string, PropDefinition>
  extracted: boolean
}

export class StorybookAdapter implements Source {
  private requestTimeoutMs = 30_000

  constructor(private config: StorybookSource) {}

  async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }> {
    const components = await this.extractComponents()
    return {
      tokens: emptyTokenMap(),
      components
    }
  }

  private async extractComponents(): Promise<ComponentMap> {
    const manifest = await this.fetchManifest()
    const entries = manifest.entries ?? manifest.stories ?? Object.create(null)
    const grouped = new Map<string, ManifestStory[]>()

    // Sort the envelope keys before validation so conflicting duplicate story ids
    // resolve canonically rather than according to remote JSON insertion order.
    for (const entryKey of Object.keys(entries).sort(compareStrings)) {
      const story = parseManifestStory(entries[entryKey])
      if (!story) continue
      const stories = grouped.get(story.title)
      if (stories) stories.push(story)
      else grouped.set(story.title, [story])
    }

    const components = Object.create(null) as ComponentMap
    for (const title of [...grouped.keys()].sort(compareStrings)) {
      const eligibleStories = deduplicateStories(grouped.get(title) ?? [])
      const retainedStories = eligibleStories.slice(0, MAX_STORIES_PER_COMPONENT)
      const name = title.split("/").pop()?.trim() || title
      if (!name) continue

      const importPath = sharedImportPath(retainedStories)
      const sourceEvidence = this.extractProps(importPath)
      const storyIds = retainedStories.map((story) => story.id)

      components[`storybook:${title}`] = {
        name,
        displayName: name,
        source: {
          adapter: "storybook",
          ...(importPath !== undefined ? { file: importPath } : {}),
          metadata: { storyIds, title }
        },
        props: sourceEvidence.props,
        demonstrated: {
          title,
          extraction: sourceEvidence.extracted ? "source" : "manifest-only",
          storyCount: eligibleStories.length,
          stories: retainedStories.map(({ id, name: storyName, importPath: storyPath }) => ({
            id,
            ...(storyName !== undefined ? { name: storyName } : {}),
            ...(storyPath !== undefined ? { importPath: storyPath } : {})
          })),
          ...(eligibleStories.length > retainedStories.length ? { truncatedStories: true } : {})
        }
      }
    }

    return components
  }

  private extractProps(importPath: string | undefined): SourceEvidence {
    // Prop extraction requires one unambiguous relative story path and a configured
    // filesystem root. Manifest identity remains useful without either.
    if (!this.config.sourceRoot || !importPath) return { props: emptyPropMap(), extracted: false }
    const read = readStoryFile(this.config.sourceRoot, importPath)
    if (!read.ok) return { props: emptyPropMap(), extracted: false }

    try {
      return { props: parseArgTypes(read.source), extracted: true }
    } catch {
      return { props: emptyPropMap(), extracted: false }
    }
  }

  private async fetchManifest(): Promise<StorybookManifest> {
    const base = this.config.url.replace(/\/$/, "")
    const endpoints = ["/index.json", "/stories.json"]

    for (const endpoint of endpoints) {
      const signal = AbortSignal.timeout(this.requestTimeoutMs)
      try {
        const response = await fetch(`${base}${endpoint}`, { signal })
        if (!response.ok) continue
        const parsed = await readBoundedJson(response)
        const manifest = parseManifest(parsed)
        if (manifest) return manifest
      } catch {
        // Try the legacy manifest endpoint independently. The final error is deliberately
        // sanitised because it is persisted in sourceStatuses.
      }
    }

    throw new Error(
      `Could not reach Storybook within ${this.requestTimeoutMs}ms. ` +
        `Make sure Storybook is running (npx storybook dev) and the URL is correct in primitiv.config.js.`
    )
  }
}

function parseManifest(value: unknown): StorybookManifest | undefined {
  if (!isRecord(value)) return undefined
  const entries = isRecord(value.entries) ? value.entries : undefined
  const stories = isRecord(value.stories) ? value.stories : undefined
  if (!entries && !stories) return undefined
  return { entries, stories }
}

function parseManifestStory(value: unknown): ManifestStory | undefined {
  if (!isRecord(value)) return undefined
  if (value.type !== undefined && typeof value.type !== "string") return undefined
  if (value.type === "docs") return undefined

  const title = boundedString(value.title, true)
  const id = boundedString(value.id, true)
  if (!title || !id) return undefined

  const name = boundedString(value.name, false)
  const importPath = safeImportPath(value.importPath)
  return {
    title,
    id,
    ...(name !== undefined ? { name } : {}),
    ...(importPath !== undefined ? { importPath } : {})
  }
}

function boundedString(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  if (Buffer.byteLength(value, "utf8") > MAX_METADATA_STRING_BYTES) return undefined
  return value
}

function safeImportPath(value: unknown): string | undefined {
  const importPath = boundedString(value, false)
  if (!importPath || importPath.includes("\0")) return undefined
  if (path.isAbsolute(importPath) || path.win32.isAbsolute(importPath)) return undefined
  if (importPath.split(/[\\/]/).some((segment) => segment === "..")) return undefined
  if (!SUPPORTED_STORY_FILE_EXTENSIONS.has(path.extname(importPath).toLowerCase())) return undefined
  return importPath
}

function deduplicateStories(stories: ManifestStory[]): ManifestStory[] {
  const sorted = [...stories].sort(compareStories)
  const seen = new Set<string>()
  const unique: ManifestStory[] = []
  for (const story of sorted) {
    if (seen.has(story.id)) continue
    seen.add(story.id)
    unique.push(story)
  }
  return unique
}

function compareStories(a: ManifestStory, b: ManifestStory): number {
  return (
    compareStrings(a.id, b.id) ||
    compareStrings(a.name ?? "", b.name ?? "") ||
    compareStrings(a.importPath ?? "", b.importPath ?? "")
  )
}

function sharedImportPath(stories: ManifestStory[]): string | undefined {
  if (stories.length === 0 || stories[0].importPath === undefined) return undefined
  const candidate = stories[0].importPath
  return stories.every((story) => story.importPath === candidate) ? candidate : undefined
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length")
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (Number.isFinite(parsedLength) && parsedLength > MAX_MANIFEST_BYTES) {
      throw new Error("Storybook manifest exceeds the byte limit")
    }
  }

  if (!response.body) throw new Error("Storybook manifest has no response body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let bytesRead = 0
  let json = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      if (bytesRead > MAX_MANIFEST_BYTES) {
        await reader.cancel()
        throw new Error("Storybook manifest exceeds the byte limit")
      }
      json += decoder.decode(value, { stream: true })
    }
    json += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(json)
}

function emptyPropMap(): Record<string, PropDefinition> {
  return Object.create(null) as Record<string, PropDefinition>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
