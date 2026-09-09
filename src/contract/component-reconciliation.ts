import { type PrimitiveValue, primitiveValueKey, sortPrimitiveValues } from "../normalize/component-evidence-values"
import { safeDisplayText, safeDisplayValue, structuredValueText } from "../safe-display"
import { isSafeNonEmptyIdentifier, isWithinDurableParticipantBounds } from "../safe-identifier"
import { deriveEffectiveStoryArgs, type StaticArgsEvidence } from "../sources/storybook/effectiveArgs"
import type {
  ComparisonDiagnostic,
  ComparisonDiagnostics,
  Component,
  ComponentMap,
  ComponentMapping,
  Conflict,
  ConflictEvidence,
  ConflictStructuredValue,
  DemonstratedValue,
  PrimitivConfig,
  SourceAdapter,
  SourceStatus
} from "../types"

const SOURCE_ADAPTERS: SourceAdapter[] = ["codebase", "figma", "storybook"]
const MAX_CONFLICT_EVIDENCE = 100
const MAX_COMPARISON_DIAGNOSTIC_ITEMS = 100

interface ComponentMember {
  id: string
  component: Component
}

export interface ComponentReconciliationGroup {
  name: string
  members: ComponentMember[]
  explicitlyMapped: boolean
}

interface ComponentFact {
  componentId: string
  adapter: SourceAdapter
  fieldPath: string[]
  factPath: string[]
  role: "formal" | "observed" | "demonstrated"
  value: ConflictStructuredValue
  source: Component["source"]
}

interface ConsensusFact {
  adapter: SourceAdapter
  fieldPath: string[]
  value: ConflictStructuredValue
  facts: ComponentFact[]
}

/** Resolve explicit durable mappings, then build remaining exact-name groups. */
export function componentReconciliationGroups(
  components: ComponentMap,
  nameIndex: Record<string, string[]>,
  mappings: ComponentMapping[] = [],
  sourceStatuses?: Record<string, SourceStatus>
): ComponentReconciliationGroup[] {
  const groups: ComponentReconciliationGroup[] = []
  const mappedIds = new Set<string>()

  for (const [index, mapping] of mappings.entries()) {
    const declaredAdapters = SOURCE_ADAPTERS.filter((adapter) => mapping[adapter] !== undefined)
    if (declaredAdapters.length < 2) {
      throw new Error(`Invalid reconciliation.componentMappings[${index}]: at least two adapters are required.`)
    }
    const members: ComponentMember[] = []
    for (const adapter of declaredAdapters) {
      const id = mapping[adapter]
      if (id === undefined) continue
      if (mappedIds.has(id)) {
        throw new Error(
          `Invalid reconciliation.componentMappings[${index}]: component '${safeDisplayText(id)}' appears in more than one mapping.`
        )
      }
      // Keep every declared ID reserved even when its adapter is temporarily
      // unavailable, so the surviving candidate cannot fall back into a guessed
      // display-name association with another source.
      mappedIds.add(id)
      const component = components[id]
      if (!component) {
        if (sourceStatuses?.[adapter]?.status === "failed") continue
        throw new Error(
          `Invalid reconciliation.componentMappings[${index}]: component '${safeDisplayText(id)}' does not exist.`
        )
      }
      if (component.source.adapter !== adapter) {
        throw new Error(
          `Invalid reconciliation.componentMappings[${index}]: '${safeDisplayText(id)}' belongs to ` +
            `'${component.source.adapter}', not '${adapter}'.`
        )
      }
      members.push({ id, component })
    }
    if (members.length >= 2) {
      members.sort(compareMembers)
      groups.push({ name: preferredGroupName(members), members, explicitlyMapped: true })
    }
  }

  for (const name of Object.keys(nameIndex).sort(compareStrings)) {
    const members = (nameIndex[name] ?? [])
      .filter((id) => !mappedIds.has(id))
      .map((id) => ({ id, component: components[id] }))
      .filter((member): member is ComponentMember => member.component !== undefined)
      .sort(compareMembers)
    if (new Set(members.map((member) => member.component.source.adapter)).size < 2) continue
    groups.push({ name, members, explicitlyMapped: false })
  }

  return groups.sort((a, b) => compareStrings(a.name, b.name) || compareMembers(a.members[0], b.members[0]))
}

