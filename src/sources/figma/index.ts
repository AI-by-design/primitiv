import { safeDisplayText } from "../../safe-display"
import type {
  Component,
  ComponentMap,
  FigmaSource,
  PropDefinition,
  Source,
  SourceProvenance,
  TokenCategory,
  TokenMap
} from "../../types"
import { emptyTokenMap } from "../../types"
import {
  FIGMA_MAX_DESCRIPTION_BYTES,
  FIGMA_MAX_METADATA_STRING_BYTES,
  FIGMA_MAX_PROPERTY_DEFINITIONS,
  FIGMA_MAX_PROPERTY_NAME_BYTES,
  FIGMA_MAX_PROPERTY_VALUE_STRING_BYTES,
  FIGMA_MAX_PROPERTY_VALUES,
  FIGMA_MAX_PUBLISHED_ASSETS,
  FIGMA_MAX_RESPONSE_BYTES,
  FIGMA_MAX_SCAN_RESPONSE_BYTES
} from "./limits"

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
  file_key?: string
  description?: string
  component_set_id?: string
  componentSetId?: string
  updated_at?: string
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
    component_sets?: FigmaComponentMeta[]
  }
}

interface FigmaPropertyDefinition {
  type?: string
  defaultValue?: unknown
  variantOptions?: unknown
  preferredValues?: unknown
}

interface FigmaNodeDocument {
  id?: string
  type?: string
  name?: string
  componentPropertyDefinitions?: Record<string, FigmaPropertyDefinition>
}

interface FigmaNodeMetadata {
  key?: string
  name?: string
  componentSetId?: string
  component_set_id?: string
}

interface FigmaNodeWrapper {
  document?: FigmaNodeDocument | null
  components?: Record<string, FigmaNodeMetadata>
  componentSets?: Record<string, FigmaNodeMetadata>
}

interface FigmaNodesResponse {
  name?: string
  version?: string
  lastModified?: string
  nodes?: Record<string, FigmaNodeWrapper | null>
}

interface PublishedAsset {
  key: string
  nodeId: string
  name: string
  kind: "component" | "component-set"
  description?: string
  updatedAt?: string
}

interface NodeEvidence {
  asset: PublishedAsset
  document: FigmaNodeDocument
  metadata?: FigmaNodeMetadata
  componentSetKey?: string
  componentSetNodeId?: string
  snapshot?: { fileName?: string; version?: string; lastModified?: string }
  targetedByNodeId?: Map<string, PublishedAsset>
}

interface PropertyLookupContext {
  byKey: Map<string, PublishedAsset>
  byNodeId: Map<string, PublishedAsset>
}

const FIGMA_NODE_BATCH_SIZE = 100

export class FigmaAdapter implements Source {
  private baseUrl = "https://api.figma.com/v1"
  // Per-request, rather than per scan: variables and components are independent Figma
  // endpoints and either one may stall. Keep this internal until a demonstrated project
  // need calls for a configurable policy.
  private requestTimeoutMs = 30_000
  private maxScanResponseBytes = FIGMA_MAX_SCAN_RESPONSE_BYTES
  private scanResponseBytes = 0

  constructor(private config: FigmaSource) {}

