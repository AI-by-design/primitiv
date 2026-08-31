import { parse } from "@babel/parser"
import type * as t from "@babel/types"
import {
  comparePrimitiveValues,
  type PrimitiveValue,
  primitiveValueKey,
  retainSmallestPrimitiveValues
} from "../../normalize/component-evidence-values"
import type { DemonstratedValue, PropDefinition, StorybookControlChoice, StorybookControlEvidence } from "../../types"
import {
  MAX_CONTROL_CHOICES,
  MAX_METADATA_STRING_BYTES,
  MAX_OMISSION_MARKER_NAMES,
  MAX_SERIALIZED_VALUE_BYTES,
  MAX_STATIC_BINDING_DEPTH,
  MAX_STATIC_COLLECTION_ENTRIES,
  MAX_STATIC_RECURSION_DEPTH
} from "./limits"
import { createStaticValueContext, evaluateStaticValue, type StaticValueContext } from "./staticValue"

export interface ParsedArgsEvidence {
  values?: Record<string, DemonstratedValue>
  unresolvedKeys?: string[]
  truncatedKeys?: string[]
  hasUnresolvedSpread?: boolean
}

export interface ParsedStoryEvidence extends ParsedArgsEvidence {
  exportName: string
  name?: string
  customId?: string
  controls?: Record<string, StorybookControlEvidence>
}

export interface ParsedStorybookSource extends ParsedArgsEvidence {
  title?: string
  metaId?: string
  props: Record<string, PropDefinition>
  controls?: Record<string, StorybookControlEvidence>
  stories: ParsedStoryEvidence[]
}

interface ObjectProperties {
  properties: Map<string, t.ObjectProperty | t.ObjectMethod>
  hasUnknownWrite: boolean
}

interface StoryCandidate {
  exportName: string
  localName: string
  node?: t.Node | null
}

interface StoryAssignments {
  args?: t.Node
  argTypes?: t.Node
  name?: t.Node
  customId?: t.Node
  parameters?: t.Node
  story?: t.Node
}

export function parseStorybookSource(source: string): ParsedStorybookSource {
  const file = parse(source, {
    sourceType: "unambiguous",
    plugins: ["typescript", "jsx"]
  })
  const program = file.program
  const context = createStaticValueContext(program, {
    maxDepth: MAX_STATIC_RECURSION_DEPTH,
    maxEntries: MAX_STATIC_COLLECTION_ENTRIES,
    maxBytes: MAX_SERIALIZED_VALUE_BYTES
  })
  const meta = findMeta(program, context)
  const metaFields = meta ? objectProperties(meta, context) : undefined
  const metaArgs = argsEvidence(fieldNode(metaFields, "args"), context)
  const metaArgTypes = parseArgTypesNode(fieldNode(metaFields, "argTypes"), context)
  const assignments = collectStoryAssignments(program)
  const candidates = collectStoryCandidates(program, context)
  const composedArgs = new Map<string, ParsedArgsEvidence>()
  const stories: ParsedStoryEvidence[] = []
  for (const candidate of candidates) {
    const story = parseStoryCandidate(
      candidate,
      candidate.node ? assignments.get(candidate.localName) : undefined,
      context,
      composedArgs
    )
    if (!story) continue
    stories.push(story)
    const args = storyArgsEvidence(story)
    composedArgs.set(candidate.localName, args)
    composedArgs.set(candidate.exportName, args)
  }
  stories.sort(compareParsedStories)

  return {
    ...(staticString(fieldNode(metaFields, "title"), context) !== undefined
      ? { title: staticString(fieldNode(metaFields, "title"), context) }
      : {}),
    ...(staticString(fieldNode(metaFields, "id"), context) !== undefined
      ? { metaId: staticString(fieldNode(metaFields, "id"), context) }
      : {}),
    props: metaArgTypes.props,
    ...(metaArgTypes.controls ? { controls: metaArgTypes.controls } : {}),
    ...metaArgs,
    stories
  }
}