/** Produce deterministic field conflicts for mapped, unique, and consensus facts. */
export function reconcileComponentFields(params: {
  groups: ComponentReconciliationGroup[]
  config: PrimitivConfig
  sourceStatuses?: Record<string, SourceStatus>
}): Conflict[] {
  return reconcileComponentFieldsWithDiagnostics(params).conflicts
}

/** Reconcile fields and retain bounded reasons for comparisons that could not run. */
export function reconcileComponentFieldsWithDiagnostics(params: {
  groups: ComponentReconciliationGroup[]
  config: PrimitivConfig
  sourceStatuses?: Record<string, SourceStatus>
}): { conflicts: Conflict[]; comparisonDiagnostics?: ComparisonDiagnostics } {
  const conflicts: Conflict[] = []
  const diagnostics: ComparisonDiagnostic[] = []
  for (const group of params.groups) {
    const healthyGroup = {
      ...group,
      members: group.members.filter((member) => {
        const status = params.sourceStatuses?.[member.component.source.adapter]?.status
        return status === undefined || status === "ok"
      })
    }
    if (new Set(healthyGroup.members.map((member) => member.component.source.adapter)).size < 2) continue
    const consensus = formalConsensus(healthyGroup)
    diagnostics.push(...comparisonDiagnosticsForGroup(healthyGroup, consensus))
    const groupConflicts = exactConflicts(healthyGroup, consensus, params.config, params.sourceStatuses)
    conflicts.push(...retainBoundedConflicts({ conflicts: groupConflicts, group: healthyGroup, diagnostics }))
    if (healthyGroup.explicitlyMapped || everyAdapterIsUnique(healthyGroup)) {
      const subset = subsetConflicts(healthyGroup, consensus, params.config, params.sourceStatuses)
      conflicts.push(...retainBoundedConflicts({ conflicts: subset, group: healthyGroup, diagnostics }))
    } else if (hasSkippedIdentityComparison(healthyGroup)) {
      diagnostics.push(identityDiagnostic(healthyGroup))
    }
  }
  const comparisonDiagnostics = canonicalizeComparisonDiagnostics(diagnostics)
  return {
    conflicts: conflicts.sort(compareConflicts),
    ...(comparisonDiagnostics.total > 0 ? { comparisonDiagnostics } : {})
  }
}

/** Canonicalize, deduplicate, count, and bound diagnostics for persistence and comparison. */
function canonicalizeComparisonDiagnostics(items: ComparisonDiagnostic[]): ComparisonDiagnostics {
  const normalized = items.map(normalizeDiagnostic).sort(compareDiagnostics)
  const distinct = [...new Map(normalized.map((item) => [diagnosticKey(item), item])).values()]
  const retained = distinct.slice(0, MAX_COMPARISON_DIAGNOSTIC_ITEMS)
  const byReason: ComparisonDiagnostics["byReason"] = {}
  for (const item of distinct) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1
  return {
    total: distinct.length,
    truncated: retained.length < distinct.length,
    byReason,
    items: retained
  }
}

function formalConsensus(group: ComponentReconciliationGroup): Map<SourceAdapter, Map<string, ConsensusFact>> {
  const byAdapter = membersByAdapter(group.members)
  const result = new Map<SourceAdapter, Map<string, ConsensusFact>>()

  for (const adapter of SOURCE_ADAPTERS) {
    const members = byAdapter.get(adapter) ?? []
    if (members.length === 0) continue
    const factMaps = members.map((member) => formalFacts(member))
    const firstFacts = factMaps[0]
    const adapterConsensus = new Map<string, ConsensusFact>()
    // A complete consensus path must exist on the first candidate and every
    // other candidate. Starting from that intersection avoids rescanning every
    // candidate for every disjoint path in a large ambiguous name group.
    for (const key of [...firstFacts.keys()].sort(compareStrings)) {
      const facts = factMaps.map((map) => map.get(key))
      if (facts.some((fact) => fact === undefined)) continue
      const complete = facts as ComponentFact[]
      const valueKeys = new Set(complete.map((fact) => structuredValueText(fact.value)))
      if (valueKeys.size !== 1) continue
      adapterConsensus.set(key, {
        adapter,
        fieldPath: complete[0].fieldPath,
        value: complete[0].value,
        facts: complete.sort(compareFacts)
      })
    }
    result.set(adapter, adapterConsensus)
  }

  return result
}