  async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }> {
    this.scanResponseBytes = 0
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
    } catch {
      if (signal.aborted) {
        // This error is persisted in sourceStatuses, so keep it actionable but never
        // include the endpoint, response body, or authentication details.
        throw new Error(
          `Figma API request timed out after ${this.requestTimeoutMs}ms. Check your network connection and try again.`
        )
      }
      throw new Error("Figma API request failed. Check your network connection and try again.")
    }
    if (!res.ok) {
      // Status code + statusText only — never the response body. This message ends up in
      // the persisted contract's sourceStatuses, which gets committed and fed to LLMs.
      throw new Error(
        `Figma API error (${res.status}): ${safeDisplayText(res.statusText, 128)}. ${figmaErrorGuidance(res)}`
      )
    }
    const body = await readFigmaResponseBody(res)
    this.scanResponseBytes += body.byteLength
    if (this.scanResponseBytes > this.maxScanResponseBytes) {
      throw new Error(`Figma API scan responses exceed the ${this.maxScanResponseBytes}-byte aggregate limit.`)
    }
    try {
      return JSON.parse(body.text) as T
    } catch {
      throw new Error("Figma API returned invalid JSON.")
    }
  }

  private async extractTokens(): Promise<TokenMap> {
    const tokens: TokenMap = emptyTokenMap()

    const data = await this.fetchFigma<FigmaVariablesResponse>(`/files/${this.config.fileId}/variables/local`)
    const variables = data.meta?.variables || {}
    const collections = data.meta?.variableCollections || {}

    for (const variable of Object.values(variables)) {
      if (!variable || typeof variable !== "object" || Array.isArray(variable)) continue
      if (variable.remote) continue
      if (
        !boundedRequiredMetadata(variable.id) ||
        !boundedRequiredMetadata(variable.name) ||
        !boundedRequiredMetadata(variable.resolvedType) ||
        !boundedRequiredMetadata(variable.variableCollectionId) ||
        (variable.key !== undefined && !boundedRequiredMetadata(variable.key))
      ) {
        continue
      }

      const rawCollection = collections[variable.variableCollectionId]
      const collection =
        rawCollection && typeof rawCollection === "object" && !Array.isArray(rawCollection) ? rawCollection : undefined
      const defaultModeId = collection?.defaultModeId
      if (!boundedRequiredMetadata(defaultModeId)) continue

      const valuesByMode =
        variable.valuesByMode && typeof variable.valuesByMode === "object" && !Array.isArray(variable.valuesByMode)
          ? variable.valuesByMode
          : {}
      const rawValue = valuesByMode[defaultModeId]
      if (rawValue === undefined || rawValue === null) continue

      // Skip alias variables (references to other variables)
      if (typeof rawValue === "object" && "type" in rawValue && rawValue.type === "VARIABLE_ALIAS") continue

      const resolved = this.resolveValue(variable.resolvedType, rawValue, variable.key)
      if (!resolved || !withinUtf8Limit(resolved, FIGMA_MAX_PROPERTY_VALUE_STRING_BYTES)) continue

      const name = this.normalizeName(this.mappingFor(this.config.tokenAliases, variable.key) ?? variable.name)
      if (!withinUtf8Limit(name, FIGMA_MAX_METADATA_STRING_BYTES)) continue
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
          collectionName:
            typeof collection?.name === "string" && withinUtf8Limit(collection.name, FIGMA_MAX_METADATA_STRING_BYTES)
              ? collection.name
              : undefined
        }
      }
      const existing = tokens[category][name]
      if (existing) {
        const existingKey = existing.source.metadata?.variableKey
        const existingIdentity = typeof existingKey === "string" ? existingKey : existing.name
        throw new Error(
          `Figma token mapping collision: variables '${existingIdentity}' and '${this.variableIdentity(variable)}' both resolve to '${category}.${name}'. Give each token a distinct name or tokenAliases value.`
        )
      }
      const modes: Record<string, string> = {}
      const modeSources: Record<string, SourceProvenance> = {}
      const modeOrigins: Record<string, { id: string; name: string }> = {}
      const candidateModes = Array.isArray(collection?.modes) ? collection.modes : []
      const boundedModes = candidateModes.length <= FIGMA_MAX_PROPERTY_VALUES ? candidateModes : []
      const namedModes = new Map(
        boundedModes
          .filter(
            (mode): mode is { modeId: string; name: string } =>
              boundedRequiredMetadata(mode.modeId) && boundedRequiredMetadata(mode.name)
          )
          .map((mode) => [mode.modeId, mode.name])
      )

      const modeEntries = Object.entries(valuesByMode).sort(([a], [b]) => compareStrings(a, b))
      for (const [modeId, modeRawValue] of modeEntries.slice(0, FIGMA_MAX_PROPERTY_VALUES)) {
        if (modeId === defaultModeId) continue
        const rawModeName = namedModes.get(modeId)
        if (!rawModeName) continue
        // Normalization is lexical only: "Night" becomes "night", never "dark". Semantic
        // aliases are an explicit future configuration decision, not an adapter guess.
        const mode = this.normalizeModeName(this.config.modeAliases?.[modeId] ?? rawModeName)
        if (!mode || !withinUtf8Limit(mode, FIGMA_MAX_METADATA_STRING_BYTES)) continue
        if (typeof modeRawValue === "object" && "type" in modeRawValue && modeRawValue.type === "VARIABLE_ALIAS") {
          continue
        }
        if (mode in modes) {
          const existingMode = modeOrigins[mode]
          throw new Error(
            `Figma mode mapping collision for variable '${this.variableIdentity(variable)}': modes '${existingMode.name}' (${existingMode.id}) and '${rawModeName}' (${modeId}) both resolve to '${mode}'. Give each mode a distinct modeAliases value.`
          )
        }
        const modeValue = this.resolveValue(variable.resolvedType, modeRawValue, variable.key)
        if (!modeValue || !withinUtf8Limit(modeValue, FIGMA_MAX_PROPERTY_VALUE_STRING_BYTES)) continue
        modes[mode] = modeValue
        modeOrigins[mode] = { id: modeId, name: rawModeName }
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
    // The published lists are discovery only. Component-property definitions and set
    // membership come from the targeted node responses below.
    const [componentResponse, componentSetResponse] = await Promise.all([
      this.fetchFigma<FigmaComponentsResponse>(`/files/${this.config.fileId}/components`),
      this.fetchFigma<FigmaComponentsResponse>(`/files/${this.config.fileId}/component_sets`)
    ])
    const componentEntries = componentResponse.meta?.components
    const componentSetEntries = componentSetResponse.meta?.component_sets
    if (!Array.isArray(componentEntries) || !Array.isArray(componentSetEntries)) {
      throw new Error("Figma published component discovery returned a malformed asset list.")
    }
    if (componentEntries.length + componentSetEntries.length > FIGMA_MAX_PUBLISHED_ASSETS) {
      throw new Error(`Figma published component discovery exceeds the ${FIGMA_MAX_PUBLISHED_ASSETS}-asset limit.`)
    }
    const discoveredAssets = this.collectPublishedAssets(componentEntries, "component")
    discoveredAssets.push(...this.collectPublishedAssets(componentSetEntries, "component-set"))
    const assets: PublishedAsset[] = []
    const seenAssets = new Map<string, PublishedAsset>()
    for (const asset of discoveredAssets) {
      const existing = seenAssets.get(asset.key)
      if (existing) {
        if (
          existing.nodeId !== asset.nodeId ||
          existing.kind !== asset.kind ||
          existing.name !== asset.name ||
          existing.description !== asset.description ||
          existing.updatedAt !== asset.updatedAt
        ) {
          throw new Error(`Figma published asset '${safeIdentity(asset)}' was discovered with conflicting identities.`)
        }
        continue
      }
      seenAssets.set(asset.key, asset)
      assets.push(asset)
    }

    const byKey = new Map<string, PublishedAsset>()
    const byNodeId = new Map<string, PublishedAsset>()
    for (const asset of assets) {
      const existingKey = byKey.get(asset.key)
      if (existingKey && existingKey.nodeId !== asset.nodeId) {
        throw new Error(`Figma published asset key '${safeIdentity(asset)}' maps to multiple node IDs.`)
      }
      const existingNode = byNodeId.get(asset.nodeId)
      if (existingNode && existingNode.key !== asset.key) {
        throw new Error(`Figma node '${safeDisplayText(asset.nodeId, 128)}' maps to multiple published asset keys.`)
      }
      byKey.set(asset.key, asset)
      byNodeId.set(asset.nodeId, asset)
    }

    const sortedAssets = [...assets].sort(comparePublishedAssets)
    const nodeIds = sortedAssets.map((asset) => asset.nodeId)
    if (nodeIds.length === 0) return Object.create(null) as ComponentMap

    const evidence = await this.fetchNodeEvidence(sortedAssets)
    const sets = new Map<string, NodeEvidence>()
    const components = new Map<string, NodeEvidence>()
    for (const item of evidence) {
      if (item.asset.kind === "component-set") sets.set(item.asset.key, item)
      else components.set(item.asset.key, item)
    }

    const consumedChildren = new Set<string>()
    for (const item of components.values()) {
      if (!item.componentSetNodeId) continue
      if (!item.componentSetKey || !sets.has(item.componentSetKey)) {
        throw new Error(
          `Figma component '${safeIdentity(item.asset)}' claims membership in an unresolved published component set.`
        )
      }
      consumedChildren.add(item.asset.key)
    }

    const output: ComponentMap = Object.create(null) as ComponentMap
    for (const item of sets.values()) {
      output[`figma:${item.asset.key}`] = this.toComponent(item, byKey)
    }
    for (const item of components.values()) {
      if (consumedChildren.has(item.asset.key)) continue
      output[`figma:${item.asset.key}`] = this.toComponent(item, byKey)
    }
    return sortComponentMap(output)
  }

  private collectPublishedAssets(
    entries: FigmaComponentMeta[] | undefined,
    kind: PublishedAsset["kind"]
  ): PublishedAsset[] {
    const assets: PublishedAsset[] = []
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!entry || typeof entry !== "object") {
        throw new Error(`Figma published ${kind} discovery result is malformed.`)
      }
      const key = nonEmptyString(entry.key)
      const nodeId = nonEmptyString(entry.node_id)
      if (!key || !nodeId) {
        throw new Error(`Figma published ${kind} discovery result is missing a stable key or node ID.`)
      }
      if (
        !withinUtf8Limit(key, FIGMA_MAX_METADATA_STRING_BYTES) ||
        !withinUtf8Limit(nodeId, FIGMA_MAX_METADATA_STRING_BYTES)
      ) {
        throw new Error(`Figma published ${kind} discovery contains oversized identity metadata.`)
      }
      const fileKey = nonEmptyString(entry.file_key)
      if (!fileKey || fileKey !== this.config.fileId) {
        throw new Error(`Figma published asset '${safeDisplayText(key, 128)}' reports an invalid file key.`)
      }
      const name = nonEmptyString(entry.name) ?? key
      if (!withinUtf8Limit(name, FIGMA_MAX_METADATA_STRING_BYTES)) {
        throw new Error(`Figma published ${kind} discovery contains oversized name metadata.`)
      }
      assets.push({
        key,
        nodeId,
        name,
        kind,
        ...(typeof entry.description === "string" && withinUtf8Limit(entry.description, FIGMA_MAX_DESCRIPTION_BYTES)
          ? { description: entry.description }
          : {}),
        ...(typeof entry.updated_at === "string" && withinUtf8Limit(entry.updated_at, FIGMA_MAX_METADATA_STRING_BYTES)
          ? { updatedAt: entry.updated_at }
          : {})
      })
    }
    return assets
  }

  private async fetchNodeEvidence(assets: PublishedAsset[]): Promise<NodeEvidence[]> {
    const batches: string[][] = []
    for (let index = 0; index < assets.length; index += FIGMA_NODE_BATCH_SIZE) {
      batches.push(assets.slice(index, index + FIGMA_NODE_BATCH_SIZE).map((asset) => asset.nodeId))
    }

    const responses: FigmaNodesResponse[] = []
    let pinnedVersion: string | undefined
    let fileName: string | undefined
    let lastModified: string | undefined
    for (let index = 0; index < batches.length; index += 1) {
      if (index > 0 && !pinnedVersion) {
        throw new Error("Figma component evidence requires a version when more than one node batch is needed.")
      }
      const query = new URLSearchParams({ ids: batches[index].join(","), depth: "1" })
      if (pinnedVersion) query.set("version", pinnedVersion)
      const response = await this.fetchFigma<FigmaNodesResponse>(
        `/files/${this.config.fileId}/nodes?${query.toString()}`
      )
      responses.push(response)

      const responseVersion = boundedMetadataString(response.version)
      if (responseVersion !== undefined) {
        if (pinnedVersion && responseVersion !== pinnedVersion) {
          throw new Error("Figma component evidence returned conflicting file versions.")
        }
        pinnedVersion = responseVersion
      } else if (index > 0) {
        throw new Error("Figma component evidence returned no version for a pinned node batch.")
      }
      const responseName = boundedMetadataString(response.name)
      if (responseName !== undefined) {
        if (fileName !== undefined && fileName !== responseName) {
          throw new Error("Figma component evidence returned conflicting file metadata.")
        }
        fileName = responseName
      }
      const responseLastModified = boundedMetadataString(response.lastModified)
      if (responseLastModified !== undefined) {
        if (lastModified !== undefined && lastModified !== responseLastModified) {
          throw new Error("Figma component evidence returned conflicting file metadata.")
        }
        lastModified = responseLastModified
      }
    }

    const componentTables = new Map<string, FigmaNodeMetadata>()
    const componentSetTables = new Map<string, FigmaNodeMetadata>()
    for (const response of responses) {
      for (const wrapper of Object.values(response.nodes ?? {})) {
        if (!wrapper) continue
        this.mergeNodeMetadata(componentTables, wrapper.components)
        this.mergeNodeMetadata(componentSetTables, wrapper.componentSets)
      }
    }

    const byNodeId = new Map(assets.map((asset) => [asset.nodeId, asset]))
    const targetedByNodeId = new Map<string, PublishedAsset>()
    const targetedNodeKeys = new Map<string, string | undefined>()
    const conflictedTargetedNodes = new Set<string>()
    for (const [nodeId, metadata] of [...componentTables, ...componentSetTables]) {
      if (!metadata.key) continue
      if (conflictedTargetedNodes.has(nodeId)) continue
      const prior = targetedNodeKeys.get(nodeId)
      if (prior !== undefined && prior !== metadata.key) targetedNodeKeys.set(nodeId, undefined)
      else targetedNodeKeys.set(nodeId, metadata.key)
      if (prior !== undefined && prior !== metadata.key) conflictedTargetedNodes.add(nodeId)
    }
    for (const [nodeId, key] of targetedNodeKeys) {
      const asset = key === undefined ? undefined : byNodeId.get(nodeId)
      if (asset && asset.key === key) targetedByNodeId.set(nodeId, asset)
    }
    const evidence: NodeEvidence[] = []
    for (const asset of assets) {
      const wrapper = responses
        .map((response) => response.nodes?.[asset.nodeId])
        .find((candidate) => candidate !== undefined)
      const document = wrapper?.document
      if (!document)
        throw new Error(`Figma published asset '${safeIdentity(asset)}' is missing targeted node evidence.`)
      if (document.id !== asset.nodeId) {
        throw new Error(`Figma published asset '${safeIdentity(asset)}' returned mismatched node evidence.`)
      }
      const expectedType = asset.kind === "component-set" ? "COMPONENT_SET" : "COMPONENT"
      if (document.type !== expectedType) {
        throw new Error(`Figma published asset '${safeIdentity(asset)}' returned mismatched node evidence.`)
      }
      const metadata =
        asset.kind === "component" ? componentTables.get(asset.nodeId) : componentSetTables.get(asset.nodeId)
      if (asset.kind === "component" && (!metadata || metadata.key !== asset.key)) {
        throw new Error(`Figma published asset '${safeIdentity(asset)}' is missing matching component metadata.`)
      }
      if (asset.kind === "component-set" && metadata?.key !== undefined && metadata.key !== asset.key) {
        throw new Error(`Figma published asset '${safeIdentity(asset)}' returned a mismatched published key.`)
      }

      let componentSetNodeId: string | undefined
      let componentSetKey: string | undefined
      if (asset.kind === "component") {
        const membership = componentTables.get(asset.nodeId)
        const claimedSet = nonEmptyString(membership?.componentSetId ?? membership?.component_set_id)
        if (claimedSet) {
          const setMetadata = componentSetTables.get(claimedSet)
          const setAsset = byNodeId.get(claimedSet)
          if (
            !setAsset ||
            setAsset.kind !== "component-set" ||
            (setMetadata?.key !== undefined && setMetadata.key !== setAsset.key)
          ) {
            throw new Error(
              `Figma component '${safeIdentity(asset)}' claims membership in an unresolved component set.`
            )
          }
          componentSetNodeId = claimedSet
          componentSetKey = setAsset.key
        }
      }
      evidence.push({ asset, document, metadata, componentSetNodeId, componentSetKey, targetedByNodeId })
    }

    // Without a version, a single batch is usable but must not claim snapshot metadata.
    const snapshot = pinnedVersion
      ? { fileName, version: pinnedVersion, lastModified }
      : { fileName, version: undefined, lastModified: undefined }
    for (const item of evidence) item.snapshot = snapshot
    return evidence
  }

  private mergeNodeMetadata(
    target: Map<string, FigmaNodeMetadata>,
    source: Record<string, FigmaNodeMetadata> | undefined
  ): void {
    if (!source || typeof source !== "object" || Array.isArray(source)) return
    for (const [nodeId, metadata] of Object.entries(source)) {
      if (!withinUtf8Limit(nodeId, FIGMA_MAX_METADATA_STRING_BYTES)) {
        throw new Error("Figma component evidence contains oversized identity metadata.")
      }
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue
      for (const value of [metadata.key, metadata.name, metadata.componentSetId, metadata.component_set_id]) {
        if (typeof value === "string" && !withinUtf8Limit(value, FIGMA_MAX_METADATA_STRING_BYTES)) {
          throw new Error("Figma component evidence contains oversized metadata.")
        }
      }
      const existing = target.get(nodeId)
      if (existing && !sameNodeMetadata(existing, metadata)) {
        throw new Error("Figma component evidence returned conflicting metadata.")
      }
      const existingMembership = existing?.componentSetId ?? existing?.component_set_id
      const incomingMembership = metadata.componentSetId ?? metadata.component_set_id
      const merged: FigmaNodeMetadata = {}
      const key = metadata.key ?? existing?.key
      const name = metadata.name ?? existing?.name
      const membership = incomingMembership ?? existingMembership
      if (key !== undefined) merged.key = key
      if (name !== undefined) merged.name = name
      if (membership !== undefined) merged.componentSetId = membership
      target.set(nodeId, merged)
    }
  }

  private toComponent(item: NodeEvidence, byKey: Map<string, PublishedAsset>): Component {
    const metadata = item.snapshot
    const sourceMetadata: Record<string, unknown> = {
      assetType: item.asset.kind,
      assetKey: item.asset.key,
      nodeId: item.asset.nodeId,
      fileKey: this.config.fileId,
      ...(item.asset.updatedAt !== undefined ? { publishedUpdatedAt: item.asset.updatedAt } : {})
    }
    if (metadata?.fileName !== undefined) sourceMetadata.fileName = metadata.fileName
    if (metadata?.version !== undefined) sourceMetadata.fileVersion = metadata.version
    if (metadata?.lastModified !== undefined) sourceMetadata.fileLastModified = metadata.lastModified

    const props = this.extractPropertyDefinitions(item.document.componentPropertyDefinitions, {
      byKey,
      byNodeId: item.targetedByNodeId ?? new Map()
    })
    return {
      name: item.asset.name,
      displayName: item.asset.name,
      ...(item.asset.description !== undefined ? { description: item.asset.description } : {}),
      source: { adapter: "figma", metadata: sourceMetadata },
      props
    }
  }

  private extractPropertyDefinitions(
    definitions: Record<string, FigmaPropertyDefinition> | undefined,
    lookups: PropertyLookupContext
  ): Record<string, PropDefinition> {
    const props: Record<string, PropDefinition> = Object.create(null) as Record<string, PropDefinition>
    if (!definitions || typeof definitions !== "object" || Array.isArray(definitions)) return props
    // Definitions are a formal set: dropping the complete set is safer than
    // presenting a plausible but incomplete component contract.
    if (Object.keys(definitions).length > FIGMA_MAX_PROPERTY_DEFINITIONS) return props
    for (const name of Object.keys(definitions).sort(compareStrings)) {
      if (!name || name.trim().length === 0) continue
      if (!withinUtf8Limit(name, FIGMA_MAX_PROPERTY_NAME_BYTES)) continue
      const definition = definitions[name]
      if (
        !definition ||
        typeof definition !== "object" ||
        Array.isArray(definition) ||
        typeof definition.type !== "string"
      ) {
        continue
      }
      const mapped = this.mapPropertyDefinition(definition, lookups)
      if (mapped) props[name] = mapped as PropDefinition
    }
    return props
  }

  private mapPropertyDefinition(
    definition: FigmaPropertyDefinition,
    lookups: PropertyLookupContext
  ): Record<string, unknown> | undefined {
    switch (definition.type) {
      case "BOOLEAN": {
        const value = definition.defaultValue
        return {
          type: "boolean",
          kind: "boolean",
          ...(typeof value === "boolean" ? { default: String(value) } : {})
        }
      }
      case "TEXT": {
        const value = definition.defaultValue
        return {
          type: "string",
          kind: "text",
          ...(typeof value === "string" && withinUtf8Limit(value, FIGMA_MAX_PROPERTY_VALUE_STRING_BYTES)
            ? { default: value }
            : {})
        }
      }
      case "VARIANT": {
        if (!Array.isArray(definition.variantOptions)) return undefined
        if (definition.variantOptions.length > FIGMA_MAX_PROPERTY_VALUES) return undefined
        if (!definition.variantOptions.every((value) => typeof value === "string")) return undefined
        const values = definition.variantOptions as string[]
        if (!values.every((value) => withinUtf8Limit(value, FIGMA_MAX_PROPERTY_VALUE_STRING_BYTES))) return undefined
        if (values.length === 0) return undefined
        const sorted = sortPrimitiveValues(values)
        const defaultValue =
          typeof definition.defaultValue === "string" && sorted.includes(definition.defaultValue)
            ? definition.defaultValue
            : undefined
        return { kind: "variant", values: sorted, ...(defaultValue !== undefined ? { default: defaultValue } : {}) }
      }
      case "INSTANCE_SWAP": {
        const preferredValues =
          Array.isArray(definition.preferredValues) && definition.preferredValues.length <= FIGMA_MAX_PROPERTY_VALUES
            ? definition.preferredValues.filter(isBoundedPreferredValue).map((value) => ({
                type: value.type === "COMPONENT_SET" ? "component-set" : "component",
                key: value.key
              }))
            : []
        const unique = new Map(preferredValues.map((value) => [`${value.type}:${value.key}`, value]))
        const sorted = [...unique.values()].sort(
          (a, b) => compareStrings(a.type, b.type) || compareStrings(a.key, b.key)
        )
        const defaultValue =
          typeof definition.defaultValue === "string" &&
          withinUtf8Limit(definition.defaultValue, FIGMA_MAX_METADATA_STRING_BYTES)
            ? (lookups.byKey.get(definition.defaultValue)?.key ?? lookups.byNodeId.get(definition.defaultValue)?.key)
            : undefined
        return {
          kind: "instance-swap",
          ...(defaultValue !== undefined ? { default: defaultValue } : {}),
          ...(sorted.length > 0 ? { preferredValues: sorted } : {})
        }
      }
      default:
        return undefined
    }
  }

  private mappingFor(mapping: Record<string, string> | undefined, stableKey: string | undefined): string | undefined {
    // A variable without Figma's publish-stable key cannot opt in to a mapping. In
    // particular, never fall back to mapping[""]: that makes an empty config key a wildcard.
    return stableKey ? mapping?.[stableKey] : undefined
  }

  private variableIdentity(variable: FigmaVariable): string {
    return variable.key ?? variable.id
  }

  private resolveValue(type: string, raw: FigmaRawValue, variableKey?: string): string | null {
    if (type === "COLOR" && typeof raw === "object" && "r" in raw) {
      return this.rgbaToHex(raw.r, raw.g, raw.b, raw.a)
    }
    if (type === "FLOAT" && typeof raw === "number") {
      // Figma FLOAT has no CSS-unit semantics. Adding `px` turns valid opacity,
      // weight, z-index, line-height, and motion values into a different value.
      // Preserve the raw number unless the user declared a unit for this stable variable key.
      return `${raw}${this.mappingFor(this.config.numericUnits, variableKey) ?? ""}`
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

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined
}

function boundedMetadataString(value: unknown): string | undefined {
  const string = nonEmptyString(value)
  if (string === undefined) return undefined
  if (!withinUtf8Limit(string, FIGMA_MAX_METADATA_STRING_BYTES)) {
    throw new Error("Figma component evidence contains oversized metadata.")
  }
  return string
}

function boundedRequiredMetadata(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && withinUtf8Limit(value, FIGMA_MAX_METADATA_STRING_BYTES)
}

function withinUtf8Limit(value: string, maxBytes: number): boolean {
  return new TextEncoder().encode(value).byteLength <= maxBytes
}

function safeIdentity(asset: PublishedAsset): string {
  return safeDisplayText(asset.key, 128)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function comparePublishedAssets(a: PublishedAsset, b: PublishedAsset): number {
  return compareStrings(a.key, b.key) || compareStrings(a.nodeId, b.nodeId) || compareStrings(a.kind, b.kind)
}

function sortComponentMap(components: ComponentMap): ComponentMap {
  const sorted: ComponentMap = Object.create(null) as ComponentMap
  for (const id of Object.keys(components).sort(compareStrings)) sorted[id] = components[id]
  return sorted
}

function sortPrimitiveValues(values: Array<string | number | boolean>): Array<string | number | boolean> {
  const unique = new Map<string, string | number | boolean>()
  for (const value of values) unique.set(`${typeof value}:${String(value)}`, value)
  return [...unique.values()].sort(comparePrimitiveValues)
}

function comparePrimitiveValues(a: string | number | boolean, b: string | number | boolean): number {
  const rank = (value: string | number | boolean): number =>
    typeof value === "boolean" ? 0 : typeof value === "number" ? 1 : 2
  const aRank = rank(a)
  const bRank = rank(b)
  if (aRank !== bRank) return aRank - bRank
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
  if (typeof a === "number" && typeof b === "number") return a - b
  return a < b ? -1 : a > b ? 1 : 0
}

function isPreferredValue(value: unknown): value is { type: "COMPONENT" | "COMPONENT_SET"; key: string } {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    (candidate.type === "COMPONENT" || candidate.type === "COMPONENT_SET") &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0
  )
}

function isBoundedPreferredValue(value: unknown): value is { type: "COMPONENT" | "COMPONENT_SET"; key: string } {
  return isPreferredValue(value) && withinUtf8Limit(value.key, FIGMA_MAX_METADATA_STRING_BYTES)
}

function sameNodeMetadata(a: FigmaNodeMetadata, b: FigmaNodeMetadata): boolean {
  const membershipA = a.componentSetId ?? a.component_set_id
  const membershipB = b.componentSetId ?? b.component_set_id
  return sameOptional(a.key, b.key) && sameOptional(a.name, b.name) && sameOptional(membershipA, membershipB)
}

function figmaErrorGuidance(response: Response): string {
  switch (response.status) {
    case 403:
      return "Check that the token has library_content:read and file_content:read, and that it can access the configured published main file."
    case 404:
      return "Check that fileId is the published main-file key; Figma's published-library endpoints do not accept branch keys."
    case 429:
      return `Figma rate limit exceeded.${retryAfterGuidance(response.headers.get("Retry-After"))}`
    default:
      return "Check your token and fileId in primitiv.config.js."
  }
}

function retryAfterGuidance(value: string | null): string {
  if (value !== null) {
    const trimmed = value.trim()
    if (/^(0|[1-9]\d{0,9})$/.test(trimmed)) return ` Retry after ${trimmed} seconds.`
    if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(trimmed)) {
      const timestamp = Date.parse(trimmed)
      if (Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === trimmed) {
        return ` Retry after ${trimmed}.`
      }
    }
  }
  return " Wait before trying again."
}

