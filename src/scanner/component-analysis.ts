import * as path from "node:path"
import type * as t from "@babel/types"
import { getBindingIdentifiers, VISITOR_KEYS } from "@babel/types"
import type { Component, ComponentAnalysisModule, ComponentKind, ComponentMap, PropDefinition } from "../types"
import { type ResolvedTypeMember, resolveTypeMembers, type TypeResolutionModule } from "./component-type-resolution"

/** Scan-wide component discovery and conservative local JSX relationship analysis. */
export class ComponentAnalyzer {
  private components = new Map<string, ComponentDefinition>()
  private modules = new Map<string, ComponentModule>()
  private typeModules = new Map<string, TypeResolutionModule>()
  private sites: RelationshipSite[] = []

  addModule(opts: ComponentAnalysisModule, options: { analyzeComponents?: boolean } = {}): void {
    const file = normalizeFile(opts.file)
    this.typeModules.set(file, { file, content: opts.content, program: opts.program })
    if (options.analyzeComponents === false) return

    const discovered = discoverComponents({ ...opts, file })
    const localComponents = new Map<string, ScopeBinding>()
    const ownerRoots = new WeakMap<t.Node, string>()

    for (const definition of discovered.definitions) {
      this.components.set(definition.id, definition)
      ownerRoots.set(definition.node, definition.id)
      if (definition.localName) {
        localComponents.set(definition.localName, {
          kind: "candidate",
          reference: { kind: "local", targetId: definition.id }
        })
      }
    }

    const programBindings = importBindings(opts.program, file)
    for (const [name, binding] of localComponents) mergeBinding(programBindings, name, binding)

    const programScope = createScope(null, true)
    for (const [name, binding] of programBindings) programScope.bindings.set(name, binding)

    const context: WalkContext = {
      ownerRoots,
      pendingSites: [],
      programBindings,
      programScope
    }
    visitNode(opts.program, programScope, undefined, context)

    for (const pending of context.pendingSites) {
      const binding = lookupBinding(pending.scope, pending.name)
      if (binding !== undefined && binding !== OTHER_BINDING) {
        this.sites.push({ ownerId: pending.ownerId, reference: binding.reference, props: pending.props })
      }
    }

    this.modules.set(file, { exports: discovered.exports })
  }

  finish(): ComponentMap {
    const outgoing = new Map<string, Map<string, number>>()
    const usage = new Map<string, number>()
    const observedProps = new Map<string, Map<string, ObservedPropAccumulator>>()

    for (const site of this.sites) {
      const targetId = this.resolveReference(site.reference)
      if (!targetId || !this.components.has(targetId)) continue

      usage.set(targetId, (usage.get(targetId) ?? 0) + 1)
      for (const prop of site.props) addObservedProp(observedProps, targetId, prop)
      if (!site.ownerId) continue
      let ownerUses = outgoing.get(site.ownerId)
      if (!ownerUses) {
        ownerUses = new Map()
        outgoing.set(site.ownerId, ownerUses)
      }
      ownerUses.set(targetId, (ownerUses.get(targetId) ?? 0) + 1)
    }

    const result: ComponentMap = {}
    for (const id of [...this.components.keys()].sort()) {
      const stored = this.components.get(id)
      if (!stored) continue
      const component: Component = {
        ...stored.component,
        props: resolveProps({ modules: this.typeModules, file: stored.file, input: stored.propsInput })
      }
      const ownerUses = outgoing.get(id)
      if (ownerUses && ownerUses.size > 0) {
        component.uses = Object.fromEntries([...ownerUses.entries()].sort(([a], [b]) => compareStrings(a, b)))
      }
      const sites = usage.get(id)
      if (sites !== undefined && sites > 0) {
        const componentUsage: NonNullable<Component["usage"]> = { sites }
        const props = observedProps.get(id)
        if (props && props.size > 0) {
          componentUsage.props = Object.fromEntries(
            [...props.entries()]
              .sort(([a], [b]) => compareStrings(a, b))
              .map(([name, observed]) => [name, [...observed.values.values()].sort(compareObservedPropValues)])
          )
          const truncatedProps = [...props.entries()]
            .filter(([, observed]) => observed.truncated)
            .map(([name]) => name)
            .sort(compareStrings)
          if (truncatedProps.length > 0) componentUsage.truncatedProps = truncatedProps
        }
        component.usage = componentUsage
      }
      result[id] = component
    }
    return result
  }

