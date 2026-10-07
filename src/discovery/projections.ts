import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { z } from "zod"
import { atomicLevelSchema, componentIntentSchema } from "../rationale/schema"
import type { Component, ComponentKind } from "../types"
import { classificationCoverage, matchesScope, pathSegments } from "./navigation"
import type {
  ComponentCatalog,
  ComponentContext,
  ComponentContextRequest,
  ComponentContextSection,
  ComponentPreview,
  ComponentQuery,
  ComponentShortlist,
  DiscoveryEnvelope,
  DiscoveryError,
  DiscoveryIndex,
  DiscoveryReloadState
} from "./types"

export const DISCOVERY_LIMITS = {
  defaultLimit: 20,
  maxLimit: 50,
  shortlistBytes: 64 * 1024,
  detailBytes: 128 * 1024,
  previewCharacters: 512,
  cursorBytes: 4096
} as const

const KINDS: ComponentKind[] = ["component", "screen", "provider", "icon", "other"]
const SECTIONS: ComponentContextSection[] = ["api", "guidance", "relationships", "source"]
const cursorSchema = z.string().max(DISCOVERY_LIMITS.cursorBytes)
const querySchema = z.strictObject({
  level: atomicLevelSchema.optional(),
  intents: z.array(componentIntentSchema).max(32).optional(),
  intentMatch: z.enum(["any", "all"]).optional(),
  kind: z.enum(KINDS).optional(),
  scope: z.string().min(1).max(2048).optional(),
  unclassified: z.enum(["missing-level", "missing-intents", "either"]).optional(),
  limit: z.number().int().min(1).max(DISCOVERY_LIMITS.maxLimit).optional(),
  cursor: cursorSchema.optional()
})
const contextSchema = z.strictObject({
  id: z.string().min(1).max(65536),
  snapshotId: z.string().min(1).max(128),
  sections: z.array(z.enum(SECTIONS)).min(1).max(4).optional(),
  cursor: cursorSchema.optional()
})
const cursorPayloadSchema = z.strictObject({
  version: z.literal(1),
  snapshotId: z.string().max(128),
  query: z.string().length(64),
  position: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  checksum: z.string().length(64)
})
type Cursor = z.infer<typeof cursorPayloadSchema>
const READY: DiscoveryReloadState = { state: "ready", stale: false }

export function discoveryEnvelopeBytes(envelope: DiscoveryEnvelope<unknown>): number {
  return Buffer.byteLength(JSON.stringify(envelope), "utf8")
}

export function getComponentCatalog(
  index: DiscoveryIndex,
  reload: DiscoveryReloadState = READY
): DiscoveryEnvelope<ComponentCatalog> {
  const health = index.contract.guidanceHealth
  const payload: ComponentCatalog = {
    ...meta(index, reload),
    total: index.ids.length,
    counts: {
      kind: counts(index.byKind, [...KINDS, "unknown"]),
      level: counts(index.byLevel, atomicLevelSchema.options),
      intent: counts(index.byIntent, componentIntentSchema.options)
    },
    coverage: classificationCoverage(index, index.ids),
    supported: {
      levels: atomicLevelSchema.options,
      intents: componentIntentSchema.options,
      kinds: KINDS,
      intentMatch: ["any", "all"],
      unclassified: ["missing-level", "missing-intents", "either"],
      order: "id",
      defaultLimit: DISCOVERY_LIMITS.defaultLimit,
      maxLimit: DISCOVERY_LIMITS.maxLimit
    },
    health: {
      sources: Object.fromEntries(
        ["codebase", "figma", "storybook"].map((source) => [
          source,
          { status: index.contract.sourceStatuses?.[source]?.status ?? "unknown" }
        ])
      ),
      guidance: health
        ? {
            state: "known",
            total: health.total,
            truncated: health.truncated,
            complete:
              health.sources.length > 0 && !health.truncated && health.sources.every((source) => source.complete)
          }
        : { state: "unknown" }
    }
  }
  return bounded(index, reload, payload, DISCOVERY_LIMITS.shortlistBytes)
}