function comparisonDiagnosticsForGroup(
  group: ComponentReconciliationGroup,
  consensus: Map<SourceAdapter, Map<string, ConsensusFact>>
): ComparisonDiagnostic[] {
  const diagnostics: ComparisonDiagnostic[] = []
  const byAdapter = membersByAdapter(group.members)
  const fieldAdapters = formalFieldAdapters(group)

  for (const adapter of SOURCE_ADAPTERS) {
    const members = byAdapter.get(adapter) ?? []
    if (members.length > 1) {
      const byPath = formalFactsByPath(members)
      for (const key of [...byPath.keys()].sort(compareStrings)) {
        const present = byPath.get(key) ?? []
        if (present.length < 2 || new Set(present.map((fact) => structuredValueText(fact.value))).size < 2) continue
        if ((fieldAdapters.get(key)?.size ?? 0) < 2) continue
        diagnostics.push({
          type: "could-not-compare",
          reason: "within-adapter-disagreement",
          name: group.name,
          adapters: [adapter],
          componentIds: present.map((fact) => fact.componentId),
          fieldPath: present[0].fieldPath
        })
      }
    }
  }

  for (const member of group.members) {
    for (const propName of Object.keys(member.component.props ?? {}).sort(compareStrings)) {
      const definition = member.component.props?.[propName]
      if (!definition) continue
      if (
        definition.incompleteFields?.includes("values") &&
        hasComparableField({ consensus, member, propName, field: "values" })
      ) {
        diagnostics.push(
          fieldDiagnostic({ group, member, propName, field: "values", reason: "incomplete-formal-evidence" })
        )
      }
      const unsupportedType =
        definition.unsupportedFields?.includes("type") ||
        definition.kind === "variant" ||
        definition.kind === "instance-swap"
      const normalizedType = definition.type?.trim()
      const hasSupportedType =
        normalizedType === "string" || normalizedType === "number" || normalizedType === "boolean"
      if (unsupportedType && !hasSupportedType && hasComparableField({ consensus, member, propName, field: "type" })) {
        diagnostics.push(
          fieldDiagnostic({ group, member, propName, field: "type", reason: "unsupported-type-vocabulary" })
        )
      }
    }
  }
  return diagnostics
}

function hasComparableField({
  consensus,
  member,
  propName,
  field
}: {
  consensus: Map<SourceAdapter, Map<string, ConsensusFact>>
  member: ComponentMember
  propName: string
  field: "type" | "values"
}): boolean {
  const key = pathKey(["props", propName, field])
  return SOURCE_ADAPTERS.some(
    (adapter) => adapter !== member.component.source.adapter && consensus.get(adapter)?.has(key) === true
  )
}

function fieldDiagnostic({
  group,
  member,
  propName,
  field,
  reason
}: {
  group: ComponentReconciliationGroup
  member: ComponentMember
  propName: string
  field: "type" | "values"
  reason: ComparisonDiagnostic["reason"]
}): ComparisonDiagnostic {
  return {
    type: "could-not-compare",
    reason,
    name: group.name,
    adapters: [member.component.source.adapter],
    componentIds: [member.id],
    fieldPath: ["props", propName, field]
  }
}

function identityDiagnostic(group: ComponentReconciliationGroup): ComparisonDiagnostic {
  return {
    type: "could-not-compare",
    reason: "ambiguous-identity",
    ...(isSafeNonEmptyIdentifier(group.name) ? { name: group.name } : {}),
    adapters: sortedAdapters(group.members.map((member) => member.component.source.adapter)),
    componentIds: sortedUnique(group.members.map((member) => member.id))
  }
}

