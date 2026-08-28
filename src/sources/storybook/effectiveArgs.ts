import type { DemonstratedValue } from "../../types"

export interface StaticArgsEvidence {
  args?: Record<string, DemonstratedValue>
  unresolvedArgs?: string[]
  truncatedArgs?: string[]
  hasUnresolvedArgsSpread?: boolean
}

/**
 * Derive the locally provable meta + story args without claiming Storybook's
 * project, URL, enhancer, loader, or render-time composition.
 */
export function deriveEffectiveStoryArgs(meta: StaticArgsEvidence, story: StaticArgsEvidence): StaticArgsEvidence {
  const values = Object.create(null) as Record<string, DemonstratedValue>
  const unresolved = new Set<string>()
  const truncated = new Set<string>()

  if (!story.hasUnresolvedArgsSpread) {
    copyValues(values, meta.args)
    for (const key of meta.unresolvedArgs ?? []) unresolved.add(key)
    for (const key of meta.truncatedArgs ?? []) truncated.add(key)
  }

  for (const key of story.unresolvedArgs ?? []) {
    delete values[key]
    truncated.delete(key)
    unresolved.add(key)
  }
  for (const key of story.truncatedArgs ?? []) {
    delete values[key]
    unresolved.delete(key)
    truncated.add(key)
  }
  for (const key of Object.keys(story.args ?? {}).sort(compareStrings)) {
    values[key] = story.args?.[key] as DemonstratedValue
    unresolved.delete(key)
    truncated.delete(key)
  }

  const sortedValues = sortedValueMap(values)
  const unresolvedArgs = [...unresolved].sort(compareStrings)
  const truncatedArgs = [...truncated].sort(compareStrings)
  return {
    ...(Object.keys(sortedValues).length > 0 ? { args: sortedValues } : {}),
    ...(unresolvedArgs.length > 0 ? { unresolvedArgs } : {}),
    ...(truncatedArgs.length > 0 ? { truncatedArgs } : {}),
    ...(meta.hasUnresolvedArgsSpread || story.hasUnresolvedArgsSpread ? { hasUnresolvedArgsSpread: true } : {})
  }
}

function copyValues(target: Record<string, DemonstratedValue>, source?: Record<string, DemonstratedValue>): void {
  for (const key of Object.keys(source ?? {}).sort(compareStrings)) {
    target[key] = source?.[key] as DemonstratedValue
  }
}

function sortedValueMap(values: Record<string, DemonstratedValue>): Record<string, DemonstratedValue> {
  const sorted = Object.create(null) as Record<string, DemonstratedValue>
  for (const key of Object.keys(values).sort(compareStrings)) sorted[key] = values[key]
  return sorted
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