function sameOptional(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b
}

async function readFigmaResponseBody(response: Response): Promise<{ text: string; byteLength: number }> {
  const contentLength = response.headers.get("Content-Length")
  if (contentLength !== null && /^(0|[1-9]\d*)$/.test(contentLength.trim())) {
    const declaredLength = Number(contentLength.trim())
    if (Number.isSafeInteger(declaredLength) && declaredLength > FIGMA_MAX_RESPONSE_BYTES) {
      throw new Error(`Figma API response exceeds the ${FIGMA_MAX_RESPONSE_BYTES}-byte limit.`)
    }
  }

  // Read the stream ourselves because Content-Length is advisory (and is often
  // absent for chunked responses). The bytes actually received are authoritative.
  // A null body represents zero bytes in the Fetch response model.
  if (!response.body) return { text: "", byteLength: 0 }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      totalBytes += result.value.byteLength
      if (totalBytes > FIGMA_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // The response is already over the cap; cancellation failure does not
          // change the safe, deterministic error reported to callers.
        }
        throw new Error(`Figma API response exceeds the ${FIGMA_MAX_RESPONSE_BYTES}-byte limit.`)
      }
      chunks.push(result.value)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Figma API response exceeds")) throw error
    throw new Error("Figma API response could not be read.")
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { text: new TextDecoder().decode(bytes), byteLength: totalBytes }
}