  private resolveReference(reference: ComponentReference): string | null {
    if (reference.kind === "local") return reference.targetId
    if (!reference.specifier.startsWith("./") && !reference.specifier.startsWith("../")) return null

    const base = path.posix.normalize(path.posix.join(path.posix.dirname(reference.importer), reference.specifier))
    if (base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) return null

    const extension = path.posix.extname(base)
    const candidates = extension
      ? extension === ".tsx" || extension === ".jsx"
        ? [base]
        : []
      : [`${base}.tsx`, `${base}.jsx`, `${base}/index.tsx`, `${base}/index.jsx`]
    const matches = candidates.filter((candidate) => this.modules.has(candidate))
    if (matches.length !== 1) return null

    const targets = this.modules.get(matches[0])?.exports.get(reference.exportName)
    return targets?.size === 1 ? [...targets][0] : null
  }
}

type ComponentReference = { kind: "local"; targetId: string } | ImportReference

interface ImportReference {
  kind: "import"
  importer: string
  specifier: string
  exportName: string
}

interface ComponentDefinition {
  id: string
  file: string
  localName?: string
  node: t.Node
  component: Component
  propsInput: ResolvedPropsInput | null
}

interface ComponentModule {
  exports: Map<string, Set<string>>
}

interface RelationshipSite {
  ownerId?: string
  props: ObservedProp[]
  reference: ComponentReference
}

type ScopeBinding = { kind: "candidate"; reference: ComponentReference } | typeof OTHER_BINDING

interface Scope {
  parent: Scope | null
  bindings: Map<string, ScopeBinding>
  varScope: Scope
}

interface PendingSite {
  name: string
  ownerId?: string
  props: ObservedProp[]
  scope: Scope
}

interface WalkContext {
  ownerRoots: WeakMap<t.Node, string>
  pendingSites: PendingSite[]
  programBindings: Map<string, ScopeBinding>
  programScope: Scope
}

const OTHER_BINDING = Symbol("other-binding")

