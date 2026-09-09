import { safeDisplayText, safeDisplayValue } from "../safe-display"
import type {
  Component,
  DemonstratedEvidence,
  DemonstratedStory,
  DemonstratedValue,
  PrimitivContract,
  PropDefinition,
  StorybookControlEvidence
} from "../types"

export interface ComponentApiPair {
  committedId: string
  freshId: string
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** Render an authoritative field path without making punctuation-bearing keys ambiguous. */
export function formatComponentFieldPath(path: string[]): string {
  let result = ""
  for (const segment of path) {
    if (IDENTIFIER.test(segment)) result += result ? `.${segment}` : segment
    else result += `[${JSON.stringify(segment)}]`
  }
  return safeDisplayText(result, 1_024)
}

/** Compare retained component API evidence for already reconciled logical component pairs. */
export function compareComponentApi(params: {
  committed: PrimitivContract
  fresh: PrimitivContract
  pairs: ComponentApiPair[]
  failedSources: Set<string>
}): string[] {
  const changes: string[] = []
  for (const pair of [...params.pairs].sort((a, b) => compareStrings(a.freshId, b.freshId))) {
    const oldComponent = ownValue(params.committed.components, pair.committedId)
    const newComponent = ownValue(params.fresh.components, pair.freshId)
    if (!oldComponent || !newComponent || pairUnavailable(params, oldComponent, newComponent)) continue
    const context: CompareContext = {
      id: pair.freshId,
      oldContract: params.committed,
      newContract: params.fresh,
      oldId: pair.committedId,
      newId: pair.freshId,
      changes
    }
    compareFormal(context, oldComponent, newComponent)
    compareUsage(context, oldComponent, newComponent)
    compareDemonstrated(context, oldComponent.demonstrated, newComponent.demonstrated)
  }
  return changes
}

interface CompareContext {
  id: string
  oldContract: PrimitivContract
  newContract: PrimitivContract
  oldId: string
  newId: string
  changes: string[]
}

function pairUnavailable(
  params: Parameters<typeof compareComponentApi>[0],
  oldComponent: Component,
  newComponent: Component
): boolean {
  const adapters = new Set([oldComponent.source.adapter, newComponent.source.adapter])
  for (const adapter of adapters) {
    if (
      params.failedSources.has(adapter) ||
      params.committed.sourceStatuses?.[adapter]?.status === "failed" ||
      params.fresh.sourceStatuses?.[adapter]?.status === "failed"
    )
      return true
  }
  return false
}

function compareFormal(context: CompareContext, oldComponent: Component, newComponent: Component): void {
  const names = unionKeys(oldComponent.props, newComponent.props)
  for (const name of names) {
    const oldProp = ownValue(oldComponent.props, name)
    const newProp = ownValue(newComponent.props, name)
    const propPath = ["props", name]
    if (!oldProp && newProp) {
      if (!diagnosticBlocks(context.newContract, context.newId, propPath))
        context.changes.push(`component prop added: ${prefix(context, propPath)}`)
      continue
    }
    if (oldProp && !newProp) {
      if (!diagnosticBlocks(context.newContract, context.newId, propPath))
        context.changes.push(`component prop removed: ${prefix(context, propPath)}`)
      continue
    }
    if (!oldProp || !newProp) continue

    compareFormalScalar(context, name, "type", oldProp, newProp)
    compareFormalScalar(context, name, "required", oldProp, newProp)
    compareFormalScalar(context, name, "default", oldProp, newProp)
    compareFormalScalar(context, name, "kind", oldProp, newProp)
    compareFormalSet(context, name, "values", oldProp, newProp)
    compareFormalSet(context, name, "preferredValues", oldProp, newProp)
  }
}

function compareFormalScalar(
  context: CompareContext,
  propName: string,
  field: "type" | "required" | "default" | "kind",
  oldProp: PropDefinition,
  newProp: PropDefinition
): void {
  const path = ["props", propName, field]
  const oldUnavailable = formalUnavailable(context.oldContract, context.oldId, oldProp, field, path)
  const newUnavailable = formalUnavailable(context.newContract, context.newId, newProp, field, path)
  compareValue(context, path, oldProp[field], newProp[field], oldUnavailable, newUnavailable)
}

function compareFormalSet(
  context: CompareContext,
  propName: string,
  field: "values" | "preferredValues",
  oldProp: PropDefinition,
  newProp: PropDefinition
): void {
  const path = ["props", propName, field]
  const oldUnavailable = formalUnavailable(context.oldContract, context.oldId, oldProp, field, path)
  const newUnavailable = formalUnavailable(context.newContract, context.newId, newProp, field, path)
  const canonical = (value: unknown) => {
    if (value === undefined) return undefined
    const items = (value as unknown[]).map((item) =>
      field === "preferredValues" ? { type: (item as { type: string }).type, key: (item as { key: string }).key } : item
    )
    return [...new Map(items.map((item) => [canonicalValue(item), item])).values()].sort((a, b) =>
      compareStrings(canonicalValue(a), canonicalValue(b))
    )
  }
  compareValue(context, path, canonical(oldProp[field]), canonical(newProp[field]), oldUnavailable, newUnavailable)
}

function formalUnavailable(
  contract: PrimitivContract,
  id: string,
  prop: PropDefinition,
  field: keyof PropDefinition,
  path: string[]
): boolean {
  return (
    (field === "values" && prop.incompleteFields?.includes("values")) ||
    (field === "type" &&
      (prop.unsupportedFields?.includes("type") ||
        ((prop.kind === "variant" || prop.kind === "instance-swap") &&
          prop.type?.trim() !== "string" &&
          prop.type?.trim() !== "number" &&
          prop.type?.trim() !== "boolean"))) ||
    diagnosticBlocks(contract, id, path)
  )
}

function compareUsage(context: CompareContext, oldComponent: Component, newComponent: Component): void {
  const names = [
    ...new Set([
      ...unionKeys(oldComponent.usage?.props, newComponent.usage?.props),
      ...(oldComponent.usage?.truncatedProps ?? []),
      ...(newComponent.usage?.truncatedProps ?? [])
    ])
  ].sort(compareStrings)
  const oldTruncated = new Set(oldComponent.usage?.truncatedProps ?? [])
  const newTruncated = new Set(newComponent.usage?.truncatedProps ?? [])
  for (const name of names) {
    const path = ["usage", "props", name]
    const oldValues = canonicalPrimitiveSet(ownValue(oldComponent.usage?.props, name) ?? [])
    const newValues = canonicalPrimitiveSet(ownValue(newComponent.usage?.props, name) ?? [])
    const oldKeys = new Set(oldValues.map(canonicalValue))
    const newKeys = new Set(newValues.map(canonicalValue))
    if (!oldTruncated.has(name)) {
      for (const value of newValues) if (!oldKeys.has(canonicalValue(value))) addObserved(context, path, "added", value)
    }
    if (!newTruncated.has(name)) {
      for (const value of oldValues)
        if (!newKeys.has(canonicalValue(value))) addObserved(context, path, "removed", value)
    }
    compareAvailability(context, path, oldTruncated.has(name), newTruncated.has(name))
  }
}

function compareDemonstrated(
  context: CompareContext,
  oldEvidence: DemonstratedEvidence | undefined,
  newEvidence: DemonstratedEvidence | undefined
): void {
  const root = ["demonstrated"]
  const oldAvailable = oldEvidence?.extraction === "source"
  const newAvailable = newEvidence?.extraction === "source"
  if (!oldAvailable || !newAvailable) {
    if (!oldAvailable && newAvailable && newEvidence) emitNewDemonstratedEvidence(context, newEvidence)
    else if (oldAvailable && !newAvailable) evidence(context, "unavailable", root)
    return
  }
  compareArgs(
    context,
    ["demonstrated", "defaultArgs"],
    oldEvidence,
    newEvidence,
    oldEvidence.incomplete,
    newEvidence.incomplete
  )
  compareControls(
    context,
    ["demonstrated", "controls"],
    oldEvidence.controls,
    newEvidence.controls,
    oldEvidence.incomplete,
    newEvidence.incomplete
  )

  const oldStories = storyMap(oldEvidence.stories)
  const newStories = storyMap(newEvidence.stories)
  for (const id of [...new Set([...oldStories.keys(), ...newStories.keys()])].sort(compareStrings)) {
    const oldStory = oldStories.get(id)
    const newStory = newStories.get(id)
    const path = ["demonstrated", "stories", id]
    if (!oldStory && newStory) {
      if (!oldEvidence.truncatedStories && !oldEvidence.incomplete && storyHasPropEvidence(newStory))
        evidence(context, "added", path)
      continue
    }
    if (oldStory && !newStory) {
      if (!newEvidence.truncatedStories && !newEvidence.incomplete && storyHasPropEvidence(oldStory))
        evidence(context, "removed", path)
      continue
    }
    if (!oldStory || !newStory) continue
    compareArgs(context, [...path, "args"], oldStory, newStory, oldEvidence.incomplete, newEvidence.incomplete)
    compareControls(
      context,
      [...path, "controls"],
      oldStory.controls,
      newStory.controls,
      oldEvidence.incomplete,
      newEvidence.incomplete
    )
  }
  compareAvailability(
    context,
    ["demonstrated", "stories"],
    Boolean(oldEvidence.truncatedStories),
    Boolean(newEvidence.truncatedStories)
  )
  compareAvailability(context, ["demonstrated"], Boolean(oldEvidence.incomplete), Boolean(newEvidence.incomplete))
}

function emitNewDemonstratedEvidence(context: CompareContext, demonstrated: DemonstratedEvidence): void {
  const before = context.changes.length
  for (const name of Object.keys(demonstrated.defaultArgs ?? {}).sort(compareStrings)) {
    evidence(context, "added", ["demonstrated", "defaultArgs", name])
  }
  emitNewControls(context, ["demonstrated", "controls"], demonstrated.controls)
  for (const story of [...(demonstrated.stories ?? [])].sort((left, right) => compareStrings(left.id, right.id))) {
    for (const name of Object.keys(story.args ?? {}).sort(compareStrings)) {
      evidence(context, "added", ["demonstrated", "stories", story.id, "args", name])
    }
    emitNewControls(context, ["demonstrated", "stories", story.id, "controls"], story.controls)
  }
  if (context.changes.length === before) evidence(context, "added", ["demonstrated"])
}

function emitNewControls(
  context: CompareContext,
  path: string[],
  controls: Record<string, StorybookControlEvidence> | undefined
): void {
  for (const name of Object.keys(controls ?? {}).sort(compareStrings)) {
    const control = ownValue(controls, name)
    if (control?.choices !== undefined) evidence(context, "added", [...path, name, "choices"])
  }
}

type ArgsEvidence =
  | {
      defaultArgs?: Record<string, DemonstratedValue>
      unresolvedDefaultArgs?: string[]
      truncatedDefaultArgs?: string[]
      hasUnresolvedDefaultArgsSpread?: boolean
    }
  | DemonstratedStory

function compareArgs(
  context: CompareContext,
  path: string[],
  oldOwner: ArgsEvidence,
  newOwner: ArgsEvidence,
  oldIncomplete = false,
  newIncomplete = false
): void {
  const defaults = path[1] === "defaultArgs"
  const oldArgs = defaults ? (oldOwner as DemonstratedEvidence).defaultArgs : (oldOwner as DemonstratedStory).args
  const newArgs = defaults ? (newOwner as DemonstratedEvidence).defaultArgs : (newOwner as DemonstratedStory).args
  const oldUnknown = new Set(
    defaults ? (oldOwner as DemonstratedEvidence).unresolvedDefaultArgs : (oldOwner as DemonstratedStory).unresolvedArgs
  )
  const newUnknown = new Set(
    defaults ? (newOwner as DemonstratedEvidence).unresolvedDefaultArgs : (newOwner as DemonstratedStory).unresolvedArgs
  )
  const oldTruncated = new Set(
    defaults ? (oldOwner as DemonstratedEvidence).truncatedDefaultArgs : (oldOwner as DemonstratedStory).truncatedArgs
  )
  const newTruncated = new Set(
    defaults ? (newOwner as DemonstratedEvidence).truncatedDefaultArgs : (newOwner as DemonstratedStory).truncatedArgs
  )
  const oldSpread = defaults
    ? (oldOwner as DemonstratedEvidence).hasUnresolvedDefaultArgsSpread
    : (oldOwner as DemonstratedStory).hasUnresolvedArgsSpread
  const newSpread = defaults
    ? (newOwner as DemonstratedEvidence).hasUnresolvedDefaultArgsSpread
    : (newOwner as DemonstratedStory).hasUnresolvedArgsSpread
  const names = [
    ...new Set([...unionKeys(oldArgs, newArgs), ...oldUnknown, ...newUnknown, ...oldTruncated, ...newTruncated])
  ].sort(compareStrings)
  for (const name of names) {
    const fieldPath = [...path, name]
    if (oldIncomplete === newIncomplete && oldIncomplete && (!hasOwn(oldArgs, name) || !hasOwn(newArgs, name))) {
      continue
    }
    const oldUnavailable = Boolean(
      oldUnknown.has(name) || oldTruncated.has(name) || ((oldSpread || oldIncomplete) && !hasOwn(oldArgs, name))
    )
    const newUnavailable = Boolean(
      newUnknown.has(name) || newTruncated.has(name) || ((newSpread || newIncomplete) && !hasOwn(newArgs, name))
    )
    compareValue(context, fieldPath, ownValue(oldArgs, name), ownValue(newArgs, name), oldUnavailable, newUnavailable)
  }
  compareAvailability(context, path, Boolean(oldSpread), Boolean(newSpread))
}

function compareControls(
  context: CompareContext,
  path: string[],
  oldControls: Record<string, StorybookControlEvidence> | undefined,
  newControls: Record<string, StorybookControlEvidence> | undefined,
  oldIncomplete = false,
  newIncomplete = false
): void {
  for (const name of unionKeys(oldControls, newControls)) {
    const fieldPath = [...path, name, "choices"]
    const oldControl = ownValue(oldControls, name)
    const newControl = ownValue(newControls, name)
    const oldChoices = choiceMap(oldControl)
    const newChoices = choiceMap(newControl)
    if (!oldIncomplete && !oldControl?.truncatedChoices && !oldControl?.unresolvedChoices) {
      for (const key of [...newChoices.keys()].sort(compareStrings)) {
        const choice = newChoices.get(key)
        if (!choice) continue
        if (!oldChoices.has(key)) demonstratedChoice(context, fieldPath, "added", choice.option)
      }
    }
    if (!newIncomplete && !newControl?.truncatedChoices && !newControl?.unresolvedChoices) {
      for (const key of [...oldChoices.keys()].sort(compareStrings)) {
        const choice = oldChoices.get(key)
        if (!choice) continue
        if (!newChoices.has(key)) demonstratedChoice(context, fieldPath, "removed", choice.option)
      }
    }
    for (const key of [...oldChoices.keys()].filter((value) => newChoices.has(value)).sort(compareStrings)) {
      const oldChoice = oldChoices.get(key)
      const newChoice = newChoices.get(key)
      if (!oldChoice || !newChoice) continue
      compareValue(
        context,
        [...fieldPath, canonicalValue(oldChoice.option), "mappedValue"],
        oldChoice.mappedValue,
        newChoice.mappedValue,
        Boolean(oldChoice.mappingUnresolved),
        Boolean(newChoice.mappingUnresolved)
      )
    }
    compareAvailability(
      context,
      fieldPath,
      Boolean(oldControl?.truncatedChoices || oldControl?.unresolvedChoices),
      Boolean(newControl?.truncatedChoices || newControl?.unresolvedChoices)
    )
  }
}

function choiceMap(control: StorybookControlEvidence | undefined) {
  const result = new Map<string, NonNullable<StorybookControlEvidence["choices"]>[number]>()
  for (const choice of [...(control?.choices ?? [])].sort((left, right) =>
    compareStrings(canonicalValue(left), canonicalValue(right))
  )) {
    const key = canonicalValue(choice.option)
    const existing = result.get(key)
    if (!existing) {
      result.set(key, choice)
      continue
    }
    const existingMapping = canonicalValue({
      unresolved: Boolean(existing.mappingUnresolved),
      present: existing.mappedValue !== undefined,
      value: existing.mappedValue
    })
    const choiceMapping = canonicalValue({
      unresolved: Boolean(choice.mappingUnresolved),
      present: choice.mappedValue !== undefined,
      value: choice.mappedValue
    })
    if (existingMapping !== choiceMapping) result.set(key, { option: choice.option, mappingUnresolved: true })
  }
  return result
}

function demonstratedChoice(
  context: CompareContext,
  path: string[],
  change: "added" | "removed",
  option: unknown
): void {
  context.changes.push(`component demonstrated choice ${change}: ${prefix(context, path)} (${displayValue(option)})`)
}

function compareValue(
  context: CompareContext,
  path: string[],
  oldValue: unknown,
  newValue: unknown,
  oldUnavailable: boolean,
  newUnavailable: boolean
): void {
  if (oldUnavailable || newUnavailable) {
    compareAvailability(context, path, oldUnavailable, newUnavailable)
    return
  }
  if (oldValue === undefined && newValue === undefined) return
  if (oldValue === undefined) {
    evidence(context, "added", path)
    return
  }
  if (newValue === undefined) {
    evidence(context, "removed", path)
    return
  }
  if (canonicalValue(oldValue) !== canonicalValue(newValue)) {
    context.changes.push(
      `component field changed: ${prefix(context, path)} (${displayValue(oldValue)} → ${displayValue(newValue)})`
    )
  }
}

function compareAvailability(
  context: CompareContext,
  path: string[],
  oldUnavailable: boolean,
  newUnavailable: boolean
): void {
  if (oldUnavailable === newUnavailable) return
  evidence(context, newUnavailable ? "unavailable" : "added", path)
}

function evidence(context: CompareContext, change: "added" | "removed" | "unavailable", path: string[]): void {
  context.changes.push(`component evidence ${change}: ${prefix(context, path)}`)
}

function addObserved(context: CompareContext, path: string[], change: "added" | "removed", value: unknown): void {
  context.changes.push(`component observed value ${change}: ${prefix(context, path)} (${displayValue(value)})`)
}

function prefix(context: CompareContext, path: string[]): string {
  return `${safeDisplayText(context.id, 512)} ${formatComponentFieldPath(path)}`
}

function diagnosticBlocks(contract: PrimitivContract, id: string, path: string[]): boolean {
  return (contract.comparisonDiagnostics?.items ?? []).some((diagnostic) => {
    // Identity ambiguity, within-adapter disagreement, and participant bounds concern
    // reconciliation across components. They cannot erase a durable component's own
    // retained before/after fact. A truncated diagnostic collection is likewise never
    // applied globally: new writers retain field-local prop markers even when the
    // diagnostic item cap hides the corresponding explanatory item.
    if (diagnostic.reason !== "incomplete-formal-evidence" && diagnostic.reason !== "unsupported-type-vocabulary")
      return false
    if (diagnostic.componentIds && !diagnostic.componentIds.includes(id)) return false
    const adapter = ownValue(contract.components, id)?.source.adapter
    if (!diagnostic.componentIds && diagnostic.adapters && (!adapter || !diagnostic.adapters.includes(adapter)))
      return false
    if (!diagnostic.fieldPath) {
      return path[path.length - 1] === (diagnostic.reason === "incomplete-formal-evidence" ? "values" : "type")
    }
    return pathsOverlap(diagnostic.fieldPath, path)
  })
}

function pathsOverlap(left: string[], right: string[]): boolean {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index++) if (left[index] !== right[index]) return false
  return true
}

