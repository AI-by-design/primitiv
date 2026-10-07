import * as fs from "node:fs"
import * as path from "node:path"
import * as YAML from "yaml"
import { safeDisplayText } from "../safe-display"
import { isSafeNonEmptyIdentifier } from "../safe-identifier"
import type {
  ComponentAnnotation,
  GuidanceDiagnostic,
  GuidanceHealth,
  GuidanceOrigin,
  GuidanceSourceState,
  PrimitivConfig,
  PrimitivContract,
  RationaleMap
} from "../types"
import { applyRationale } from "./rationale"
import { GUIDANCE_LIMITS, validateComponentAnnotation } from "./schema"

export const DEFAULT_GUIDANCE_PATH = "primitiv.rationale.yml"
interface GuidanceData {
  tokens?: RationaleMap["tokens"]
  components?: Record<string, unknown>
}
interface GuidanceLayer {
  source: GuidanceSourceState
  kind: GuidanceOrigin["sourceKind"]
  locator: string
  data: GuidanceData
}
export interface LoadedGuidance {
  layers: GuidanceLayer[]
  health: GuidanceHealth
}

/** Selected inputs only. YAML's existing default alias limit and duplicate-key checks are retained. */
export function loadGuidance(config: PrimitivConfig, configDir: string): LoadedGuidance {
  const loaded: LoadedGuidance = {
    layers: [],
    health: { schemaVersion: 1, sources: [], total: 0, byCode: {}, items: [], truncated: false }
  }
  const configuredPath = config.rationale?.path
  const invalidPath = configuredPath !== undefined && typeof configuredPath !== "string"
  const selected = path.resolve(
    configDir,
    typeof configuredPath === "string" ? configuredPath || DEFAULT_GUIDANCE_PATH : DEFAULT_GUIDANCE_PATH
  )
  const relative = path.relative(configDir, selected).split(path.sep).join("/")
  const locator =
    relative && portableLocator(relative) && safeIdentifier(relative) && Buffer.byteLength(relative) <= 2000
      ? relative
      : "external:sidecar"
  const source = newSource(
    `sidecar:${invalidPath ? "external:sidecar" : locator}`,
    configuredPath || invalidPath ? "configured" : "default"
  )
  loaded.health.sources.push(source)
  let data: unknown
  if (invalidPath) {
    source.readState = "invalid"
    source.complete = false
    addDiagnostic(loaded.health, {
      code: "invalid-field",
      severity: "error",
      sourceId: source.sourceId,
      fieldPath: ["path"],
      message: "selected guidance path must be a string"
    })
  } else
    try {
      data = fs.readFileSync(selected, "utf8")
    } catch (error) {
      const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
      source.readState = missing ? (source.selection === "default" ? "absent" : "missing") : "unreadable"
      source.complete = source.readState === "absent"
      if (!source.complete)
        addDiagnostic(loaded.health, {
          code: "read-failed",
          severity: "error",
          sourceId: source.sourceId,
          fieldPath: [],
          message: missing ? "selected guidance file is missing" : "selected guidance file could not be read"
        })
    }
  if (typeof data === "string") {
    try {
      data = YAML.parse(data)
      addLayer(loaded, source, "sidecar", locator, data ?? {})
    } catch {
      source.readState = "invalid"
      source.complete = false
      addDiagnostic(loaded.health, {
        code: "parse-failed",
        severity: "error",
        sourceId: source.sourceId,
        fieldPath: [],
        message: "selected guidance document could not be parsed (including duplicate keys or excessive aliases)"
      })
    }
  }
  if (config.rationale?.inline !== undefined) {
    const inline = newSource("inline:config", "inline")
    loaded.health.sources.push(inline)
    addLayer(loaded, inline, "inline", "external:config", config.rationale.inline)
  }
  return loaded
}