function discoverComponents(opts: { file: string; program: t.Program }): {
  definitions: ComponentDefinition[]
  exports: Map<string, Set<string>>
} {
  const localInit = new Map<string, { node: t.Node; line: number; idType?: t.TSType }>()
  const exportRequests: Array<{ exportName: string; localName: string }> = []
  const anonymousDefaults: ComponentDefinition[] = []

  const remember = (declaration: t.Declaration): string[] => {
    const names: string[] = []
    if ((declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") && declaration.id) {
      localInit.set(declaration.id.name, { node: declaration, line: lineOf(declaration) })
      names.push(declaration.id.name)
    } else if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        if (declarator.id.type !== "Identifier" || !declarator.init) continue
        const annotation =
          declarator.id.typeAnnotation?.type === "TSTypeAnnotation"
            ? declarator.id.typeAnnotation.typeAnnotation
            : undefined
        localInit.set(declarator.id.name, {
          node: declarator.init,
          line: lineOf(declarator),
          idType: annotation
        })
        names.push(declarator.id.name)
      }
    }
    return names
  }

  for (const statement of opts.program.body) {
    if (
      statement.type === "FunctionDeclaration" ||
      statement.type === "ClassDeclaration" ||
      statement.type === "VariableDeclaration"
    ) {
      remember(statement)
      continue
    }

    if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration) {
        for (const name of remember(statement.declaration)) exportRequests.push({ exportName: name, localName: name })
      } else if (!statement.source) {
        for (const specifier of statement.specifiers) {
          if (specifier.type !== "ExportSpecifier" || specifier.local.type !== "Identifier") continue
          exportRequests.push({ exportName: exportedName(specifier.exported), localName: specifier.local.name })
        }
      }
      continue
    }

    if (statement.type !== "ExportDefaultDeclaration") continue
    const declaration = statement.declaration
    if (declaration.type === "Identifier") {
      exportRequests.push({ exportName: "default", localName: declaration.name })
    } else if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") &&
      declaration.id
    ) {
      remember(declaration)
      exportRequests.push({ exportName: "default", localName: declaration.id.name })
    } else if (isComponentNode(declaration)) {
      const name = path.posix.basename(opts.file, path.posix.extname(opts.file))
      if (/^[A-Z]/.test(name)) {
        anonymousDefaults.push(makeDefinition({ file: opts.file, name, node: declaration }))
      }
    }
  }

  const requestedLocals = new Set(exportRequests.map((request) => request.localName))
  const definitions: ComponentDefinition[] = []
  const idsByLocal = new Map<string, string>()
  for (const [name, candidate] of localInit) {
    if (!requestedLocals.has(name) || !/^[A-Z]/.test(name) || !isComponentNode(candidate.node)) continue
    const definition = makeDefinition({
      file: opts.file,
      idType: candidate.idType,
      line: candidate.line,
      localName: name,
      name,
      node: candidate.node
    })
    definitions.push(definition)
    idsByLocal.set(name, definition.id)
  }
  definitions.push(...anonymousDefaults)

  const exports = new Map<string, Set<string>>()
  for (const request of exportRequests) {
    const id = idsByLocal.get(request.localName)
    if (id) addExport(exports, request.exportName, id)
  }
  for (const definition of anonymousDefaults) addExport(exports, "default", definition.id)

  return { definitions, exports }
}

function makeDefinition(opts: {
  file: string
  idType?: t.TSType
  line?: number
  localName?: string
  name: string
  node: t.Node
}): ComponentDefinition {
  return {
    id: componentId(opts.file, opts.name),
    file: opts.file,
    localName: opts.localName,
    node: opts.node,
    propsInput: propsInput(opts.node, opts.idType),
    component: {
      name: opts.name,
      displayName: opts.name,
      kind: classifyComponent(opts.name, opts.file),
      source: { adapter: "codebase", file: opts.file, line: opts.line ?? lineOf(opts.node) },
      props: {}
    }
  }
}

function addExport(exports: Map<string, Set<string>>, exportName: string, id: string): void {
  let ids = exports.get(exportName)
  if (!ids) {
    ids = new Set()
    exports.set(exportName, ids)
  }
  ids.add(id)
}

function importBindings(program: t.Program, file: string): Map<string, ScopeBinding> {
  const bindings = new Map<string, ScopeBinding>()
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue
    const typeOnly = statement.importKind === "type"
    const source = statement.source.value
    const relative = source.startsWith("./") || source.startsWith("../")
    for (const specifier of statement.specifiers) {
      let binding: ScopeBinding = OTHER_BINDING
      if (!typeOnly && relative && specifier.type === "ImportDefaultSpecifier") {
        binding = {
          kind: "candidate",
          reference: { kind: "import", importer: file, specifier: source, exportName: "default" }
        }
      } else if (!typeOnly && relative && specifier.type === "ImportSpecifier" && specifier.importKind !== "type") {
        binding = {
          kind: "candidate",
          reference: {
            kind: "import",
            importer: file,
            specifier: source,
            exportName: exportedName(specifier.imported)
          }
        }
      }
      mergeBinding(bindings, specifier.local.name, binding)
    }
  }
  return bindings
}

function mergeBinding(bindings: Map<string, ScopeBinding>, name: string, binding: ScopeBinding): void {
  const existing = bindings.get(name)
  if (existing === undefined) bindings.set(name, binding)
  else if (existing !== binding) bindings.set(name, OTHER_BINDING)
}

function createScope(parent: Scope | null, ownsVarScope = false): Scope {
  const scope = { parent, bindings: new Map<string, ScopeBinding>() } as Scope
  scope.varScope = ownsVarScope || !parent ? scope : parent.varScope
  return scope
}