/** Compute the only source-derived ID accepted for an exact manifest join. */
export function storybookStoryId(
  source: Pick<ParsedStorybookSource, "metaId">,
  story: Pick<ParsedStoryEvidence, "customId" | "exportName">,
  manifestTitle: string
): string | undefined {
  if (story.customId) return story.customId
  const kind = sanitizeStorybookIdPart(source.metaId ?? manifestTitle)
  const name = sanitizeStorybookIdPart(storyNameFromExport(story.exportName))
  return kind && name ? `${kind}--${name}` : undefined
}

export function matchParsedStory(
  source: ParsedStorybookSource,
  manifestTitle: string,
  manifestId: string
): ParsedStoryEvidence | undefined {
  const matches = source.stories.filter((story) => storybookStoryId(source, story, manifestTitle) === manifestId)
  return matches.length === 1 ? matches[0] : undefined
}

function findMeta(program: t.Program, context: StaticValueContext): t.ObjectExpression | undefined {
  for (const statement of program.body) {
    if (statement.type !== "ExportDefaultDeclaration") continue
    const resolved = resolveObjectOrFactoryMeta(statement.declaration, context)
    if (resolved) return resolved
  }

  // CSF factories do not default-export metadata: `const meta = preview.meta({…})`.
  let factoryMeta: t.ObjectExpression | undefined
  for (const [name, binding] of context.bindings) {
    const call = unwrap(binding)
    if (call.type !== "CallExpression" || !isNamedMemberCall(call, "meta")) continue
    const first = call.arguments[0]
    if (!first || first.type === "SpreadElement" || first.type === "ArgumentPlaceholder") continue
    const resolved = resolveObject(first, context)
    if (!resolved || !factoryStoryUses(program, name)) continue
    if (factoryMeta) return undefined
    factoryMeta = resolved
  }
  return factoryMeta
}

function resolveObjectOrFactoryMeta(node: t.Node, context: StaticValueContext): t.ObjectExpression | undefined {
  const resolved = resolveNode(node, context)
  if (resolved.type === "ObjectExpression") return resolved
  if (resolved.type !== "CallExpression" || !isNamedMemberCall(resolved, "meta")) return undefined
  const first = resolved.arguments[0]
  if (!first || first.type === "SpreadElement" || first.type === "ArgumentPlaceholder") return undefined
  return resolveObject(first, context)
}

function factoryStoryUses(program: t.Program, metaName: string): boolean {
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (declaration?.type !== "VariableDeclaration") continue
    for (const item of declaration.declarations) {
      const init = item.init && unwrap(item.init)
      if (
        init?.type === "CallExpression" &&
        init.callee.type === "MemberExpression" &&
        !init.callee.computed &&
        init.callee.object.type === "Identifier" &&
        init.callee.object.name === metaName &&
        init.callee.property.type === "Identifier" &&
        init.callee.property.name === "story"
      )
        return true
    }
  }
  return false
}

function collectStoryCandidates(program: t.Program, context: StaticValueContext): StoryCandidate[] {
  const candidates: StoryCandidate[] = []
  const seen = new Set<string>()
  const localDeclarations = collectLocalDeclarations(program)
  const add = (exportName: string, localName: string, node?: t.Node | null): void => {
    const key = `${exportName}\0${localName}`
    if (seen.has(key) || !boundedMetadataString(exportName)) return
    seen.add(key)
    candidates.push({ exportName, localName, node })
  }

  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.exportKind === "type") continue
    if (statement.declaration?.type === "VariableDeclaration") {
      for (const declaration of statement.declaration.declarations) {
        if (declaration.id.type === "Identifier") {
          add(
            declaration.id.name,
            declaration.id.name,
            statement.declaration.kind === "const" ? declaration.init : undefined
          )
        }
      }
    } else if (statement.declaration?.type === "FunctionDeclaration" && statement.declaration.id) {
      add(statement.declaration.id.name, statement.declaration.id.name, statement.declaration)
    } else if (!statement.source) {
      for (const specifier of statement.specifiers) {
        if (specifier.type !== "ExportSpecifier" || specifier.exportKind === "type") continue
        const localName = nameOfModuleExport(specifier.local)
        const exportName = nameOfModuleExport(specifier.exported)
        if (localName && exportName && exportName !== "default")
          add(exportName, localName, localDeclarations.get(localName) ?? context.bindings.get(localName))
      }
    }
  }
  return candidates
}