function storyMap(stories: DemonstratedStory[] | undefined): Map<string, DemonstratedStory> {
  return new Map([...(stories ?? [])].sort((a, b) => compareStrings(a.id, b.id)).map((story) => [story.id, story]))
}

function storyHasPropEvidence(story: DemonstratedStory): boolean {
  return Boolean(
    Object.keys(story.args ?? {}).length ||
      story.unresolvedArgs?.length ||
      story.truncatedArgs?.length ||
      story.hasUnresolvedArgsSpread ||
      Object.values(story.controls ?? {}).some(
        (control) => control.choices !== undefined || control.unresolvedChoices || control.truncatedChoices
      )
  )
}

function canonicalPrimitiveSet(
  values: Array<string | number | boolean | null>
): Array<string | number | boolean | null> {
  return [...new Map(values.map((value) => [canonicalValue(value), value])).values()].sort((a, b) =>
    compareStrings(canonicalValue(a), canonicalValue(b))
  )
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`
  if (typeof value === "object") {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(object[key])}`)
      .join(",")}}`
  }
  return `${typeof value}:${JSON.stringify(value)}`
}

function displayValue(value: unknown): string {
  return safeDisplayValue(value as DemonstratedValue, 1_024)
}

function hasOwn(value: object | undefined, key: string): boolean {
  // biome-ignore lint/suspicious/noPrototypeBuiltins: the configured TS target predates Object.hasOwn.
  return value !== undefined && Object.prototype.hasOwnProperty.call(value, key)
}

function ownValue<T>(value: Record<string, T> | undefined, key: string): T | undefined {
  return hasOwn(value, key) ? value?.[key] : undefined
}

function unionKeys(left: object | undefined, right: object | undefined): string[] {
  return [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])].sort(compareStrings)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