function hasSkippedIdentityComparison(group: ComponentReconciliationGroup): boolean {
  const fieldAdapters = formalFieldAdapters(group)
  for (const members of membersByAdapter(group.members).values()) {
    if (members.length < 2) continue
    for (const [key, facts] of formalFactsByPath(members)) {
      const presentCount = facts.length
      if (presentCount === 0 || presentCount === members.length) continue
      if ((fieldAdapters.get(key)?.size ?? 0) > 1) return true
    }
  }

  const domains = group.members.flatMap((member) =>
    [...formalFacts(member).values()].filter(
      (fact) => fact.fieldPath[fact.fieldPath.length - 1] === "values" && Array.isArray(fact.value)
    )
  )
  return group.members.some((member) =>
    observationalFacts(member).some((observation) =>
      domains.some(
        (domain) =>
          domain.adapter !== observation.adapter && pathKey(domain.fieldPath) === pathKey(observation.fieldPath)
      )
    )
  )
}

function formalFieldAdapters(group: ComponentReconciliationGroup): Map<string, Set<SourceAdapter>> {
  const result = new Map<string, Set<SourceAdapter>>()
  for (const member of group.members) {
    for (const key of formalFacts(member).keys()) {
      const adapters = result.get(key) ?? new Set<SourceAdapter>()
      adapters.add(member.component.source.adapter)
      result.set(key, adapters)
    }
  }
  return result
}

function formalFactsByPath(members: ComponentMember[]): Map<string, ComponentFact[]> {
  const result = new Map<string, ComponentFact[]>()
  for (const member of members) {
    for (const [key, fact] of formalFacts(member)) {
      const current = result.get(key) ?? []
      current.push(fact)
      result.set(key, current)
    }
  }
  return result
}

function retainBoundedConflicts({
  conflicts,
  group,
  diagnostics
}: {
  conflicts: Conflict[]
  group: ComponentReconciliationGroup
  diagnostics: ComparisonDiagnostic[]
}): Conflict[] {
  const retained: Conflict[] = []
  for (const conflict of conflicts) {
    const ids = conflict.componentIds ?? []
    if (isWithinDurableParticipantBounds(ids)) {
      retained.push(conflict)
      continue
    }
    diagnostics.push({
      type: "could-not-compare",
      reason: "participant-bound-exceeded",
      name: group.name,
      adapters: sortedAdapters(group.members.map((member) => member.component.source.adapter)),
      fieldPath: conflict.fieldPath
    })
  }
  return retained
}

function normalizeDiagnostic(item: ComparisonDiagnostic): ComparisonDiagnostic {
  const componentIds = item.componentIds ? sortedUnique(item.componentIds) : undefined
  return {
    type: "could-not-compare",
    reason: item.reason,
    ...(item.name !== undefined && isSafeNonEmptyIdentifier(item.name) ? { name: item.name } : {}),
    ...(item.adapters ? { adapters: sortedAdapters(item.adapters) } : {}),
    ...(componentIds && isWithinDurableParticipantBounds(componentIds) ? { componentIds } : {}),
    ...(item.fieldPath ? { fieldPath: [...item.fieldPath] } : {})
  }
}

function diagnosticKey(item: ComparisonDiagnostic): string {
  return JSON.stringify([
    item.reason,
    item.adapters ?? [],
    item.componentIds ?? [],
    item.componentIds === undefined ? (item.name ?? "") : "",
    item.fieldPath ?? []
  ])
}

function compareDiagnostics(a: ComparisonDiagnostic, b: ComparisonDiagnostic): number {
  return compareStrings(diagnosticKey(a), diagnosticKey(b)) || compareStrings(a.name ?? "", b.name ?? "")
}

function sortedAdapters(adapters: SourceAdapter[]): SourceAdapter[] {
  return [...new Set(adapters)].sort(compareStrings)
}