function collectLocalDeclarations(program: t.Program): Map<string, t.Node> {
  const declarations = new Map<string, t.Node>()
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") {
      for (const item of declaration.declarations) {
        if (item.id.type === "Identifier" && item.init) declarations.set(item.id.name, item.init)
      }
    } else if (declaration?.type === "FunctionDeclaration" && declaration.id) {
      declarations.set(declaration.id.name, declaration)
    }
  }
  return declarations
}

function collectStoryAssignments(program: t.Program): Map<string, StoryAssignments> {
  const assignments = new Map<string, StoryAssignments>()
  for (const statement of program.body) {
    if (statement.type !== "ExpressionStatement" || statement.expression.type !== "AssignmentExpression") continue
    const assignment = statement.expression
    if (assignment.operator !== "=" || assignment.left.type !== "MemberExpression") continue
    const member = assignment.left
    if (member.object.type !== "Identifier") continue
    const key = memberName(member)
    if (!key) continue
    const target = assignments.get(member.object.name) ?? {}
    if (key === "args") target.args = assignment.right
    else if (key === "argTypes") target.argTypes = assignment.right
    else if (key === "storyName" || key === "name") target.name = assignment.right
    else if (key === "__id") target.customId = assignment.right
    else if (key === "parameters") target.parameters = assignment.right
    else if (key === "story") target.story = assignment.right
    else continue
    assignments.set(member.object.name, target)
  }
  return assignments
}

function parseStoryCandidate(
  candidate: StoryCandidate,
  assignment: StoryAssignments | undefined,
  context: StaticValueContext,
  composedArgs: ReadonlyMap<string, ParsedArgsEvidence>
): ParsedStoryEvidence | undefined {
  let storyObject = storyObjectFrom(candidate.node, context)
  // A present but dynamic `.story` assignment replaces the initializer at
  // runtime. Do not retain fields from the initializer as if they survived.
  if (assignment?.story) storyObject = resolveObject(assignment.story, context)
  const fields = storyObject ? objectProperties(storyObject, context) : undefined
  const assignmentStoryFields = assignment?.story
    ? objectProperties(resolveObject(assignment.story, context), context)
    : undefined
  const argsNode = assignment?.args ?? fieldNode(assignmentStoryFields, "args") ?? fieldNode(fields, "args")
  const argTypesNode =
    assignment?.argTypes ?? fieldNode(assignmentStoryFields, "argTypes") ?? fieldNode(fields, "argTypes")
  const argTypes = parseArgTypesNode(argTypesNode, context)
  const name = staticString(
    assignment?.name ?? fieldNode(assignmentStoryFields, "name") ?? fieldNode(fields, "name"),
    context
  )
  const directCustomId = staticString(
    assignment?.customId ?? fieldNode(assignmentStoryFields, "__id") ?? fieldNode(fields, "__id"),
    context
  )
  const parametersNode =
    assignment?.parameters ?? fieldNode(assignmentStoryFields, "parameters") ?? fieldNode(fields, "parameters")
  const legacyCustomId = staticString(
    fieldNode(objectProperties(resolveObject(parametersNode, context), context), "__id"),
    context
  )

  return {
    exportName: candidate.exportName,
    ...(name !== undefined ? { name } : {}),
    ...((directCustomId ?? legacyCustomId) ? { customId: directCustomId ?? legacyCustomId } : {}),
    ...argsEvidence(argsNode, context, composedArgs),
    ...(argTypes.controls ? { controls: argTypes.controls } : {})
  }
}

function storyObjectFrom(node: t.Node | null | undefined, context: StaticValueContext): t.ObjectExpression | undefined {
  if (!node) return undefined
  const resolved = resolveNode(node, context)
  if (resolved.type === "ObjectExpression") return resolved
  if (resolved.type !== "CallExpression" || !isNamedMemberCall(resolved, "story")) return undefined
  const first = resolved.arguments[0]
  if (!first || first.type === "SpreadElement" || first.type === "ArgumentPlaceholder") return undefined
  return resolveObject(first, context)
}