function visitNode(node: t.Node | null | undefined, scope: Scope, ownerId: string | undefined, ctx: WalkContext): void {
  if (!node) return
  const owner = ctx.ownerRoots.get(node) ?? ownerId

  switch (node.type) {
    case "ImportDeclaration":
      return
    case "JSXOpeningElement":
      if (node.name.type === "JSXIdentifier" && /^[A-Z]/.test(node.name.name)) {
        ctx.pendingSites.push({
          name: node.name.name,
          ownerId: owner,
          props: observedJsxProps(node.attributes),
          scope
        })
      }
      visitChildren(node, scope, owner, ctx)
      return
    case "VariableDeclaration": {
      const destination = node.kind === "var" ? scope.varScope : scope
      for (const declaration of node.declarations) {
        declarePattern(destination, declaration.id, ctx)
        visitNode(declaration.id, scope, owner, ctx)
        visitNode(declaration.init, scope, owner, ctx)
      }
      return
    }
    case "FunctionDeclaration":
      if (node.id) declareValue(scope, node.id.name, ctx)
      visitFunction(node, scope, owner, ctx)
      return
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ObjectMethod":
    case "ClassMethod":
    case "ClassPrivateMethod":
      visitFunction(node, scope, owner, ctx)
      return
    case "BlockStatement":
      visitChildren(node, createScope(scope), owner, ctx)
      return
    case "CatchClause": {
      const catchScope = createScope(scope)
      declarePattern(catchScope, node.param, ctx)
      visitNode(node.param, catchScope, owner, ctx)
      visitNode(node.body, catchScope, owner, ctx)
      return
    }
    case "ForStatement":
    case "ForInStatement":
    case "ForOfStatement":
      visitChildren(node, createScope(scope), owner, ctx)
      return
    case "SwitchStatement": {
      visitNode(node.discriminant, scope, owner, ctx)
      const switchScope = createScope(scope)
      for (const switchCase of node.cases) visitNode(switchCase, switchScope, owner, ctx)
      return
    }
    case "ClassDeclaration": {
      const binding = node.id ? valueBinding(scope, node.id.name, ctx) : OTHER_BINDING
      if (node.id) mergeBinding(scope.bindings, node.id.name, binding)
      visitClass(node, scope, owner, ctx, binding)
      return
    }
    case "ClassExpression": {
      const binding = node.id ? expressionSelfBinding(node, ctx) : OTHER_BINDING
      visitClass(node, scope, owner, ctx, binding)
      return
    }
    case "StaticBlock":
    case "TSModuleBlock":
      visitChildren(node, createScope(scope, true), owner, ctx)
      return
    case "TSEnumDeclaration":
    case "TSModuleDeclaration":
      if (node.id.type === "Identifier") declareValue(scope, node.id.name, ctx)
      visitChildren(node, scope, owner, ctx)
      return
    case "TSImportEqualsDeclaration":
    case "TSDeclareFunction":
      if (node.id) declareValue(scope, node.id.name, ctx)
      visitChildren(node, scope, owner, ctx)
      return
    default:
      visitChildren(node, scope, owner, ctx)
  }
}

function visitFunction(node: t.Function, outerScope: Scope, ownerId: string | undefined, ctx: WalkContext): void {
  const owner = ctx.ownerRoots.get(node) ?? ownerId
  if (
    (node.type === "ObjectMethod" || node.type === "ClassMethod" || node.type === "ClassPrivateMethod") &&
    node.computed
  ) {
    visitNode(node.key, outerScope, owner, ctx)
  }

  const parameterScope = createScope(outerScope)
  if (node.type === "FunctionExpression" && node.id) {
    mergeBinding(parameterScope.bindings, node.id.name, expressionSelfBinding(node, ctx))
  }
  for (const parameter of node.params) declarePattern(parameterScope, parameter, ctx)
  for (const parameter of node.params) visitNode(parameter, parameterScope, owner, ctx)

  const bodyScope = createScope(parameterScope, true)
  visitNode(node.body, bodyScope, owner, ctx)
}