export function findComponents(
  index: DiscoveryIndex,
  query: ComponentQuery = {},
  reload: DiscoveryReloadState = READY
): DiscoveryEnvelope<ComponentShortlist> {
  const parsed = querySchema.safeParse(query)
  if (!parsed.success) return error(index, reload, "invalid-query")
  const { cursor, ...input } = parsed.data
  const normalized = {
    level: input.level,
    intents: [...new Set(input.intents ?? [])].sort(),
    intentMatch: input.intentMatch ?? "any",
    kind: input.kind,
    scope: input.scope === undefined ? undefined : pathSegments(input.scope).join("/"),
    unclassified: input.unclassified,
    limit: input.limit ?? DISCOVERY_LIMITS.defaultLimit,
    order: "id"
  }
  if (normalized.scope === "") return error(index, reload, "invalid-query")
  const queryId = digest(JSON.stringify(normalized))
  const position = readCursor<ComponentShortlist>(index, reload, cursor, queryId)
  if ("content" in position) return position
  if (position.offset !== 0) return error(index, reload, "invalid-cursor")

  // Intersect ID indexes before projecting records; no graph or conflict analysis is performed here.
  const indexed = [
    normalized.kind === undefined ? undefined : (index.byKind[normalized.kind] ?? []),
    normalized.level === undefined ? undefined : (index.byLevel[normalized.level] ?? [])
  ].filter((ids): ids is readonly string[] => ids !== undefined)
  if (normalized.intents.length > 0) {
    const groups = normalized.intents.map((intent) => index.byIntent[intent] ?? [])
    if (normalized.intentMatch === "all") indexed.push(...groups)
    else indexed.push([...new Set(groups.flat())].sort())
  }
  indexed.sort((a, b) => a.length - b.length)
  const [seed = index.ids, ...others] = indexed
  const sets = others.map((ids) => new Set(ids))
  const ids = seed.filter((id) => {
    if (!sets.every((set) => set.has(id))) return false
    const component = index.contract.components[id]
    if (normalized.scope !== undefined && !matchesScope(id, component, normalized.scope)) return false
    const missingLevel = component.classification?.atomicLevel === undefined
    const missingIntents = (component.classification?.intents?.length ?? 0) === 0
    if (normalized.unclassified === "missing-level") return missingLevel
    if (normalized.unclassified === "missing-intents") return missingIntents
    if (normalized.unclassified === "either") return missingLevel || missingIntents
    return true
  })
  if (position.position > ids.length || (cursor !== undefined && position.position >= ids.length)) {
    return error(index, reload, "invalid-cursor")
  }
  const items = ids.slice(position.position, position.position + normalized.limit).map((id) => preview(index, id))
  const base = {
    ...meta(index, reload),
    total: ids.length,
    coverage: classificationCoverage(index, index.ids),
    matchingCoverage: classificationCoverage(index, ids),
    excluded: index.ids.length - ids.length,
    order: "id" as const
  }
  while (true) {
    const nextPosition = position.position + items.length
    const hasMore = nextPosition < ids.length
    const result = envelope({
      ...base,
      items,
      returned: items.length,
      hasMore,
      ...(hasMore ? { nextCursor: writeCursor(index, queryId, nextPosition, 0) } : {})
    })
    if (discoveryEnvelopeBytes(result) <= DISCOVERY_LIMITS.shortlistBytes) return result
    if (items.length <= 1) return error(index, reload, "record-too-large")
    items.pop()
  }
}

