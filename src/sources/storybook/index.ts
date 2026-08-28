import * as path from "node:path"
import type { ComponentMap, DemonstratedStory, PropDefinition, Source, StorybookSource, TokenMap } from "../../types"
import { emptyTokenMap } from "../../types"
import { matchParsedStory, type ParsedStorybookSource, parseStorybookSource } from "./csf"
import { boundDemonstratedEvidence } from "./demonstratedBudget"
import { MAX_MANIFEST_BYTES, MAX_METADATA_STRING_BYTES, MAX_STORIES_PER_COMPONENT } from "./limits"
import { readStoryFile, resolveStoryFile, SUPPORTED_STORY_FILE_EXTENSIONS } from "./resolveStoryFile"

interface StorybookManifest {
  entries?: Record<string, unknown>
  stories?: Record<string, unknown>
}

interface ManifestStory extends DemonstratedStory {
  title: string
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
    const parsedFiles = new Map<string, ParsedStorybookSource | null>()
    for (const title of [...grouped.keys()].sort(compareStrings)) {
      const eligibleStories = deduplicateStories(grouped.get(title) ?? [])
      const retainedStories = eligibleStories.slice(0, MAX_STORIES_PER_COMPONENT)
      const name = title.split("/").pop()?.trim() || title
      if (!name) continue

      const importPath = sharedImportPath(retainedStories)
      const demonstratedStories = retainedStories.map((story) => this.demonstratedStory(story, parsedFiles))
      // Component-wide meta evidence is only safe when every eligible manifest
      // story for the title points at one source file. The retained-story cap
      // bounds output, but must not hide a second file from this ambiguity
      // check. `source.file` below intentionally remains based on retained
      // stories, as required for bounded provenance output.
      const sharedSource = this.sharedParsedSource(eligibleStories, parsedFiles)
      const sourceAnalyzed = retainedStories.some(
        (story) => story.importPath !== undefined && this.parseSourceFile(story.importPath, parsedFiles) !== undefined
      )
      const demonstrated = boundDemonstratedEvidence({
        title,
        extraction: sourceAnalyzed ? "source" : "manifest-only",
        storyCount: eligibleStories.length,
        ...(sharedSource?.values ? { defaultArgs: sharedSource.values } : {}),
        ...(sharedSource?.unresolvedKeys ? { unresolvedDefaultArgs: sharedSource.unresolvedKeys } : {}),
        ...(sharedSource?.truncatedKeys ? { truncatedDefaultArgs: sharedSource.truncatedKeys } : {}),
        ...(sharedSource?.hasUnresolvedSpread ? { hasUnresolvedDefaultArgsSpread: true } : {}),
        ...(sharedSource?.controls ? { controls: sharedSource.controls } : {}),
        stories: demonstratedStories,
        ...(eligibleStories.length > retainedStories.length ? { truncatedStories: true } : {})
      })
      const storyIds = demonstrated.stories?.map((story) => story.id) ?? []

      components[`storybook:${title}`] = {
        name,
        displayName: name,
        source: {
          adapter: "storybook",
          ...(importPath !== undefined ? { file: importPath } : {}),
          metadata: { storyIds, title }
        },
        props: sharedSource?.props ?? emptyPropMap(),
        demonstrated
      }
    }

    return components
  }

  private parseSourceFile(
    importPath: string | undefined,
    cache: Map<string, ParsedStorybookSource | null>
  ): ParsedStorybookSource | undefined {
    if (!this.config.sourceRoot || !importPath) return undefined
    const resolved = resolveStoryFile(this.config.sourceRoot, importPath)
    if (!resolved.ok) return undefined
    const cached = cache.get(resolved.path)
    if (cached !== undefined) return cached ?? undefined
    const read = readStoryFile(this.config.sourceRoot, importPath)
    if (!read.ok) {
      cache.set(resolved.path, null)
      return undefined
    }

    try {
      const parsed = parseStorybookSource(read.source)
      cache.set(read.path, parsed)
      if (read.path !== resolved.path) cache.set(resolved.path, parsed)
      return parsed
    } catch {
      cache.set(read.path, null)
      if (read.path !== resolved.path) cache.set(resolved.path, null)
      return undefined
    }
  }

  private sharedParsedSource(
    stories: ManifestStory[],
    cache: Map<string, ParsedStorybookSource | null>
  ): ParsedStorybookSource | undefined {
    if (!this.config.sourceRoot || stories.length === 0) return undefined
    const canonicalPaths = new Set<string>()
    for (const story of stories) {
      if (!story.importPath) return undefined
      const resolved = resolveStoryFile(this.config.sourceRoot, story.importPath)
      if (!resolved.ok) return undefined
      canonicalPaths.add(resolved.path)
    }
    if (canonicalPaths.size !== 1) return undefined
    return cache.get([...canonicalPaths][0]) ?? undefined
  }

  private demonstratedStory(
    manifest: ManifestStory,
    cache: Map<string, ParsedStorybookSource | null>
  ): DemonstratedStory {
    const source = this.parseSourceFile(manifest.importPath, cache)
    const parsed = source ? matchParsedStory(source, manifest.title, manifest.id) : undefined
    return {
      id: manifest.id,
      ...((manifest.name ?? parsed?.name) ? { name: manifest.name ?? parsed?.name } : {}),
      ...(parsed ? { exportName: parsed.exportName } : {}),
      ...(manifest.importPath !== undefined ? { importPath: manifest.importPath } : {}),
      ...(parsed?.values ? { args: parsed.values } : {}),
      ...(parsed?.unresolvedKeys ? { unresolvedArgs: parsed.unresolvedKeys } : {}),
      ...(parsed?.truncatedKeys ? { truncatedArgs: parsed.truncatedKeys } : {}),
      ...(parsed?.hasUnresolvedSpread ? { hasUnresolvedArgsSpread: true } : {}),
      ...(parsed?.controls ? { controls: parsed.controls } : {})
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