function exactConflicts(
  group: ComponentReconciliationGroup,
  consensus: Map<SourceAdapter, Map<string, ConsensusFact>>,
  config: PrimitivConfig,
  sourceStatuses?: Record<string, SourceStatus>
): Conflict[] {
  const paths = new Set([...consensus.values()].flatMap((facts) => [...facts.keys()]))
  const conflicts: Conflict[] = []
  for (const key of [...paths].sort(compareStrings)) {
    const comparable = SOURCE_ADAPTERS.map((adapter) => consensus.get(adapter)?.get(key)).filter(
      (fact): fact is ConsensusFact => fact !== undefined
    )
    if (comparable.length < 2) continue
    if (new Set(comparable.map((fact) => structuredValueText(fact.value))).size < 2) continue

    const facts = dedupeFacts(comparable.flatMap((fact) => fact.facts)).sort(compareFacts)
    const retainedFacts = retainExactConflictFacts(facts)
    const sources = retainedFacts.map(conflictEvidence).sort(compareEvidence)
    const fieldPath = comparable[0].fieldPath
    const fieldResolution = governedResolution(comparable, fieldPath, config, sourceStatuses)
    conflicts.push({
      type: "component",
      name: group.name,
      scope: "cross-source",
      fieldPath,
      componentIds: sortedUnique(facts.map((fact) => fact.componentId)),
      comparison: "exact",
      sources,
      evidenceTotal: facts.length,
      ...(retainedFacts.length < facts.length ? { evidenceTruncated: true } : {}),
      ...(fieldResolution ? { fieldResolution } : {}),
      resolution: "pending",
      actionable: fieldResolution !== undefined,
      suggestedFix: fieldFixMessage(group.name, fieldPath, fieldResolution !== undefined)
    })
  }
  return conflicts
}

function subsetConflicts(
  group: ComponentReconciliationGroup,
  consensus: Map<SourceAdapter, Map<string, ConsensusFact>>,
  config: PrimitivConfig,
  sourceStatuses?: Record<string, SourceStatus>
): Conflict[] {
  const domains = new Map<string, ComponentFact[]>()
  for (const member of group.members) {
    for (const fact of formalFacts(member).values()) {
      if (fact.fieldPath[fact.fieldPath.length - 1] !== "values" || !Array.isArray(fact.value)) continue
      const key = pathKey(fact.fieldPath)
      const current = domains.get(key) ?? []
      current.push(fact)
      domains.set(key, current)
    }
  }

  const accumulators = new Map<string, Map<string, ComponentFact>>()
  for (const member of group.members) {
    for (const observation of observationalFacts(member)) {
      const key = pathKey(observation.fieldPath)
      for (const domain of domains.get(key) ?? []) {
        if (
          domain.adapter === observation.adapter ||
          !Array.isArray(domain.value) ||
          domainContains(domain.value, observation.value)
        ) {
          continue
        }
        let accumulator = accumulators.get(key)
        if (!accumulator) {
          accumulator = new Map<string, ComponentFact>()
          accumulators.set(key, accumulator)
        }
        accumulator.set(factKey(domain), domain)
        accumulator.set(factKey(observation), observation)
      }
    }
  }

  const conflicts: Conflict[] = []
  for (const key of [...accumulators.keys()].sort(compareStrings)) {
    const comparableDomains = SOURCE_ADAPTERS.map((adapter) => consensus.get(adapter)?.get(key)).filter(
      (fact): fact is ConsensusFact => fact !== undefined && Array.isArray(fact.value)
    )
    // Include every formal domain that participated in the comparison, including
    // an authoritative domain that accepts the observation while another source
    // rejects it. Component-local projections then retain the governed conflict.
    const facts = dedupeFacts([
      ...(accumulators.get(key)?.values() ?? []),
      ...comparableDomains.flatMap((domain) => domain.facts)
    ]).sort(compareFacts)
    if (facts.length === 0) continue
    const fieldPath = facts[0].fieldPath
    const retainedFacts = retainSubsetConflictFacts(facts)
    const sources = retainedFacts.map(conflictEvidence).sort(compareEvidence)
    const fieldResolution = governedResolution(comparableDomains, fieldPath, config, sourceStatuses)
    conflicts.push({
      type: "component",
      name: group.name,
      scope: "cross-source",
      fieldPath,
      componentIds: sortedUnique(facts.map((fact) => fact.componentId)),
      comparison: "subset",
      sources,
      evidenceTotal: facts.length,
      ...(retainedFacts.length < facts.length ? { evidenceTruncated: true } : {}),
      ...(fieldResolution ? { fieldResolution } : {}),
      resolution: "pending",
      actionable: fieldResolution !== undefined,
      suggestedFix: fieldFixMessage(group.name, fieldPath, fieldResolution !== undefined)
    })
  }
  return conflicts
}