export function getComponentContext(
  index: DiscoveryIndex,
  request: ComponentContextRequest,
  reload: DiscoveryReloadState = READY
): DiscoveryEnvelope<ComponentContext> {
  const parsed = contextSchema.safeParse(request)
  if (!parsed.success) return error(index, reload, "invalid-query")
  const { id, snapshotId, cursor } = parsed.data
  if (snapshotId !== index.snapshotId) return error(index, reload, "snapshot-changed")
  if (!Object.getOwnPropertyDescriptor(index.contract.components, id)) return error(index, reload, "not-found")
  const sections = SECTIONS.filter((section) => (parsed.data.sections ?? SECTIONS).includes(section))
  const queryId = digest(JSON.stringify({ id, sections, order: "section" }))
  const position = readCursor<ComponentContext>(index, reload, cursor, queryId)
  if ("content" in position) return position
  if (position.position >= sections.length) return error(index, reload, "invalid-cursor")
  const component = index.contract.components[id]
  const base: Omit<ComponentContext, "complete"> = {
    ...meta(index, reload),
    id,
    name: component.displayName ?? component.name,
    kind: component.kind ?? "unknown",
    ...(component.classification === undefined ? {} : { classification: component.classification })
  }
  const values: Partial<Record<ComponentContextSection, unknown>> = {}
  for (let part = position.position; part < sections.length; part++) {
    const section = sections[part]
    const value = projectSection(index, id, section)
    if (part === position.position && position.offset > 0) {
      return fragment(index, reload, base, section, value, queryId, part, position.offset, sections.length)
    }
    const complete = part + 1 === sections.length
    const candidate = envelope({
      ...base,
      complete,
      sections: { ...values, [section]: value },
      ...(complete ? {} : { nextCursor: writeCursor(index, queryId, part + 1, 0) })
    })
    if (discoveryEnvelopeBytes(candidate) > DISCOVERY_LIMITS.detailBytes) {
      if (Object.keys(values).length > 0) {
        return bounded(
          index,
          reload,
          { ...base, complete: false, sections: values, nextCursor: writeCursor(index, queryId, part, 0) },
          DISCOVERY_LIMITS.detailBytes
        )
      }
      return fragment(index, reload, base, section, value, queryId, part, 0, sections.length)
    }
    values[section] = value
  }
  return bounded(index, reload, { ...base, complete: true, sections: values }, DISCOVERY_LIMITS.detailBytes)
}

function fragment(
  index: DiscoveryIndex,
  reload: DiscoveryReloadState,
  base: Omit<ComponentContext, "complete">,
  section: ComponentContextSection,
  value: unknown,
  queryId: string,
  part: number,
  offset: number,
  sectionCount: number
): DiscoveryEnvelope<ComponentContext> {
  const serialized = JSON.stringify(value)
  if (offset >= serialized.length || splitsSurrogate(serialized, offset)) return error(index, reload, "invalid-cursor")
  const make = (end: number) => {
    const sectionComplete = end === serialized.length
    const complete = sectionComplete && part + 1 === sectionCount
    return envelope({
      ...base,
      complete,
      continuation: {
        section,
        format: "json-fragment" as const,
        encoding: "json" as const,
        assembly: "concatenate-then-json-parse" as const,
        sectionComplete,
        text: serialized.slice(offset, end),
        offset,
        totalCharacters: serialized.length,
        unit: "utf16" as const
      },
      ...(complete
        ? {}
        : { nextCursor: writeCursor(index, queryId, sectionComplete ? part + 1 : part, sectionComplete ? 0 : end) })
    })
  }
  const whole = make(serialized.length)
  if (discoveryEnvelopeBytes(whole) <= DISCOVERY_LIMITS.detailBytes) return whole
  let low = offset
  let high = serialized.length - 1
  while (low < high) {
    const middle = low + Math.ceil((high - low) / 2)
    if (discoveryEnvelopeBytes(make(middle)) <= DISCOVERY_LIMITS.detailBytes) low = middle
    else high = middle - 1
  }
  if (splitsSurrogate(serialized, low)) low--
  if (low <= offset) return error(index, reload, "record-too-large")
  return make(low)
}

function projectSection(index: DiscoveryIndex, id: string, section: ComponentContextSection): unknown {
  const component = index.contract.components[id]
  switch (section) {
    case "api":
      return {
        declared: { props: component.props ?? {} },
        observed: component.usage ?? null,
        demonstrated: component.demonstrated ?? null,
        evidence: "static-source; observed and demonstrated values do not define a complete API"
      }
    case "guidance":
      return {
        rationale: component.rationale ?? null,
        description: effectiveDescription(component),
        origin: component.guidanceOrigin ?? null,
        pairings: "advisory"
      }
    case "relationships":
      return {
        uses: component.uses ?? {},
        usedBy: index.usedBy[id] ?? {},
        evidence: "static-jsx-sites",
        completeness: "unknown; missing edges do not establish absence or required dependencies"
      }
    case "source":
      return component.source
  }
}