function argsEvidence(
  node: t.Node | undefined,
  context: StaticValueContext,
  composedArgs: ReadonlyMap<string, ParsedArgsEvidence> = new Map()
): ParsedArgsEvidence {
  const object = resolveObject(node, context)
  if (!object) return node ? { hasUnresolvedSpread: true } : {}
  return evaluateArgsObject(object, context, composedArgs, new Set())
}

function evaluateArgsObject(
  object: t.ObjectExpression,
  context: StaticValueContext,
  composedArgs: ReadonlyMap<string, ParsedArgsEvidence>,
  resolving: Set<t.ObjectExpression>
): ParsedArgsEvidence {
  if (resolving.has(object)) return { hasUnresolvedSpread: true }
  resolving.add(object)
  const values = Object.create(null) as Record<string, DemonstratedValue>
  const unresolved = new Set<string>()
  const truncated = new Set<string>()
  let hasUnresolvedSpread = false

  const clearForUnknownWrite = (): void => {
    for (const key of Object.keys(values)) Reflect.deleteProperty(values, key)
    unresolved.clear()
    truncated.clear()
    hasUnresolvedSpread = true
  }
  const merge = (evidence: ParsedArgsEvidence): void => {
    if (evidence.hasUnresolvedSpread) clearForUnknownWrite()
    for (const key of evidence.unresolvedKeys ?? []) {
      Reflect.deleteProperty(values, key)
      truncated.delete(key)
      unresolved.add(key)
    }
    for (const key of evidence.truncatedKeys ?? []) {
      Reflect.deleteProperty(values, key)
      unresolved.delete(key)
      truncated.add(key)
    }
    for (const key of Object.keys(evidence.values ?? {})) {
      values[key] = evidence.values?.[key] as DemonstratedValue
      unresolved.delete(key)
      truncated.delete(key)
    }
  }

  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      const composed = composedStoryArgs(property.argument, composedArgs)
      if (composed) {
        merge(composed)
        continue
      }
      const spreadObject = resolveObject(property.argument, context)
      if (!spreadObject) {
        clearForUnknownWrite()
        continue
      }
      merge(evaluateArgsObject(spreadObject, context, composedArgs, resolving))
      continue
    }
    const key = propertyKey(property)
    if (key === undefined) {
      clearForUnknownWrite()
      continue
    }
    Reflect.deleteProperty(values, key)
    unresolved.delete(key)
    truncated.delete(key)
    if (property.type !== "ObjectProperty") {
      unresolved.add(key)
      continue
    }
    const result = evaluateStaticValue(property.value, context)
    if (result.status === "resolved") values[key] = result.value as DemonstratedValue
    else if (result.status === "truncated") truncated.add(key)
    else unresolved.add(key)
  }
  resolving.delete(object)

  const allKeys = [...new Set([...Object.keys(values), ...unresolved, ...truncated])].sort(compareStrings)
  const retainedKeys = new Set(allKeys.slice(0, MAX_STATIC_COLLECTION_ENTRIES))
  for (const key of Object.keys(values)) if (!retainedKeys.has(key)) Reflect.deleteProperty(values, key)
  for (const key of unresolved) if (!retainedKeys.has(key)) unresolved.delete(key)
  for (const key of truncated) if (!retainedKeys.has(key)) truncated.delete(key)
  const omitted = allKeys.slice(MAX_STATIC_COLLECTION_ENTRIES)
  for (const key of omitted) truncated.add(key)

  const sortedValues = sortedDemonstratedMap(values)
  return {
    ...(sortedValues && Object.keys(sortedValues).length > 0 ? { values: sortedValues } : {}),
    ...(unresolved.size > 0
      ? { unresolvedKeys: [...unresolved].sort(compareStrings).slice(0, MAX_OMISSION_MARKER_NAMES) }
      : {}),
    ...(truncated.size > 0
      ? { truncatedKeys: [...truncated].sort(compareStrings).slice(0, MAX_OMISSION_MARKER_NAMES) }
      : {}),
    ...(hasUnresolvedSpread ? { hasUnresolvedSpread: true } : {})
  }
}