function formalFacts(member: ComponentMember): Map<string, ComponentFact> {
  const facts = new Map<string, ComponentFact>()
  for (const propName of Object.keys(member.component.props ?? {}).sort(compareStrings)) {
    const definition = member.component.props?.[propName]
    if (!definition) continue
    const base = ["props", propName]
    const type = definition.type?.trim()
    if (type === "string" || type === "number" || type === "boolean") {
      addFact(facts, member, [...base, "type"], type)
    }
    if (definition.required !== undefined) addFact(facts, member, [...base, "required"], definition.required)
    if (definition.default !== undefined) addFact(facts, member, [...base, "default"], definition.default)
    if (definition.values !== undefined) {
      addFact(facts, member, [...base, "values"], sortPrimitiveValues(definition.values))
    }
  }
  return facts
}

function addFact(
  facts: Map<string, ComponentFact>,
  member: ComponentMember,
  fieldPath: string[],
  value: ConflictStructuredValue
): void {
  facts.set(pathKey(fieldPath), {
    componentId: member.id,
    adapter: member.component.source.adapter,
    fieldPath,
    factPath: fieldPath,
    role: "formal",
    value,
    source: member.component.source
  })
}

function observationalFacts(member: ComponentMember): ComponentFact[] {
  const facts: ComponentFact[] = []
  for (const propName of Object.keys(member.component.usage?.props ?? {}).sort(compareStrings)) {
    for (const value of member.component.usage?.props?.[propName] ?? []) {
      facts.push({
        componentId: member.id,
        adapter: member.component.source.adapter,
        fieldPath: ["props", propName, "values"],
        factPath: ["usage", "props", propName],
        role: "observed",
        value,
        source: member.component.source
      })
    }
  }

  const demonstrated = member.component.demonstrated
  if (!demonstrated) return facts.sort(compareFacts)
  const meta: StaticArgsEvidence = {
    args: demonstrated.defaultArgs,
    unresolvedArgs: demonstrated.unresolvedDefaultArgs,
    truncatedArgs: demonstrated.truncatedDefaultArgs,
    hasUnresolvedArgsSpread: demonstrated.hasUnresolvedDefaultArgsSpread
  }
  addArgsFacts(facts, member, demonstrated.defaultArgs, ["demonstrated", "defaultArgs"])
  addControlFacts(facts, member, demonstrated.controls, ["demonstrated", "controls"])
  for (const story of demonstrated.stories ?? []) {
    const effective = deriveEffectiveStoryArgs(meta, story)
    addArgsFacts(facts, member, effective.args, ["demonstrated", "stories", story.id, "args"])
    addControlFacts(facts, member, story.controls, ["demonstrated", "stories", story.id, "controls"])
  }
  return dedupeFacts(facts).sort(compareFacts)
}

function addArgsFacts(
  facts: ComponentFact[],
  member: ComponentMember,
  args: Record<string, DemonstratedValue> | undefined,
  basePath: string[]
): void {
  for (const propName of Object.keys(args ?? {}).sort(compareStrings)) {
    const value = args?.[propName]
    if (!isPrimitive(value)) continue
    facts.push({
      componentId: member.id,
      adapter: member.component.source.adapter,
      fieldPath: ["props", propName, "values"],
      factPath: [...basePath, propName],
      role: "demonstrated",
      value,
      source: member.component.source
    })
  }
}

function addControlFacts(
  facts: ComponentFact[],
  member: ComponentMember,
  controls: NonNullable<Component["demonstrated"]>["controls"] | undefined,
  basePath: string[]
): void {
  for (const propName of Object.keys(controls ?? {}).sort(compareStrings)) {
    const control = controls?.[propName]
    for (const [index, choice] of (control?.choices ?? []).entries()) {
      const value = choice.mappingUnresolved
        ? undefined
        : choice.mappedValue === undefined
          ? choice.option
          : choice.mappedValue
      if (!isPrimitive(value)) continue
      facts.push({
        componentId: member.id,
        adapter: member.component.source.adapter,
        fieldPath: ["props", propName, "values"],
        factPath: [...basePath, propName, "choices", String(index)],
        role: "demonstrated",
        value,
        source: member.component.source
      })
    }
  }
}

