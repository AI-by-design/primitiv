import { createHash } from "node:crypto"
import type { PrimitivContract } from "../types"
import type { SnapshotOptions } from "./types"

export const SNAPSHOT_VERSION = "discovery-v1"

/** Object key order is incidental; all array order and remote observation evidence remain meaningful. */
export function createSnapshotId(contract: PrimitivContract, options: SnapshotOptions = {}): string {
  const canonical = canonicalize(contract, options.temporaryRoots ?? [], [], new Set())
  return `${SNAPSHOT_VERSION}:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`
}

const DERIVED_FIELDS = new Set(["generatedAt", "componentNameIndex", "discoveryIndex"])
function canonicalize(value: unknown, roots: readonly string[], path: string[], ancestors: Set<object>): unknown {
  if (typeof value === "string") {
    if (!isPathField(path)) return value
    const normalized = value.split("\\").join("/")
    for (const root of [...roots].map((item) => item.split("\\").join("/").replace(/\/+$/, "")).sort(longestFirst)) {
      if (root && (normalized === root || normalized.startsWith(`${root}/`))) {
        return `<temporary-root>${normalized.slice(root.length)}`
      }
    }
    return value
  }
  if (value === null || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "undefined") return undefined
  if (typeof value !== "object") throw new TypeError("Discovery snapshots require JSON-compatible canonical data.")
  if (ancestors.has(value)) throw new TypeError("Discovery snapshots cannot contain cycles.")
  ancestors.add(value)
  let result: unknown
  if (Array.isArray(value)) {
    const items = value.map((item, index) => canonicalize(item, roots, [...path, String(index)], ancestors))
    result =
      path.length === 4 && path[0] === "components" && path[2] === "classification" && path[3] === "intents"
        ? [...new Set(items)].sort()
        : items
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new TypeError("Discovery snapshots require plain JSON objects.")
    }
    result = Object.fromEntries(
      Object.keys(value)
        .filter((key) => path.length !== 0 || !DERIVED_FIELDS.has(key))
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key], roots, [...path, key], ancestors)])
    )
  }
  ancestors.delete(value)
  return result
}

function isPathField(path: string[]): boolean {
  const field = path[path.length - 1]
  const parent = path[path.length - 2]
  return (
    (path.length === 1 && (field === "sourceRoot" || field === "configPath")) ||
    (parent === "source" && field === "file") ||
    (parent === "guidanceOrigin" && field === "locator") ||
    (field === "importPath" && path.includes("demonstrated") && path.includes("stories"))
  )
}

function longestFirst(a: string, b: string): number {
  return b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)
}