function composedStoryArgs(
  node: t.Node,
  composedArgs: ReadonlyMap<string, ParsedArgsEvidence>
): ParsedArgsEvidence | undefined {
  const current = unwrap(node)
  if (current.type !== "MemberExpression" || memberName(current) !== "args") return undefined
  return current.object.type === "Identifier" ? composedArgs.get(current.object.name) : undefined
}

function storyArgsEvidence(story: ParsedStoryEvidence): ParsedArgsEvidence {
  return {
    ...(story.values ? { values: story.values } : {}),
    ...(story.unresolvedKeys ? { unresolvedKeys: story.unresolvedKeys } : {}),
    ...(story.truncatedKeys ? { truncatedKeys: story.truncatedKeys } : {}),
    ...(story.hasUnresolvedSpread ? { hasUnresolvedSpread: true } : {})
  }
}

function parseArgTypesNode(
  node: t.Node | undefined,
  context: StaticValueContext
): { props: Record<string, PropDefinition>; controls?: Record<string, StorybookControlEvidence> } {
  const props = Object.create(null) as Record<string, PropDefinition>
  const controls = Object.create(null) as Record<string, StorybookControlEvidence>
  const object = resolveObject(node, context)
  if (!object) return { props }
  const argTypes = objectProperties(object, context)
  if (!argTypes) return { props }

  for (const name of [...argTypes.properties.keys()].sort(compareStrings)) {
    const property = argTypes.properties.get(name)
    if (!property || property.type !== "ObjectProperty") continue
    const config = objectProperties(resolveObject(property.value, context), context)
    if (!config) continue
    const definition = semanticPropDefinition(config, context)
    if (definition) props[name] = definition
    const control = controlEvidence(config, context)
    if (control) controls[name] = control
  }

  return { props, ...(Object.keys(controls).length > 0 ? { controls } : {}) }
}

function semanticPropDefinition(properties: ObjectProperties, context: StaticValueContext): PropDefinition | undefined {
  const directRequired = staticBoolean(fieldNode(properties, "required"), context)
  const typeNode = fieldNode(properties, "type")
  const typeName = staticString(typeNode, context)
  let objectTypeName: string | undefined
  let objectRequired: boolean | undefined
  let enumValues: Array<string | number | boolean> | undefined
  const typeObject = objectProperties(resolveObject(typeNode, context), context)
  if (typeObject) {
    objectTypeName = staticString(fieldNode(typeObject, "name"), context)
    objectRequired = staticBoolean(fieldNode(typeObject, "required"), context)
    if (objectTypeName === "enum") enumValues = completePrimitiveArray(fieldNode(typeObject, "value"), context)
  }
  const explicitType = typeName ?? objectTypeName
  const required = objectRequired ?? directRequired
  if (explicitType === undefined && required === undefined) return undefined
  return {
    ...(explicitType !== undefined ? { type: explicitType } : {}),
    ...(required !== undefined ? { required } : {}),
    ...(enumValues !== undefined ? { values: enumValues } : {})
  }
}

function controlEvidence(
  properties: ObjectProperties,
  context: StaticValueContext
): StorybookControlEvidence | undefined {
  const evidence: StorybookControlEvidence = {}
  const controlNode = fieldNode(properties, "control")
  const controlString = staticString(controlNode, context)
  const controlBoolean = staticBoolean(controlNode, context)
  if (controlString !== undefined) evidence.control = controlString
  else if (controlBoolean === false) evidence.control = false
  else {
    const controlObject = objectProperties(resolveObject(controlNode, context), context)
    const objectType = staticString(fieldNode(controlObject, "type"), context)
    if (objectType !== undefined) evidence.control = objectType
  }

  const optionsNode = fieldNode(properties, "options")
  if (optionsNode) {
    const options = primitiveOptions(optionsNode, context)
    if (options.values.length > 0) {
      const mappingNode = fieldNode(properties, "mapping")
      evidence.choices = mappedChoices(options.values, mappingNode, context)
    }
    if (options.unresolved) evidence.unresolvedChoices = true
    if (options.truncated) evidence.truncatedChoices = true
  }

  return Object.keys(evidence).length > 0 ? evidence : undefined
}