function governedResolution(
  consensus: ConsensusFact[],
  fieldPath: string[],
  config: PrimitivConfig,
  sourceStatuses?: Record<string, SourceStatus>
): Conflict["fieldResolution"] | undefined {
  const sourceOfTruth = config.governance.sourceOfTruth
  if (sourceOfTruth === "manual") return undefined
  if (sourceStatuses?.[sourceOfTruth]?.status === "failed") return undefined
  const authoritative = consensus.filter((fact) => fact.adapter === sourceOfTruth)
  if (authoritative.length !== 1) return undefined
  return {
    adapter: sourceOfTruth,
    componentIds: authoritative[0].facts.map((fact) => fact.componentId).sort(compareStrings),
    fieldPath,
    structuredValue: authoritative[0].value
  }
}

function conflictEvidence(fact: ComponentFact): ConflictEvidence {
  return {
    source: fact.source,
    value: safeDisplayValue(fact.value),
    structuredValue: fact.value,
    componentId: fact.componentId,
    factPath: fact.factPath
  }
}

function fieldFixMessage(name: string, fieldPath: string[], governed: boolean): string {
  const subject = safeDisplayText(name)
  const path = safeDisplayText(fieldPath.map((segment) => JSON.stringify(segment)).join(" / "))
  return governed
    ? `Component field disagreement for '${subject}' at ${path}. Review the labelled source evidence and align non-authoritative sources with the configured source of truth.`
    : `Component field disagreement for '${subject}' at ${path}. Review the labelled source evidence and choose the intended value or source of truth.`
}

function membersByAdapter(members: ComponentMember[]): Map<SourceAdapter, ComponentMember[]> {
  const result = new Map<SourceAdapter, ComponentMember[]>()
  for (const member of members) {
    const adapter = member.component.source.adapter
    const current = result.get(adapter) ?? []
    current.push(member)
    result.set(adapter, current)
  }
  return result
}

function everyAdapterIsUnique(group: ComponentReconciliationGroup): boolean {
  return [...membersByAdapter(group.members).values()].every((members) => members.length === 1)
}

function preferredGroupName(members: ComponentMember[]): string {
  return members.map((member) => member.component.displayName ?? member.component.name).sort(compareStrings)[0]
}

function domainContains(domain: ConflictStructuredValue[], value: ConflictStructuredValue): boolean {
  if (!isPrimitive(value)) return false
  return domain.some((candidate) => isPrimitive(candidate) && primitiveValueKey(candidate) === primitiveValueKey(value))
}

function isPrimitive(value: unknown): value is PrimitiveValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

function pathKey(path: string[]): string {
  return JSON.stringify(path)
}

function factKey(fact: ComponentFact): string {
  return `${fact.adapter}\u0000${fact.componentId}\u0000${pathKey(fact.factPath)}\u0000${structuredValueText(fact.value)}`
}

function dedupeFacts(facts: ComponentFact[]): ComponentFact[] {
  return [...new Map(facts.map((fact) => [factKey(fact), fact])).values()]
}

/** Retain the exact-comparison proof core, then fill canonically. */
function retainExactConflictFacts(facts: ComponentFact[]): ComponentFact[] {
  const ordered = dedupeFacts(facts).sort(compareFacts)
  if (ordered.length <= MAX_CONFLICT_EVIDENCE) return ordered

  const retained = new Map<string, ComponentFact>()
  const representedAdapters = new Set<SourceAdapter>()
  for (const fact of ordered) {
    if (representedAdapters.has(fact.adapter)) continue
    retained.set(factKey(fact), fact)
    representedAdapters.add(fact.adapter)
  }

  const representedValues = new Set<string>()
  for (const fact of ordered) {
    const valueKey = structuredValueText(fact.value)
    if (representedValues.has(valueKey)) continue
    representedValues.add(valueKey)
    if (retained.size < MAX_CONFLICT_EVIDENCE) retained.set(factKey(fact), fact)
  }

  // Exact conflicts are created only when at least two value classes exist.
  // Keep that proof explicit even if a future adapter vocabulary grows enough
  // for the reservations above to consume the whole budget.
  const retainedValues = new Set([...retained.values()].map((fact) => structuredValueText(fact.value)))
  if (retainedValues.size < 2) {
    const firstRetained = retained.values().next().value
    const secondValue = firstRetained
      ? ordered.find((fact) => structuredValueText(fact.value) !== structuredValueText(firstRetained.value))
      : undefined
    if (secondValue) {
      if (retained.size >= MAX_CONFLICT_EVIDENCE) {
        throw new Error("Component conflict proof core exceeds the retained evidence bound.")
      }
      retained.set(factKey(secondValue), secondValue)
    }
  }

  fillRetainedCanonically({ ordered, retained })
  return [...retained.values()].sort(compareFacts)
}

