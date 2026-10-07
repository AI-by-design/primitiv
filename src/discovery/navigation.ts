import type { Component, PrimitivContract } from "../types"
import { createSnapshotId } from "./snapshot"
import type { ClassificationCoverage, DiscoveryIndex, SnapshotOptions } from "./types"

/** The caller must validate imported canonical records before indexing; loose JSON is not a trusted contract. */
export function createDiscoveryIndex(contract: PrimitivContract, options: SnapshotOptions = {}): DiscoveryIndex {
  const snapshotId = createSnapshotId(contract, options)
  // The caller can keep building or reloading its own object without changing this loaded revision.
  const canonical: PrimitivContract = JSON.parse(JSON.stringify(contract))
  const ids = Object.keys(canonical.components).sort()
  const byKind: Record<string, string[]> = Object.create(null)
  const byLevel: Record<string, string[]> = Object.create(null)
  const byIntent: Record<string, string[]> = Object.create(null)
  const usedBy: Record<string, Record<string, number>> = Object.create(null)
  for (const id of ids) {
    const component = canonical.components[id]
    if (component.classification?.intents) {
      component.classification.intents = [...new Set(component.classification.intents)].sort()
    }
    append(byKind, component.kind ?? "unknown", id)
    if (component.classification?.atomicLevel) append(byLevel, component.classification.atomicLevel, id)
    for (const intent of new Set(component.classification?.intents ?? [])) append(byIntent, intent, id)
    for (const [target, count] of Object.entries(component.uses ?? {})) {
      if (!Object.getOwnPropertyDescriptor(canonical.components, target)) continue
      usedBy[target] ??= Object.create(null)
      usedBy[target][id] = count
    }
  }
  return deepFreeze({ snapshotId, contract: canonical, ids, byKind, byLevel, byIntent, usedBy })
}

export function classificationCoverage(index: DiscoveryIndex, ids: readonly string[]): ClassificationCoverage {
  let withLevel = 0
  let withIntents = 0
  let complete = 0
  for (const id of ids) {
    const classification = index.contract.components[id].classification
    const level = classification?.atomicLevel !== undefined
    const intents = (classification?.intents?.length ?? 0) > 0
    withLevel += Number(level)
    withIntents += Number(intents)
    complete += Number(level && intents)
  }
  return {
    total: ids.length,
    withLevel,
    withIntents,
    complete,
    missingLevel: ids.length - withLevel,
    missingIntents: ids.length - withIntents,
    missingEither: ids.length - complete
  }
}

export function matchesScope(id: string, component: Component, context: string): boolean {
  const noFragment = id.split("#")[0]
  const directory = component.scope ?? noFragment.slice(0, Math.max(0, noFragment.lastIndexOf("/")))
  const candidate = pathSegments(directory)
  const working = pathSegments(context)
  if (candidate.length === 0) return false
  return working.some((_, start) => candidate.every((segment, offset) => working[start + offset] === segment))
}

export function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== "." && segment !== "..")
}

function append(index: Record<string, string[]>, key: string, id: string): void {
  index[key] ??= []
  index[key].push(id)
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}
