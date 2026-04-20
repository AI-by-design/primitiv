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
 * Returns an empty RationaleMap if neither is present — rationale is always optional.
 */
export function loadRationale(config: PrimitivConfig, configDir: string): RationaleMap {
  const merged: RationaleMap = { tokens: {}, components: {} }

  const sidecarPath = resolveSidecarPath(config, configDir)
  if (sidecarPath && fs.existsSync(sidecarPath)) {
    try {
      const raw = fs.readFileSync(sidecarPath, "utf-8")
      const parsed = YAML.parse(raw) as RationaleMap | null
      if (parsed && typeof parsed === "object") mergeInto(merged, parsed)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`primitiv: could not parse rationale at ${sidecarPath} — ${msg}\n`)
    }
  }

  if (config.rationale?.inline) {
    mergeInto(merged, config.rationale.inline)
  }

  return merged
}

/**
 * Attach rationale entries to tokens and components in-place.
 * Token keys use dotted paths ("colors.primary" → tokens.colors.primary).
 * Component keys use the component name as it appears in the contract.
 * Unknown keys are silently ignored — lets rationale files drift ahead of
 * the contract without breaking the build.
 */
export function applyRationale(tokens: TokenMap, components: ComponentMap, rationale: RationaleMap): void {
  if (rationale.tokens) {
    for (const [dottedKey, value] of Object.entries(rationale.tokens)) {
      const dotIdx = dottedKey.indexOf(".")
      if (dotIdx === -1) continue
      const category = dottedKey.slice(0, dotIdx)
      const name = dottedKey.slice(dotIdx + 1)
      if (!category || !name) continue
      const token = tokens[category]?.[name]
      if (token) token.rationale = value
    }
  }
  if (rationale.components) {
    for (const [name, value] of Object.entries(rationale.components)) {
      const component = components[name]
      if (component) component.rationale = value
    }
  }
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
