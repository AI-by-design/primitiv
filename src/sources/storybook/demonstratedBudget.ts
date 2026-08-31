import type {
  DemonstratedEvidence,
  DemonstratedStory,
  DemonstratedValue,
  StorybookControlChoice,
  StorybookControlEvidence
} from "../../types"
import { MAX_DEMONSTRATED_BYTES_PER_COMPONENT, MAX_OMISSION_MARKER_NAMES } from "./limits"

/** Retain demonstrated evidence in canonical order under the component budget. */
export function boundDemonstratedEvidence(
  evidence: DemonstratedEvidence,
  maxBytes = MAX_DEMONSTRATED_BYTES_PER_COMPONENT
): DemonstratedEvidence {
  const reserveStoryTruncation = Boolean(evidence.truncatedStories || evidence.stories?.length)
  const bounded: DemonstratedEvidence = {
    title: evidence.title,
    extraction: evidence.extraction,
    storyCount: evidence.storyCount,
    ...(reserveStoryTruncation ? { truncatedStories: true } : {})
  }

  copyArgs(
    bounded,
    "defaultArgs",
    "truncatedDefaultArgs",
    evidence.defaultArgs,
    evidence.truncatedDefaultArgs,
    maxBytes
  )
  copyMarkers(bounded, "unresolvedDefaultArgs", evidence.unresolvedDefaultArgs, maxBytes)
  if (evidence.hasUnresolvedDefaultArgsSpread) trySet(bounded, "hasUnresolvedDefaultArgsSpread", true, maxBytes)

  const controls = copyControls(bounded, "controls", evidence.controls, maxBytes)
  if (Object.keys(controls).length === 0) delete bounded.controls

  const retainedStories: DemonstratedStory[] = []
  for (const source of [...(evidence.stories ?? [])].sort(compareStories)) {
    const story: DemonstratedStory = { id: source.id }
    const candidateStories = [...retainedStories, story]
    bounded.stories = candidateStories
    if (!withinBudget(bounded, maxBytes)) {
      if (retainedStories.length > 0) bounded.stories = retainedStories
      else delete bounded.stories
      break
    }
    retainedStories.push(story)

    tryOptionalStoryField(bounded, story, retainedStories, "name", source.name, maxBytes)
    tryOptionalStoryField(bounded, story, retainedStories, "exportName", source.exportName, maxBytes)
    tryOptionalStoryField(bounded, story, retainedStories, "importPath", source.importPath, maxBytes)
    copyStoryArgs(bounded, story, retainedStories, source, maxBytes)
    copyStoryMarkers(bounded, story, retainedStories, "unresolvedArgs", source.unresolvedArgs, maxBytes)
    if (source.hasUnresolvedArgsSpread) {
      tryStorySet(bounded, story, retainedStories, "hasUnresolvedArgsSpread", true, maxBytes)
    }
    copyStoryControls(bounded, story, retainedStories, source.controls, maxBytes)
  }

  if (retainedStories.length === 0) delete bounded.stories
  const storiesTruncated = Boolean(
    evidence.truncatedStories || retainedStories.length < (evidence.stories?.length ?? 0)
  )
  if (!storiesTruncated) delete bounded.truncatedStories
  return bounded
}

function copyArgs<T extends DemonstratedEvidence>(
  target: T,
  valueKey: "defaultArgs",
  markerKey: "truncatedDefaultArgs",
  source: Record<string, DemonstratedValue> | undefined,
  existingMarkers: string[] | undefined,
  maxBytes: number
): void {
  const values = Object.create(null) as Record<string, DemonstratedValue>
  const markers = new Set(existingMarkers ?? [])
  for (const key of Object.keys(source ?? {}).sort(compareStrings)) {
    values[key] = source?.[key] as DemonstratedValue
    target[valueKey] = values
    if (!withinBudget(target, maxBytes)) {
      delete values[key]
      markers.add(key)
    }
  }
  if (Object.keys(values).length === 0) delete target[valueKey]
  copyMarkers(target, markerKey, [...markers], maxBytes)
}

function copyStoryArgs(
  root: DemonstratedEvidence,
  target: DemonstratedStory,
  stories: DemonstratedStory[],
  source: DemonstratedStory,
  maxBytes: number
): void {
  const values = Object.create(null) as Record<string, DemonstratedValue>
  const markers = new Set(source.truncatedArgs ?? [])
  for (const key of Object.keys(source.args ?? {}).sort(compareStrings)) {
    values[key] = source.args?.[key] as DemonstratedValue
    target.args = values
    root.stories = stories
    if (!withinBudget(root, maxBytes)) {
      delete values[key]
      markers.add(key)
    }
  }
  if (Object.keys(values).length === 0) delete target.args
  copyStoryMarkers(root, target, stories, "truncatedArgs", [...markers], maxBytes)
}