function visitClass(
  node: t.Class,
  outerScope: Scope,
  ownerId: string | undefined,
  ctx: WalkContext,
  selfBinding: ScopeBinding
): void {
  const classScope = createScope(outerScope)
  if (node.id) mergeBinding(classScope.bindings, node.id.name, selfBinding)
  visitNode(node.superClass, outerScope, ownerId, ctx)
  for (const decorator of node.decorators ?? []) visitNode(decorator, outerScope, ownerId, ctx)
  visitNode(node.body, classScope, ownerId, ctx)
}

function visitChildren(node: t.Node, scope: Scope, ownerId: string | undefined, ctx: WalkContext): void {
  const keys = VISITOR_KEYS[node.type] ?? []
  const record = node as unknown as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) visitNode(item, scope, ownerId, ctx)
    } else if (isNode(value)) {
      visitNode(value, scope, ownerId, ctx)
    }
  }
}

function declarePattern(scope: Scope, pattern: t.Node | null | undefined, ctx: WalkContext): void {
  if (!pattern) return
  const target = pattern.type === "TSParameterProperty" ? pattern.parameter : pattern
  for (const name of Object.keys(getBindingIdentifiers(target))) declareValue(scope, name, ctx)
}

function declareValue(scope: Scope, name: string, ctx: WalkContext): void {
  mergeBinding(scope.bindings, name, valueBinding(scope, name, ctx))
}

function valueBinding(scope: Scope, name: string, ctx: WalkContext): ScopeBinding {
  return scope === ctx.programScope ? (ctx.programBindings.get(name) ?? OTHER_BINDING) : OTHER_BINDING
}

function expressionSelfBinding(node: t.ClassExpression | t.FunctionExpression, ctx: WalkContext): ScopeBinding {
  const targetId = ctx.ownerRoots.get(node)
  return targetId === undefined ? OTHER_BINDING : { kind: "candidate", reference: { kind: "local", targetId } }
}

function lookupBinding(scope: Scope, name: string): ScopeBinding | undefined {
  let current: Scope | null = scope
  while (current) {
    const binding = current.bindings.get(name)
    if (binding !== undefined) return binding
    current = current.parent
  }
  return undefined
}

function exportedName(node: t.Identifier | t.StringLiteral): string {
  return node.type === "Identifier" ? node.name : node.value
}

function normalizeFile(file: string): string {
  return file.split(path.sep).join("/")
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function componentId(file: string, name: string): string {
  const id = normalizeFile(file).replace(/\.[^/.]+$/, "")
  const segments = id.split("/")
  const base = segments[segments.length - 1]
  const effectiveBase = /^index$/i.test(base) && segments.length >= 2 ? segments[segments.length - 2] : base
  return normalizeForIdMatch(name) === normalizeForIdMatch(effectiveBase) ? id : `${id}#${name}`
}

function normalizeForIdMatch(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase()
}

function resolveProps(opts: {
  modules: Map<string, TypeResolutionModule>
  file: string
  input: ResolvedPropsInput | null
}): Record<string, PropDefinition> {
  if (!opts.input) return {}
  const members = resolveTypeMembers({ modules: opts.modules, file: opts.file, typeNode: opts.input.typeNode })
  return members ? membersToProps(members, destructuredDefaults(opts.input.parameter)) : {}
}

interface ResolvedPropsInput {
  typeNode: t.TSType
  parameter?: t.Node
}

function propsInput(node: t.Node, idType?: t.TSType): ResolvedPropsInput | null {
  if (idType) {
    const fromId = propsFromComponentType(idType)
    if (fromId) return { typeNode: fromId, parameter: componentParameter(node) }
  }
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    const parameter = node.params[0]
    const typeNode = firstParamType(node.params)
    return typeNode ? { typeNode, parameter } : null
  }
  if (node.type === "ClassDeclaration") {
    const typeNode = typeArgParams(node, "super")?.[0]
    return typeNode ? { typeNode } : null
  }
  if (node.type === "CallExpression") {
    const params = typeArgParams(node, "type")
    const callback = componentCallback(node)
    if (params && params.length > 0) {
      const typeNode = params[params.length === 1 ? 0 : 1]
      return { typeNode, parameter: callback?.params[0] }
    }
    if (callback) {
      const typeNode = firstParamType(callback.params)
      return typeNode ? { typeNode, parameter: callback.params[0] } : null
    }
  }
  return null
}