function preview(index: DiscoveryIndex, id: string): ComponentPreview {
  const component = index.contract.components[id]
  const description = effectiveDescription(component)
  return {
    id,
    name: component.displayName ?? component.name,
    kind: component.kind ?? "unknown",
    ...(component.classification === undefined ? {} : { classification: component.classification }),
    ...(description === null ? {} : { description: { ...excerpt(description.text), origin: description.origin } }),
    ...(component.rationale?.when === undefined ? {} : { usage: excerpt(component.rationale.when) }),
    preview: true
  }
}

function effectiveDescription(component: Component): { text: string; origin: "authored" | "source" } | null {
  if (component.rationale?.description !== undefined)
    return { text: component.rationale.description, origin: "authored" }
  return component.description === undefined ? null : { text: component.description, origin: "source" }
}

function excerpt(text: string): { text: string; complete: boolean } {
  let end = Math.min(text.length, DISCOVERY_LIMITS.previewCharacters)
  if (splitsSurrogate(text, end)) end--
  return { text: text.slice(0, end), complete: end === text.length }
}

function splitsSurrogate(text: string, offset: number): boolean {
  return offset > 0 && /[\uD800-\uDBFF]/.test(text[offset - 1]) && /[\uDC00-\uDFFF]/.test(text[offset] ?? "")
}

function counts(index: Readonly<Record<string, readonly string[]>>, values: readonly string[]): Record<string, number> {
  return Object.fromEntries(values.map((value) => [value, index[value]?.length ?? 0]))
}

function meta(index: DiscoveryIndex, reload: DiscoveryReloadState) {
  return { snapshotId: index.snapshotId, reload: { state: reload.state, stale: reload.stale } }
}

function envelope<T>(payload: T, isError?: true): DiscoveryEnvelope<T> {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
    ...(isError ? { isError } : {})
  }
}

function bounded<T>(
  index: DiscoveryIndex,
  reload: DiscoveryReloadState,
  payload: T,
  bytes: number
): DiscoveryEnvelope<T> {
  const result = envelope(payload)
  return discoveryEnvelopeBytes(result) <= bytes ? result : error(index, reload, "record-too-large")
}

function error<T>(
  index: DiscoveryIndex,
  reload: DiscoveryReloadState,
  code: DiscoveryError["error"]["code"]
): DiscoveryEnvelope<T> {
  const messages = {
    "invalid-query": "Unknown or invalid query fields. Use the catalog's supported filters and limits.",
    "invalid-cursor": "Invalid cursor or changed query. Restart discovery with the same normalized filters.",
    "snapshot-changed": "The loaded snapshot changed. Restart discovery and use its snapshot ID for detail.",
    "not-found": "No component has this exact ID in the selected snapshot.",
    "record-too-large": "A record cannot fit the response budget. Request exact-ID detail with fewer sections."
  }
  return envelope({ ...meta(index, reload), error: { code, message: messages[code] } }, true) as DiscoveryEnvelope<T>
}

function writeCursor(index: DiscoveryIndex, query: string, position: number, offset: number): string {
  const data = { version: 1 as const, snapshotId: index.snapshotId, query, position, offset }
  return Buffer.from(JSON.stringify({ ...data, checksum: digest(JSON.stringify(data)) })).toString("base64url")
}

function readCursor<T>(
  index: DiscoveryIndex,
  reload: DiscoveryReloadState,
  encoded: string | undefined,
  query: string
): Pick<Cursor, "position" | "offset"> | DiscoveryEnvelope<T> {
  if (encoded === undefined) return { position: 0, offset: 0 }
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return error(index, reload, "invalid-cursor")
    const parsed = cursorPayloadSchema.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")))
    if (!parsed.success) return error(index, reload, "invalid-cursor")
    const { checksum, ...data } = parsed.data
    if (digest(JSON.stringify(data)) !== checksum) return error(index, reload, "invalid-cursor")
    if (data.snapshotId !== index.snapshotId) return error(index, reload, "snapshot-changed")
    if (data.query !== query) return error(index, reload, "invalid-cursor")
    return { position: data.position, offset: data.offset }
  } catch {
    return error(index, reload, "invalid-cursor")
  }
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