function copyMarkers<T extends DemonstratedEvidence>(
  target: T,
  key: "unresolvedDefaultArgs" | "truncatedDefaultArgs",
  source: string[] | undefined,
  maxBytes: number
): void {
  const markers: string[] = []
  for (const name of [...new Set(source ?? [])].sort(compareStrings).slice(0, MAX_OMISSION_MARKER_NAMES)) {
    markers.push(name)
    target[key] = markers
    if (!withinBudget(target, maxBytes)) {
      markers.pop()
      break
    }
  }
  if (markers.length === 0) delete target[key]
}

function copyStoryMarkers(
  root: DemonstratedEvidence,
  target: DemonstratedStory,
  stories: DemonstratedStory[],
  key: "unresolvedArgs" | "truncatedArgs",
  source: string[] | undefined,
  maxBytes: number
): void {
  const markers: string[] = []
  for (const name of [...new Set(source ?? [])].sort(compareStrings).slice(0, MAX_OMISSION_MARKER_NAMES)) {
    markers.push(name)
    target[key] = markers
    root.stories = stories
    if (!withinBudget(root, maxBytes)) {
      markers.pop()
      break
    }
  }
  if (markers.length === 0) delete target[key]
}

function copyControls(
  root: DemonstratedEvidence,
  key: "controls",
  source: Record<string, StorybookControlEvidence> | undefined,
  maxBytes: number
): Record<string, StorybookControlEvidence> {
  const target = Object.create(null) as Record<string, StorybookControlEvidence>
  for (const name of Object.keys(source ?? {}).sort(compareStrings)) {
    const control = boundedControl(source?.[name] as StorybookControlEvidence, (candidate) => {
      target[name] = candidate
      root[key] = target
      return withinBudget(root, maxBytes)
    })
    if (control) target[name] = control
    else delete target[name]
  }
  return target
}

function copyStoryControls(
  root: DemonstratedEvidence,
  story: DemonstratedStory,
  stories: DemonstratedStory[],
  source: Record<string, StorybookControlEvidence> | undefined,
  maxBytes: number
): void {
  const target = Object.create(null) as Record<string, StorybookControlEvidence>
  for (const name of Object.keys(source ?? {}).sort(compareStrings)) {
    const control = boundedControl(source?.[name] as StorybookControlEvidence, (candidate) => {
      target[name] = candidate
      story.controls = target
      root.stories = stories
      return withinBudget(root, maxBytes)
    })
    if (control) target[name] = control
    else delete target[name]
  }
  if (Object.keys(target).length === 0) delete story.controls
}

function boundedControl(
  source: StorybookControlEvidence,
  retain: (candidate: StorybookControlEvidence) => boolean
): StorybookControlEvidence | undefined {
  const target: StorybookControlEvidence = {}
  if (source.control !== undefined) {
    target.control = source.control
    if (!retain(target)) delete target.control
  }
  if (source.unresolvedChoices) {
    target.unresolvedChoices = true
    if (!retain(target)) delete target.unresolvedChoices
  }

  const choices: StorybookControlChoice[] = []
  let aggregateTruncated = Boolean(source.truncatedChoices)
  for (const choice of source.choices ?? []) {
    choices.push(choice)
    target.choices = choices
    if (!retain(target)) {
      choices.pop()
      aggregateTruncated = true
      break
    }
  }
  if (choices.length === 0) delete target.choices
  if (aggregateTruncated) {
    target.truncatedChoices = true
    if (!retain(target)) delete target.truncatedChoices
  }
  return Object.keys(target).length > 0 ? target : undefined
}

function tryOptionalStoryField<K extends "name" | "exportName" | "importPath">(
  root: DemonstratedEvidence,
  story: DemonstratedStory,
  stories: DemonstratedStory[],
  key: K,
  value: DemonstratedStory[K],
  maxBytes: number
): void {
  if (value === undefined) return
  tryStorySet(root, story, stories, key, value, maxBytes)
}

function tryStorySet<K extends keyof DemonstratedStory>(
  root: DemonstratedEvidence,
  story: DemonstratedStory,
  stories: DemonstratedStory[],
  key: K,
  value: DemonstratedStory[K],
  maxBytes: number
): boolean {
  story[key] = value
  root.stories = stories
  if (withinBudget(root, maxBytes)) return true
  delete story[key]
  return false
}

function trySet<K extends keyof DemonstratedEvidence>(
  target: DemonstratedEvidence,
  key: K,
  value: DemonstratedEvidence[K],
  maxBytes: number
): boolean {
  target[key] = value
  if (withinBudget(target, maxBytes)) return true
  delete target[key]
  return false
}

function withinBudget(value: DemonstratedEvidence, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes
}

function compareStories(a: DemonstratedStory, b: DemonstratedStory): number {
  return (
    compareStrings(a.id, b.id) ||
    compareStrings(a.exportName ?? "", b.exportName ?? "") ||
    compareStrings(a.name ?? "", b.name ?? "") ||
    compareStrings(a.importPath ?? "", b.importPath ?? "")
  )
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