function componentParameter(node: t.Node): t.Node | undefined {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    return node.params[0]
  }
  if (node.type === "CallExpression") return componentCallback(node)?.params[0]
  return undefined
}

function componentCallback(node: t.CallExpression): t.ArrowFunctionExpression | t.FunctionExpression | undefined {
  const callbacks = node.arguments.filter(
    (argument): argument is t.ArrowFunctionExpression | t.FunctionExpression =>
      argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression"
  )
  return callbacks.length === 1 ? callbacks[0] : undefined
}

function propsFromComponentType(idType: t.TSType): t.TSType | null {
  if (idType.type !== "TSTypeReference") return null
  const name =
    idType.typeName.type === "Identifier"
      ? idType.typeName.name
      : idType.typeName.type === "TSQualifiedName"
        ? idType.typeName.right.name
        : null
  if (name !== "FC" && name !== "FunctionComponent") return null
  return typeArgParams(idType, "type")?.[0] ?? null
}

function firstParamType(params: t.Node[]): t.TSType | null {
  const parameter = params[0]
  if (!parameter) return null
  const annotation = "typeAnnotation" in parameter ? parameter.typeAnnotation : null
  return annotation?.type === "TSTypeAnnotation" ? annotation.typeAnnotation : null
}

type PropLiteral = string | number | boolean
type ObservedPropValue = PropLiteral | null

interface ObservedProp {
  name: string
  value: ObservedPropValue
}

interface ObservedPropAccumulator {
  truncated: boolean
  values: Map<string, ObservedPropValue>
}

const MAX_OBSERVED_VALUES_PER_PROP = 20

function unwrapLiteralWrapper(node: t.Node): t.Node {
  let current = node
  while (true) {
    if (current.type === "TSAsExpression" || current.type === "TSSatisfiesExpression") {
      current = current.expression
      continue
    }
    if (current.type === "TSTypeAssertion" || current.type === "ParenthesizedExpression") {
      current = current.expression
      continue
    }
    if (current.type === "TSNonNullExpression") {
      current = current.expression
      continue
    }
    break
  }
  return current
}

function primitiveLiteral(node: t.Node): PropLiteral | undefined {
  const current = unwrapLiteralWrapper(node)
  if (current.type === "StringLiteral" || current.type === "BooleanLiteral") return current.value
  if (current.type === "NumericLiteral") return finiteNumber(current.value)
  if (current.type !== "UnaryExpression" || (current.operator !== "+" && current.operator !== "-")) return undefined

  const operand = unwrapLiteralWrapper(current.argument)
  if (operand.type !== "NumericLiteral") return undefined
  const value = current.operator === "-" ? -operand.value : operand.value
  return finiteNumber(value)
}

function observedPrimitiveLiteral(node: t.Node): ObservedPropValue | undefined {
  const current = unwrapLiteralWrapper(node)
  if (current.type === "NullLiteral") return null
  if (current.type === "TemplateLiteral" && current.expressions.length === 0 && current.quasis.length === 1) {
    return current.quasis[0].value.cooked ?? undefined
  }
  return primitiveLiteral(current)
}

function observedJsxProps(attributes: Array<t.JSXAttribute | t.JSXSpreadAttribute>): ObservedProp[] {
  const props: ObservedProp[] = []
  for (const attribute of attributes) {
    if (attribute.type !== "JSXAttribute" || attribute.name.type !== "JSXIdentifier") continue
    const attributeValue = attribute.value
    if (attributeValue == null) {
      props.push({ name: attribute.name.name, value: true })
      continue
    }
    if (attributeValue.type === "StringLiteral") {
      props.push({ name: attribute.name.name, value: attributeValue.value })
      continue
    }
    if (attributeValue.type !== "JSXExpressionContainer" || attributeValue.expression.type === "JSXEmptyExpression") {
      continue
    }
    const value = observedPrimitiveLiteral(attributeValue.expression)
    if (value !== undefined) props.push({ name: attribute.name.name, value })
  }
  return props
}