/** Retain formal adapters and an offender, then rotate value buckets. */
function retainSubsetConflictFacts(facts: ComponentFact[]): ComponentFact[] {
  const ordered = dedupeFacts(facts).sort(compareFacts)
  if (ordered.length <= MAX_CONFLICT_EVIDENCE) return ordered

  const retained = new Map<string, ComponentFact>()
  const representedFormalAdapters = new Set<SourceAdapter>()
  for (const fact of ordered) {
    if (fact.role !== "formal" || representedFormalAdapters.has(fact.adapter)) continue
    retained.set(factKey(fact), fact)
    representedFormalAdapters.add(fact.adapter)
  }
  const offender = ordered.find((fact) => fact.role !== "formal")
  if (offender) retained.set(factKey(offender), offender)

  const buckets = new Map<string, ComponentFact[]>()
  for (const fact of ordered) {
    if (retained.has(factKey(fact))) continue
    const key = `${fact.role}\u0000${fact.adapter}\u0000${structuredValueText(fact.value)}`
    const bucket = buckets.get(key) ?? []
    bucket.push(fact)
    buckets.set(key, bucket)
  }

  const bucketKeys = [...buckets.keys()].sort(compareStrings)
  let added = true
  while (retained.size < MAX_CONFLICT_EVIDENCE && added) {
    added = false
    for (const key of bucketKeys) {
      if (retained.size >= MAX_CONFLICT_EVIDENCE) break
      const fact = buckets.get(key)?.shift()
      if (!fact) continue
      retained.set(factKey(fact), fact)
      added = true
    }
  }

  fillRetainedCanonically({ ordered, retained })
  return [...retained.values()].sort(compareFacts)
}

interface CanonicalRetentionFill {
  ordered: ComponentFact[]
  retained: Map<string, ComponentFact>
}

function fillRetainedCanonically({ ordered, retained }: CanonicalRetentionFill): void {
  for (const fact of ordered) {
    if (retained.size >= MAX_CONFLICT_EVIDENCE) return
    retained.set(factKey(fact), fact)
  }
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort(compareStrings)
}

function compareMembers(a: ComponentMember | undefined, b: ComponentMember | undefined): number {
  if (a === undefined) return b === undefined ? 0 : -1
  if (b === undefined) return 1
  return compareStrings(a.component.source.adapter, b.component.source.adapter) || compareStrings(a.id, b.id)
}

function compareFacts(a: ComponentFact, b: ComponentFact): number {
  return (
    compareStrings(a.adapter, b.adapter) ||
    compareStrings(a.componentId, b.componentId) ||
    compareStrings(pathKey(a.factPath), pathKey(b.factPath)) ||
    compareStrings(structuredValueText(a.value), structuredValueText(b.value))
  )
}

function compareEvidence(a: ConflictEvidence, b: ConflictEvidence): number {
  return (
    compareStrings(a.source.adapter, b.source.adapter) ||
    compareStrings(a.componentId ?? "", b.componentId ?? "") ||
    compareStrings(pathKey(a.factPath ?? []), pathKey(b.factPath ?? [])) ||
    compareStrings(a.value, b.value)
  )
}

function compareConflicts(a: Conflict, b: Conflict): number {
  return (
    compareStrings(a.name, b.name) ||
    compareStrings(pathKey(a.fieldPath ?? []), pathKey(b.fieldPath ?? [])) ||
    compareStrings(a.comparison ?? "", b.comparison ?? "") ||
    compareStrings(a.scope ?? "", b.scope ?? "") ||
    compareStrings(JSON.stringify(a.componentIds ?? []), JSON.stringify(b.componentIds ?? []))
  )
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
