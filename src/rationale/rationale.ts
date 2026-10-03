import * as fs from "node:fs"
import * as path from "node:path"
import * as YAML from "yaml"
import type { ComponentMap, PrimitivConfig, RationaleMap, TokenMap } from "../types"

const DEFAULT_SIDECAR = "primitiv.rationale.yml"

/**
 * Load rationale from two possible sources, merging with inline taking precedence:
 * 1. Sidecar YAML file (default: primitiv.rationale.yml next to the config)
 * 2. `config.rationale.inline` — inline rationale in primitiv.config.js
 *
 * Merges authored keys only; builds use loadRationaleLayers so aliases cannot
 * reverse source precedence after binding. Returns an empty map when absent.
 */
export function loadRationale(config: PrimitivConfig, configDir: string): RationaleMap {
  const merged: RationaleMap = { tokens: {}, components: {} }
  for (const layer of loadRationaleLayers(config, configDir)) mergeInto(merged, layer)
  return merged
}

/**
 * Keep source precedence until entries have bound to their resolved identities.
 * A merged authored-key map cannot preserve precedence when an ID and a display
 * name refer to the same component. Apply these layers in order, inline last.
 * This is internal build plumbing; loadRationale retains its map-shaped result.
 */
export function loadRationaleLayers(config: PrimitivConfig, configDir: string): RationaleMap[] {
  const layers: RationaleMap[] = []
  const sidecarPath = resolveSidecarPath(config, configDir)
  if (sidecarPath && fs.existsSync(sidecarPath)) {
    try {
      const raw = fs.readFileSync(sidecarPath, "utf-8")
      const parsed = YAML.parse(raw) as RationaleMap | null
      if (parsed && typeof parsed === "object") {
        const layer: RationaleMap = { tokens: {}, components: {} }
        mergeInto(layer, parsed)
        layers.push(layer)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`primitiv: could not parse rationale at ${sidecarPath} — ${msg}\n`)
    }
  }

  if (config.rationale?.inline) {
    const layer: RationaleMap = { tokens: {}, components: {} }
    mergeInto(layer, config.rationale.inline)
    layers.push(layer)
  }
  return layers
}

/**
 * Attach rationale entries to tokens and components in-place.
 * Token keys use dotted paths ("colors.primary" → tokens.colors.primary).
 * Component keys are either a qualified id ("components/ui/Card") or a bare
 * display name ("Card"); a bare name only applies when exactly one component
 * carries it — an ambiguous bare name applies to nothing and comes back as a
 * warning telling the user to qualify by id, since each same-name component
 * needs its own `when` for lookup-time resolution to mean anything.
 * Unknown keys are silently ignored — lets rationale files drift ahead of
 * the contract without breaking the build.
 */
export function applyRationale(tokens: TokenMap, components: ComponentMap, rationale: RationaleMap): string[] {
  const warnings: string[] = []
  if (rationale.tokens) {
    for (const [dottedKey, value] of Object.entries(rationale.tokens)) {
      const dotIdx = dottedKey.indexOf(".")
      if (dotIdx === -1) continue
      const category = dottedKey.slice(0, dotIdx)
      const name = dottedKey.slice(dotIdx + 1)
      if (!category || !name) continue
      const categoryTokens = hasOwnKey(tokens, category) ? tokens[category] : undefined
      const token = categoryTokens && hasOwnKey(categoryTokens, name) ? categoryTokens[name] : undefined
      if (token) token.rationale = value
    }
  }
  if (rationale.components) {
    const byName: Record<string, string[]> = Object.create(null)
    for (const [id, component] of Object.entries(components)) {
      const name = component.displayName ?? component.name
      if (!byName[name]) byName[name] = []
      byName[name].push(id)
    }
    for (const [key, value] of Object.entries(rationale.components)) {
      if (hasOwnKey(components, key)) {
        components[key].rationale = value
        continue
      }
      const ids = byName[key] ?? []
      if (ids.length === 1) {
        components[ids[0]].rationale = value
      } else if (ids.length > 1) {
        warnings.push(
          `rationale key '${key}' matches ${ids.length} components (${ids.join(", ")}) — ` +
            `not applied. Qualify it with a component id so each gets its own rationale.`
        )
      }
    }
  }
  return warnings
}

function resolveSidecarPath(config: PrimitivConfig, configDir: string): string | null {
  const configured = config.rationale?.path
  if (configured) return path.resolve(configDir, configured)
  const defaultPath = path.resolve(configDir, DEFAULT_SIDECAR)
  return fs.existsSync(defaultPath) ? defaultPath : null
}

function mergeInto(target: RationaleMap, source: RationaleMap): void {
  if (source.tokens && typeof source.tokens === "object") {
    target.tokens = { ...(target.tokens ?? {}), ...source.tokens }
  }
  if (source.components && typeof source.components === "object") {
    target.components = { ...(target.components ?? {}), ...source.components }
  }
}

function hasOwnKey(record: object, key: PropertyKey): boolean {
  return Object.getOwnPropertyDescriptor(record, key) !== undefined
}