function addObservedProp(
  observedProps: Map<string, Map<string, ObservedPropAccumulator>>,
  componentId: string,
  prop: ObservedProp
): void {
  let componentProps = observedProps.get(componentId)
  if (!componentProps) {
    componentProps = new Map()
    observedProps.set(componentId, componentProps)
  }
  let observed = componentProps.get(prop.name)
  if (!observed) {
    observed = { truncated: false, values: new Map() }
    componentProps.set(prop.name, observed)
  }

  const key = observedPropValueKey(prop.value)
  if (observed.values.has(key)) return
  if (observed.values.size < MAX_OBSERVED_VALUES_PER_PROP) {
    observed.values.set(key, prop.value)
    return
  }

  observed.truncated = true
  let greatest: [string, ObservedPropValue] | undefined
  for (const entry of observed.values) {
    if (!greatest || compareObservedPropValues(entry[1], greatest[1]) > 0) greatest = entry
  }
  if (greatest && compareObservedPropValues(prop.value, greatest[1]) < 0) {
    observed.values.delete(greatest[0])
    observed.values.set(key, prop.value)
  }
}

function observedPropValueKey(value: ObservedPropValue): string {
  return value === null ? "null" : `${typeof value}:${String(value)}`
}

function compareObservedPropValues(a: ObservedPropValue, b: ObservedPropValue): number {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  return comparePropLiterals(a, b)
}

function finiteNumber(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined
  return value === 0 ? 0 : value
}

function literalValues(typeNode: t.TSType): PropLiteral[] | undefined {
  let current = typeNode
  while (current.type === "TSParenthesizedType") current = current.typeAnnotation

  const members = current.type === "TSUnionType" ? current.types : [current]
  const values: PropLiteral[] = []
  for (const member of members) {
    let literalType = member
    while (literalType.type === "TSParenthesizedType") literalType = literalType.typeAnnotation
    if (literalType.type !== "TSLiteralType") return undefined
    const value = primitiveLiteral(literalType.literal)
    if (value === undefined) return undefined
    values.push(value)
  }
  if (values.length === 0) return undefined

  const unique = new Map<string, PropLiteral>()
  for (const value of values) unique.set(`${typeof value}:${String(value)}`, value)
  return [...unique.values()].sort(comparePropLiterals)
}

function comparePropLiterals(a: PropLiteral, b: PropLiteral): number {
  const rank = (value: PropLiteral): number => (typeof value === "boolean" ? 0 : typeof value === "number" ? 1 : 2)
  const aRank = rank(a)
  const bRank = rank(b)
  if (aRank !== bRank) return aRank - bRank
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b)
  if (typeof a === "number" && typeof b === "number") return a - b
  return a < b ? -1 : a > b ? 1 : 0
}

function destructuredDefaults(parameter?: t.Node): Map<string, PropLiteral> {
  if (!parameter || parameter.type !== "ObjectPattern") return new Map()
  const defaults = new Map<string, PropLiteral>()
  for (const property of parameter.properties) {
    if (property.type !== "ObjectProperty" || property.computed) continue
    const name =
      property.key.type === "Identifier"
        ? property.key.name
        : property.key.type === "StringLiteral"
          ? property.key.value
          : null
    if (!name || property.value.type !== "AssignmentPattern" || property.value.left.type !== "Identifier") continue
    const value = primitiveLiteral(property.value.right)
    if (value !== undefined) defaults.set(name, value)
  }
  return defaults
}

function stringDefault(value: PropLiteral, values?: PropLiteral[]): string | undefined {
  if (values) {
    const text = String(value)
    const collisions = values.filter((candidate) => String(candidate) === text)
    if (collisions.some((candidate) => typeof candidate !== typeof value)) return undefined
  }
  return String(value)
}