/** Bind after reconciliation; whole winning entries replace, and invalid winners never fall back. */
export function attachGuidance(contract: PrimitivContract, loaded: LoadedGuidance): GuidanceHealth {
  const byName: Record<string, string[]> = Object.create(null)
  for (const [id, component] of Object.entries(contract.components)) {
    const name = component.displayName ?? component.name
    if (!byName[name]) byName[name] = []
    byName[name].push(id)
  }
  const winners = new Map<string, { annotation?: ComponentAnnotation; origin: GuidanceOrigin }>()
  for (const layer of loaded.layers) {
    // Tokens intentionally retain the legacy schema and whole-entry precedence.
    applyRationale(contract.tokens, {}, { tokens: layer.data.tokens })
    const candidates = new Map<
      string,
      Array<{ key: string; binding: GuidanceOrigin["binding"]; annotation?: ComponentAnnotation }>
    >()
    for (const [key, value] of Object.entries(layer.data.components ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const validKey = safeIdentifier(key)
      const validated = validateComponentAnnotation(value)
      const ids = own(contract.components, key) ? [key] : (byName[key] ?? [])
      const id = ids.length === 1 ? ids[0] : undefined
      const notices = [...validated.warnings, ...(!validated.success ? validated.issues : [])]
      for (const notice of notices)
        addDiagnostic(loaded.health, {
          code: notice.code,
          severity: notice.code === "unknown-field" || notice.code === "duplicate-intent" ? "warning" : "error",
          sourceId: layer.source.sourceId,
          ...(validKey ? { authoredKey: key } : {}),
          ...(id && safeIdentifier(id) ? { componentId: id } : {}),
          fieldPath: notice.fieldPath,
          message: notice.message
        })
      if (!validKey)
        addDiagnostic(loaded.health, {
          code: "invalid-field",
          severity: "error",
          sourceId: layer.source.sourceId,
          fieldPath: [],
          message: "authored component key must be a bounded safe identifier"
        })
      if (id && !safeIdentifier(id))
        addDiagnostic(loaded.health, {
          code: "invalid-field",
          severity: "error",
          sourceId: layer.source.sourceId,
          fieldPath: [],
          message: "bound component ID cannot be represented safely in guidance evidence"
        })
      const valid = validated.success && validKey && (!id || safeIdentifier(id))
      if (valid) layer.source.validEntries++
      else layer.source.invalidEntries++
      if (valid) {
        if (id) layer.source.boundEntries++
        else layer.source.unboundEntries++
      }
      if (!id) {
        addDiagnostic(loaded.health, {
          code: ids.length > 1 ? "ambiguous-binding" : "unbound-entry",
          severity: "warning",
          sourceId: layer.source.sourceId,
          ...(validKey ? { authoredKey: key } : {}),
          fieldPath: [],
          message:
            ids.length > 1
              ? `rationale key '${key}' matches ${ids.length} components — not applied. Qualify it with a component id.`
              : "authored component key does not bind to an available component"
        })
        continue
      }
      if (!validKey || !safeIdentifier(id)) continue
      const list = candidates.get(id) ?? []
      list.push({
        key,
        binding: own(contract.components, key) ? "id" : "unique-name",
        annotation: valid && validated.success ? validated.data : undefined
      })
      candidates.set(id, list)
    }
    for (const [id, entries] of candidates) {
      const winner = entries.find((entry) => entry.binding === "id") ?? entries[0]
      if (entries.length > 1)
        addDiagnostic(loaded.health, {
          code: "alias-conflict",
          severity: "warning",
          sourceId: layer.source.sourceId,
          componentId: id,
          authoredKey: winner.key,
          fieldPath: [],
          message: "multiple authored keys bind to this component; exact ID takes precedence within a source"
        })
      winners.set(id, {
        annotation: winner.annotation,
        origin: {
          sourceId: layer.source.sourceId,
          sourceKind: layer.kind,
          locator:
            layer.kind === "inline" &&
            safeIdentifier(path.basename(contract.configPath)) &&
            portableLocator(path.basename(contract.configPath))
              ? path.basename(contract.configPath)
              : layer.locator,
          authoredKey: winner.key,
          binding: winner.binding
        }
      })
    }
  }
  const coverageComplete =
    contract.sourceStatuses !== undefined &&
    ["codebase", "figma", "storybook"].every((source) => own(contract.sourceStatuses ?? {}, source)) &&
    Object.values(contract.sourceStatuses).every((source) => source.status !== "failed")
  for (const [id, winner] of winners) {
    const component = contract.components[id]
    delete component.rationale
    delete component.classification
    delete component.guidanceOrigin
    if (!winner.annotation) continue
    const { classification, ...rationale } = winner.annotation
    component.rationale = rationale
    if (classification !== undefined) component.classification = classification
    component.guidanceOrigin = winner.origin
    for (const [field, entries, ref] of [
      ["avoidWhen", rationale.avoidWhen, "alternative"],
      ["pairsWith", rationale.pairsWith, "component"]
    ] as const) {
      for (const [index, entry] of (entries ?? []).entries()) {
        const reference =
          ref === "alternative"
            ? (entry as NonNullable<typeof rationale.avoidWhen>[number]).alternative
            : (entry as NonNullable<typeof rationale.pairsWith>[number]).component
        if (!reference || own(contract.components, reference.componentId)) continue
        if (!coverageComplete) {
          const source = loaded.health.sources.find((source) => source.sourceId === winner.origin.sourceId)
          if (source) source.complete = false
        }
        addDiagnostic(loaded.health, {
          code: coverageComplete ? "unresolved-reference" : "incomplete-reference-evidence",
          severity: "warning",
          sourceId: winner.origin.sourceId,
          authoredKey: winner.origin.authoredKey,
          componentId: id,
          targetId: reference.componentId,
          fieldPath: [field, index, ref, "componentId"],
          message: coverageComplete
            ? "referenced exact component ID is not in the final inventory"
            : "source coverage is incomplete; referenced component availability is unknown"
        })
      }
    }
  }
  contract.guidanceHealth = loaded.health
  return loaded.health
}

function newSource(sourceId: string, selection: GuidanceSourceState["selection"]): GuidanceSourceState {
  return {
    sourceId,
    selection,
    readState: "ok",
    validEntries: 0,
    invalidEntries: 0,
    boundEntries: 0,
    unboundEntries: 0,
    complete: true
  }
}
function addLayer(
  loaded: LoadedGuidance,
  source: GuidanceSourceState,
  kind: GuidanceOrigin["sourceKind"],
  locator: string,
  data: unknown
): void {
  if (!dictionary(data)) {
    source.readState = "invalid"
    source.complete = false
    addDiagnostic(loaded.health, {
      code: "invalid-field",
      severity: "error",
      sourceId: source.sourceId,
      fieldPath: [],
      message: "guidance document must be a dictionary"
    })
    return
  }
  const layer: GuidanceData = {}
  for (const [key, value] of Object.entries(data)) {
    if (key !== "components" && key !== "tokens") {
      addDiagnostic(loaded.health, {
        code: "unknown-field",
        severity: "warning",
        sourceId: source.sourceId,
        fieldPath: [key],
        message: "unknown authored field"
      })
    } else if (!dictionary(value)) {
      source.complete = false
      addDiagnostic(loaded.health, {
        code: "invalid-field",
        severity: "error",
        sourceId: source.sourceId,
        fieldPath: [key],
        message: "authored entries must be a dictionary"
      })
    } else if (key === "components") layer.components = value
    else layer.tokens = value as NonNullable<RationaleMap["tokens"]>
  }
  loaded.layers.push({ source, kind, locator, data: layer })
}
function addDiagnostic(health: GuidanceHealth, diagnostic: GuidanceDiagnostic): void {
  health.total++
  health.byCode[diagnostic.code] = (health.byCode[diagnostic.code] ?? 0) + 1
  const item = {
    ...diagnostic,
    message: safeDisplayText(diagnostic.message, GUIDANCE_LIMITS.messageBytes / 4),
    fieldPath: diagnostic.fieldPath
      .slice(0, GUIDANCE_LIMITS.fieldPathSegments)
      .map((part) => (typeof part === "number" || safeIdentifier(part) ? part : "invalid-key"))
  }
  if (
    health.items.length < GUIDANCE_LIMITS.diagnostics &&
    Buffer.byteLength(JSON.stringify({ ...health, items: [...health.items, item] })) <
      GUIDANCE_LIMITS.healthBytes - 8192
  )
    health.items.push(item)
  health.truncated = health.items.length < health.total
}
function dictionary(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}
function safeIdentifier(value: string): boolean {
  return (
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= GUIDANCE_LIMITS.referenceBytes &&
    isSafeNonEmptyIdentifier(value, GUIDANCE_LIMITS.referenceBytes)
  )
}
function own(record: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(record, key) !== undefined
}

function portableLocator(value: string): boolean {
  return (
    !value.includes("\\") &&
    !/^[a-zA-Z]:/.test(value) &&
    value.split("/").every((part) => part !== ".." && part !== "." && part.length > 0)
  )
}