function primitiveOptions(
  node: t.Node,
  context: StaticValueContext
): { values: Array<string | number | boolean>; unresolved: boolean; truncated: boolean } {
  const resolved = resolveNode(node, context)
  if (resolved.type !== "ArrayExpression") return { values: [], unresolved: true, truncated: false }
  const values: Array<string | number | boolean> = []
  let unresolved = false
  let truncated = false
  for (const element of resolved.elements) {
    if (!element) {
      unresolved = true
      continue
    }
    if (element.type === "SpreadElement") {
      const spread = evaluateStaticValue(element.argument, context)
      if (spread.status === "truncated") truncated = true
      if (spread.status !== "resolved" || !Array.isArray(spread.value)) {
        unresolved = true
        continue
      }
      for (const value of spread.value) {
        if (isControlOption(value)) values.push(value)
        else unresolved = true
      }
      continue
    }
    const result = evaluateStaticValue(element, context)
    if (result.status === "truncated") truncated = true
    if (result.status === "resolved" && isControlOption(result.value)) values.push(result.value)
    else unresolved = true
  }
  const retained = retainSmallestPrimitiveValues(values, MAX_CONTROL_CHOICES)
  return { values: retained.values, unresolved, truncated: truncated || retained.truncated }
}

function completePrimitiveArray(
  node: t.Node | undefined,
  context: StaticValueContext
): Array<string | number | boolean> | undefined {
  if (!node) return undefined
  const result = evaluateStaticValue(node, context)
  if (result.status !== "resolved" || !Array.isArray(result.value)) return undefined
  if (!result.value.every(isControlOption) || result.value.length > MAX_STATIC_COLLECTION_ENTRIES) return undefined
  return [...new Map(result.value.map((value) => [primitiveValueKey(value), value])).values()].sort(
    comparePrimitiveValues
  )
}

function mappedChoices(
  options: Array<string | number | boolean>,
  mappingNode: t.Node | undefined,
  context: StaticValueContext
): StorybookControlChoice[] {
  if (!mappingNode) return options.map((option) => ({ option }))
  const mappingObject = resolveObject(mappingNode, context)
  if (!mappingObject) return options.map((option) => ({ option, mappingUnresolved: true }))
  const mapping = objectProperties(mappingObject, context)
  if (!mapping) return options.map((option) => ({ option, mappingUnresolved: true }))
  return options.map((option) => {
    const property = mapping.properties.get(String(option))
    if (!property) return mapping.hasUnknownWrite ? { option, mappingUnresolved: true } : { option }
    if (property.type !== "ObjectProperty") return { option, mappingUnresolved: true }
    const result = evaluateStaticValue(property.value, context)
    if (result.status !== "resolved") return { option, mappingUnresolved: true }
    const mappedValue = result.value as DemonstratedValue
    return samePrimitive(option, mappedValue) ? { option } : { option, mappedValue }
  })
}

function objectProperties(
  object: t.ObjectExpression | undefined,
  context: StaticValueContext,
  resolving = new Set<t.ObjectExpression>()
): ObjectProperties | undefined {
  if (!object || resolving.has(object)) return undefined
  resolving.add(object)
  const properties = new Map<string, t.ObjectProperty | t.ObjectMethod>()
  let hasUnknownWrite = false
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      const spreadObject = resolveObject(property.argument, context)
      const spread = objectProperties(spreadObject, context, resolving)
      if (!spread) {
        properties.clear()
        hasUnknownWrite = true
        continue
      }
      if (spread.hasUnknownWrite) {
        properties.clear()
        hasUnknownWrite = true
      }
      for (const [key, value] of spread.properties) properties.set(key, value)
      continue
    }
    const key = propertyKey(property)
    if (key === undefined) {
      properties.clear()
      hasUnknownWrite = true
      continue
    }
    properties.set(key, property)
  }
  resolving.delete(object)
  return { properties, hasUnknownWrite }
}