function typeArgParams(node: t.Node, position: "type" | "super"): t.TSType[] | null {
  const keys =
    position === "super"
      ? (["superTypeArguments", "superTypeParameters"] as const)
      : (["typeArguments", "typeParameters"] as const)
  const record = node as unknown as Record<string, unknown>
  for (const key of keys) {
    const container = record[key]
    if (isTypeArgContainer(container)) return container.params
  }
  return null
}

function isTypeArgContainer(value: unknown): value is { params: t.TSType[] } {
  return typeof value === "object" && value !== null && "params" in value && Array.isArray(value.params)
}

function membersToProps(
  members: ResolvedTypeMember[],
  defaults: Map<string, PropLiteral>
): Record<string, PropDefinition> {
  const props: Record<string, PropDefinition> = {}
  for (const resolved of members) {
    const { member, content } = resolved
    const name =
      member.key.type === "Identifier" ? member.key.name : member.key.type === "StringLiteral" ? member.key.value : null
    if (!name) continue
    const type =
      member.typeAnnotation?.type === "TSTypeAnnotation"
        ? nodeText(content, member.typeAnnotation.typeAnnotation)
        : "unknown"
    const values =
      member.typeAnnotation?.type === "TSTypeAnnotation"
        ? literalValues(member.typeAnnotation.typeAnnotation)
        : undefined
    const definition: PropDefinition = { type, required: !member.optional }
    if (values) definition.values = values
    const defaultValue = defaults.get(name)
    const normalizedDefault = defaultValue === undefined ? undefined : stringDefault(defaultValue, values)
    if (normalizedDefault !== undefined) definition.default = normalizedDefault
    props[name] = definition
  }
  return props
}

function nodeText(content: string, node: t.Node): string {
  return typeof node.start === "number" && typeof node.end === "number"
    ? content.slice(node.start, node.end).trim()
    : "unknown"
}

function isComponentNode(node: t.Node): boolean {
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      return containsJSX(node.body)
    case "ClassDeclaration":
    case "ClassExpression":
      return containsJSX(node.body)
    case "CallExpression":
      return isWrappedComponent(node)
    case "TaggedTemplateExpression":
      return isStyledTag(node.tag)
    default:
      return false
  }
}

function isWrappedComponent(call: t.CallExpression): boolean {
  const callee = call.callee
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression" && callee.property.type === "Identifier"
        ? callee.property.name
        : ""
  if (name === "styled") return true
  return call.arguments.some(
    (argument) =>
      argument.type !== "SpreadElement" && argument.type !== "ArgumentPlaceholder" && isComponentNode(argument)
  )
}

function isStyledTag(tag: t.Expression): boolean {
  if (tag.type === "MemberExpression" && tag.object.type === "Identifier" && tag.object.name === "styled") return true
  return tag.type === "CallExpression" && tag.callee.type === "Identifier" && tag.callee.name === "styled"
}

function containsJSX(node: t.Node): boolean {
  if (node.type === "JSXElement" || node.type === "JSXFragment") return true
  const record = node as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "start" || key === "end" || key === "leadingComments" || key === "trailingComments") {
      continue
    }
    const value = record[key]
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item) && containsJSX(item)) return true
    } else if (isNode(value) && containsJSX(value)) {
      return true
    }
  }
  return false
}

function isNode(value: unknown): value is t.Node {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
}

function classifyComponent(name: string, file: string): ComponentKind {
  const lowerFile = file.toLowerCase()
  if (/icon$/i.test(name) || lowerFile.includes("/icons/")) return "icon"
  if (/(provider|context)$/i.test(name)) return "provider"
  if (/(screen|page)$/i.test(name) || lowerFile.includes("/pages/") || /(^|\/)page\.[jt]sx$/.test(lowerFile)) {
    return "screen"
  }
  return "component"
}

function lineOf(node: t.Node): number {
  return node.loc?.start.line ?? 1
}