function fieldNode(properties: ObjectProperties | undefined, name: string): t.Node | undefined {
  const property = properties?.properties.get(name)
  return property?.type === "ObjectProperty" ? property.value : undefined
}

function resolveObject(node: t.Node | null | undefined, context: StaticValueContext): t.ObjectExpression | undefined {
  if (!node) return undefined
  const resolved = resolveNode(node, context)
  return resolved.type === "ObjectExpression" ? resolved : undefined
}

function resolveNode(node: t.Node, context: StaticValueContext, resolving = new Set<string>(), depth = 0): t.Node {
  const current = unwrap(node)
  if (current.type !== "Identifier" || resolving.has(current.name)) return current
  const binding = context.bindings.get(current.name)
  if (!binding) return current
  if (depth >= MAX_STATIC_BINDING_DEPTH) return current
  resolving.add(current.name)
  return resolveNode(binding, context, resolving, depth + 1)
}

function unwrap(node: t.Node): t.Node {
  let current = node
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSSatisfiesExpression" ||
    current.type === "TSNonNullExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TypeCastExpression"
  )
    current = current.expression
  return current
}

function propertyKey(property: t.ObjectProperty | t.ObjectMethod): string | undefined {
  if (property.computed) return undefined
  if (property.key.type === "Identifier") return property.key.name
  if (property.key.type === "StringLiteral") return property.key.value
  if (property.key.type === "NumericLiteral" && Number.isFinite(property.key.value)) return String(property.key.value)
  return undefined
}

function memberName(member: t.MemberExpression): string | undefined {
  if (!member.computed && member.property.type === "Identifier") return member.property.name
  if (member.computed && member.property.type === "StringLiteral") return member.property.value
  return undefined
}

function isNamedMemberCall(call: t.CallExpression, name: string): boolean {
  return call.callee.type === "MemberExpression" && memberName(call.callee) === name
}

function staticString(node: t.Node | undefined, context: StaticValueContext): string | undefined {
  if (!node) return undefined
  const result = evaluateStaticValue(node, context)
  return result.status === "resolved" && typeof result.value === "string" && boundedMetadataString(result.value)
    ? result.value
    : undefined
}

function staticBoolean(node: t.Node | undefined, context: StaticValueContext): boolean | undefined {
  if (!node) return undefined
  const result = evaluateStaticValue(node, context)
  return result.status === "resolved" && typeof result.value === "boolean" ? result.value : undefined
}

function boundedMetadataString(value: string): boolean {
  return value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= MAX_METADATA_STRING_BYTES
}

function sortedDemonstratedMap(
  source: Record<string, DemonstratedValue> | undefined
): Record<string, DemonstratedValue> | undefined {
  if (!source) return undefined
  const sorted = Object.create(null) as Record<string, DemonstratedValue>
  for (const key of Object.keys(source).sort(compareStrings)) sorted[key] = source[key]
  return sorted
}

function storyNameFromExport(exportName: string): string {
  return exportName
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .replace(/\./g, " ")
    .replace(/([^\n])([A-Z])([a-z])/g, "$1 $2$3")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([a-z])([0-9])/gi, "$1 $2")
    .replace(/([0-9])([a-z])/gi, "$1 $2")
    .replace(/(\s|^)(\w)/g, (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`)
    .replace(/ +/g, " ")
    .trim()
}

function sanitizeStorybookIdPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

function nameOfModuleExport(node: t.Identifier | t.StringLiteral): string | undefined {
  return node.type === "Identifier" ? node.name : boundedMetadataString(node.value) ? node.value : undefined
}

function isControlOption(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))
  )
}

function samePrimitive(option: PrimitiveValue, mapped: DemonstratedValue): boolean {
  return mapped === option && typeof mapped === typeof option
}

function compareParsedStories(a: ParsedStoryEvidence, b: ParsedStoryEvidence): number {
  return compareStrings(a.exportName, b.exportName)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
