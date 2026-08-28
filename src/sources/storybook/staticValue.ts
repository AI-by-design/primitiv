import type * as t from "@babel/types"
import { MAX_STATIC_BINDING_DEPTH } from "./limits"

/** The deliberately small set of values which can be carried as source evidence. */
export type StaticValue = null | string | number | boolean | StaticValue[] | StaticObject

export interface StaticObject {
  readonly [key: string]: StaticValue
}

export type StaticValueStatus = "resolved" | "unresolved" | "truncated"

export interface StaticValueResult {
  status: StaticValueStatus
  value?: StaticValue
}

export interface StaticObjectResult extends StaticValueResult {
  value?: StaticObject
  /** Known property names whose value was dynamic or otherwise unprovable. */
  unresolvedKeys: string[]
  /** Known property names dropped because a bound was exceeded. */
  truncatedKeys: string[]
  /** True when an object spread could not be proven to have a fixed key set. */
  hasUnresolvedSpread: boolean
}

export interface StaticValueLimits {
  /** Maximum nesting level of arrays and objects. */
  maxDepth?: number
  /** Maximum entries in one array or object. */
  maxEntries?: number
  /** Maximum UTF-8 bytes in one completely resolved value. */
  maxBytes?: number
}

export interface StaticValueContext extends StaticValueLimits {
  bindings: ReadonlyMap<string, t.Expression>
}

export const DEFAULT_STATIC_VALUE_LIMITS: Required<StaticValueLimits> = {
  maxDepth: 4,
  maxEntries: 20,
  maxBytes: 2 * 1024
}

type EvaluationInput =
  | StaticValueContext
  | ReadonlyMap<string, t.Expression>
  | t.Program
  | StaticValueLimits
  | undefined

/**
 * Collect same-file, immutable const bindings. Imports and bindings which are
 * assigned to are intentionally absent. A missing binding is therefore always
 * treated as dynamic by the evaluator.
 */
export function buildStaticBindings(program: t.Program): ReadonlyMap<string, t.Expression> {
  const candidates = new Map<string, t.Expression>()
  const rejected = new Set<string>()
  const declared = new Set<string>()
  const imported = new Set<string>()

  // Only module-level declarations are safe to resolve without a scope
  // implementation. A block/function const may shadow a module binding and
  // must never accidentally become a file-wide binding here.
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement
    if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue
    for (const declarator of declaration.declarations) {
      if (declarator.id.type !== "Identifier") continue
      const name = declarator.id.name
      if (declared.has(name)) rejected.add(name)
      declared.add(name)
      if (declarator.init) candidates.set(name, declarator.init)
      else rejected.add(name)
    }
  }

  walkAst(program, (node) => {
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) imported.add(specifier.local.name)
      return
    }
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
      rejected.add(node.left.name)
      return
    }
    if (node.type === "AssignmentExpression") {
      for (const name of assignedNames(node.left)) rejected.add(name)
      return
    }
    if (node.type === "UpdateExpression") {
      for (const name of assignedNames(node.argument)) rejected.add(name)
      return
    }
    if (node.type === "UnaryExpression" && node.operator === "delete") {
      for (const name of assignedNames(node.argument)) rejected.add(name)
      return
    }
    if (node.type === "ForInStatement" || node.type === "ForOfStatement") {
      for (const name of assignedNames(node.left)) rejected.add(name)
    }
  })

  for (const name of imported) rejected.add(name)
  const result = new Map<string, t.Expression>()
  for (const [name, init] of candidates) {
    if (!rejected.has(name)) result.set(name, init)
  }
  return result
}

/** Construct a reusable evaluator context from a Babel Program. */
export function createStaticValueContext(program: t.Program, limits: StaticValueLimits = {}): StaticValueContext {
  return { bindings: buildStaticBindings(program), ...limits }
}

/** Evaluate a supported Babel expression without executing user code. */
export function evaluateStaticValue(
  node: t.Node | null | undefined,
  input?: EvaluationInput,
  limits: StaticValueLimits = {}
): StaticValueResult {
  const context = normaliseContext(input, limits)
  const result = evaluate(node, context, 0, new Set<string>())
  return { status: result.status, ...(result.value !== undefined ? { value: result.value } : {}) }
}

/**
 * Evaluate an object expression and expose the conservative merge diagnostics
 * needed by the CSF parser. Property writes happen in source order, exactly as
 * they do for a JavaScript object literal.
 */
export function evaluateStaticObject(
  node: t.ObjectExpression,
  input?: EvaluationInput,
  limits: StaticValueLimits = {}
): StaticObjectResult {
  const context = normaliseContext(input, limits)
  const result = evaluateObject(node, context, 0, new Set<string>())
  return toPublicObjectResult(result)
}

// Friendly aliases for consumers that describe the input as an expression.
export const evaluateStaticExpression = evaluateStaticValue
export const evaluateObjectExpression = evaluateStaticObject
export const collectStaticBindings = buildStaticBindings

interface InternalResult {
  status: StaticValueStatus
  value?: StaticValue
  unresolvedKeys: Set<string>
  truncatedKeys: Set<string>
  hasUnresolvedSpread: boolean
  hasTruncatedSpread: boolean
}

function unresolved(): InternalResult {
  return {
    status: "unresolved",
    unresolvedKeys: new Set(),
    truncatedKeys: new Set(),
    hasUnresolvedSpread: false,
    hasTruncatedSpread: false
  }
}

function truncated(): InternalResult {
  return {
    status: "truncated",
    unresolvedKeys: new Set(),
    truncatedKeys: new Set(),
    hasUnresolvedSpread: false,
    hasTruncatedSpread: false
  }
}

function resolved(value: StaticValue): InternalResult {
  return {
    status: "resolved",
    value,
    unresolvedKeys: new Set(),
    truncatedKeys: new Set(),
    hasUnresolvedSpread: false,
    hasTruncatedSpread: false
  }
}

function normaliseContext(input: EvaluationInput, extraLimits: StaticValueLimits = {}): StaticValueContext {
  if (input && isProgram(input)) return { bindings: buildStaticBindings(input), ...extraLimits }
  if (input instanceof Map) return { bindings: input, ...extraLimits }
  if (input && "bindings" in input && input.bindings instanceof Map) return { ...input, ...extraLimits }
  return { bindings: new Map(), ...(input ?? {}), ...extraLimits }
}

function evaluate(
  node: t.Node | null | undefined,
  context: StaticValueContext,
  depth: number,
  resolving: Set<string>
): InternalResult {
  if (!node) return unresolved()
  const unwrapped = unwrap(node)
  if (unwrapped !== node) return evaluate(unwrapped, context, depth, resolving)

  switch (node.type) {
    case "NullLiteral":
      return checked(resolved(null), context)
    case "StringLiteral":
      return checked(resolved(node.value), context)
    case "NumericLiteral":
      return Number.isFinite(node.value) ? checked(resolved(node.value), context) : unresolved()
    case "BooleanLiteral":
      return checked(resolved(node.value), context)
    case "TemplateLiteral":
      if (node.expressions.length !== 0) return unresolved()
      return checked(resolved(node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("")), context)
    case "UnaryExpression": {
      if (node.operator !== "+" && node.operator !== "-") return unresolved()
      const argument = evaluate(node.argument, context, depth, resolving)
      if (argument.status !== "resolved" || typeof argument.value !== "number" || !Number.isFinite(argument.value))
        return argument.status === "truncated" ? argument : unresolved()
      const value = node.operator === "-" ? -argument.value : +argument.value
      return checked(resolved(value), context)
    }
    case "Identifier": {
      const binding = context.bindings.get(node.name)
      if (!binding || resolving.has(node.name)) return unresolved()
      if (resolving.size >= MAX_STATIC_BINDING_DEPTH) return truncated()
      resolving.add(node.name)
      const result = evaluate(binding, context, depth, resolving)
      resolving.delete(node.name)
      return result
    }
    case "ArrayExpression":
      return evaluateArray(node, context, depth, resolving)
    case "ObjectExpression":
      return evaluateObject(node, context, depth, resolving)
    default:
      return unresolved()
  }
}

function evaluateArray(
  node: t.ArrayExpression,
  context: StaticValueContext,
  depth: number,
  resolving: Set<string>
): InternalResult {
  if (depth > limit(context, "maxDepth")) return truncated()
  if (node.elements.length > limit(context, "maxEntries")) return truncated()
  const values: StaticValue[] = []
  for (const element of node.elements) {
    if (!element) return unresolved()
    if (element.type === "SpreadElement") {
      const spread = evaluate(element.argument, context, depth + 1, resolving)
      if (spread.status !== "resolved" || !Array.isArray(spread.value))
        return spread.status === "truncated" ? spread : unresolved()
      if (values.length + spread.value.length > limit(context, "maxEntries")) return truncated()
      values.push(...spread.value)
      continue
    }
    const value = evaluate(element, context, depth + 1, resolving)
    if (value.status !== "resolved") return value.status === "truncated" ? value : unresolved()
    values.push(value.value as StaticValue)
  }
  return checked(resolved(values), context)
}

function evaluateObject(
  node: t.ObjectExpression,
  context: StaticValueContext,
  depth: number,
  resolving: Set<string>
): InternalResult {
  if (depth > limit(context, "maxDepth")) return truncated()

  const value = Object.create(null) as StaticObject
  const unresolvedKeys = new Set<string>()
  const truncatedKeys = new Set<string>()
  let hasUnresolvedSpread = false
  let hasTruncatedSpread = false

  const writeStatic = (key: string, child: InternalResult): void => {
    // Every explicit write supersedes diagnostics and values from earlier writes.
    unresolvedKeys.delete(key)
    truncatedKeys.delete(key)
    if (child.status === "resolved") {
      // defineProperty on an existing own key has the same insertion-order
      // behavior as ordinary JavaScript assignment.
      defineOwn(value, key, child.value as StaticValue)
      return
    }
    deleteOwn(value, key)
    if (child.status === "truncated") {
      truncatedKeys.add(key)
    } else {
      unresolvedKeys.add(key)
    }
  }

  for (const property of node.properties) {
    if (property.type === "SpreadElement") {
      const spread = evaluate(property.argument, context, depth + 1, resolving)
      if (isStaticObject(spread.value)) {
        for (const key of Object.keys(spread.value)) {
          unresolvedKeys.delete(key)
          truncatedKeys.delete(key)
          defineOwn(value, key, spread.value[key])
        }
        for (const key of spread.unresolvedKeys) {
          deleteOwn(value, key)
          truncatedKeys.delete(key)
          unresolvedKeys.add(key)
        }
        for (const key of spread.truncatedKeys) {
          deleteOwn(value, key)
          unresolvedKeys.delete(key)
          truncatedKeys.add(key)
        }
        hasUnresolvedSpread ||= spread.hasUnresolvedSpread
        hasTruncatedSpread ||= spread.hasTruncatedSpread
        continue
      }
      hasUnresolvedSpread = true
      if (spread.status === "truncated") hasTruncatedSpread = true
      // An unknown spread may overwrite every earlier key. Only explicit or
      // statically keyed writes after it remain provable.
      for (const key of Object.keys(value)) deleteOwn(value, key)
      unresolvedKeys.clear()
      truncatedKeys.clear()
      continue
    }

    const key = propertyKey(property)
    if (key === null) {
      // A computed key can overwrite any earlier key. It is represented by the
      // same conservative flag as an unresolved spread for callers deciding
      // whether inherited defaults are safe to retain.
      hasUnresolvedSpread = true
      for (const existingKey of Object.keys(value)) deleteOwn(value, existingKey)
      unresolvedKeys.clear()
      truncatedKeys.clear()
      continue
    }
    if (property.type === "ObjectMethod") {
      writeStatic(key, unresolved())
      continue
    }
    writeStatic(key, evaluate(property.value, context, depth + 1, resolving))
  }

  const result: InternalResult = {
    status:
      truncatedKeys.size > 0 || hasTruncatedSpread
        ? "truncated"
        : unresolvedKeys.size > 0 || hasUnresolvedSpread
          ? "unresolved"
          : "resolved",
    value,
    unresolvedKeys,
    truncatedKeys,
    hasUnresolvedSpread,
    hasTruncatedSpread
  }
  capObjectEntries(value, unresolvedKeys, truncatedKeys, context)
  result.status =
    truncatedKeys.size > 0 || hasTruncatedSpread
      ? "truncated"
      : unresolvedKeys.size > 0 || hasUnresolvedSpread
        ? "unresolved"
        : "resolved"
  canonicalizeObject(value)
  if (result.status === "resolved") {
    const sizeChecked = checked(result, context)
    if (sizeChecked.status !== "resolved") return sizeChecked
  }
  return result
}

function capObjectEntries(
  value: StaticObject,
  unresolvedKeys: Set<string>,
  truncatedKeys: Set<string>,
  context: StaticValueContext
): void {
  const allKeys = [...new Set([...Object.keys(value), ...unresolvedKeys, ...truncatedKeys])].sort(compareStrings)
  const maxEntries = limit(context, "maxEntries")
  if (allKeys.length <= maxEntries) return
  const retained = new Set(allKeys.slice(0, maxEntries))
  for (const key of Object.keys(value)) if (!retained.has(key)) deleteOwn(value, key)
  for (const key of [...unresolvedKeys]) {
    if (!retained.has(key)) unresolvedKeys.delete(key)
  }
  for (const key of [...truncatedKeys]) {
    if (!retained.has(key)) truncatedKeys.delete(key)
  }
  for (const key of allKeys.slice(maxEntries, maxEntries * 2)) truncatedKeys.add(key)
}

function canonicalizeObject(value: StaticObject): void {
  const entries = Object.keys(value).map((key) => [key, canonicalizeValue(value[key])] as const)
  for (const key of Object.keys(value)) deleteOwn(value, key)
  for (const [key, child] of entries.sort(([a], [b]) => compareStrings(a, b))) defineOwn(value, key, child)
}

function canonicalizeValue(value: StaticValue): StaticValue {
  if (Array.isArray(value)) return value.map(canonicalizeValue)
  if (value !== null && typeof value === "object") {
    canonicalizeObject(value)
  }
  return value
}

function propertyKey(property: t.ObjectMethod | t.ObjectProperty): string | null {
  if (property.computed) return null
  const key = property.key
  if (key.type === "Identifier") return key.name
  if (key.type === "StringLiteral") return key.value
  if (key.type === "NumericLiteral" && Number.isFinite(key.value)) return String(key.value)
  return null
}

function unwrap(node: t.Node): t.Node {
  switch (node.type) {
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
    case "TypeCastExpression":
      return node.expression
    default:
      return node
  }
}

function checked(result: InternalResult, context: StaticValueContext): InternalResult {
  if (result.status !== "resolved" || result.value === undefined) return result
  if (serializedBytes(result.value) > limit(context, "maxBytes")) return truncated()
  return result
}

function serializedBytes(value: StaticValue): number {
  const json = JSON.stringify(value)
  if (json === undefined) return Number.POSITIVE_INFINITY
  return new TextEncoder().encode(json).length
}

function toPublicObjectResult(result: InternalResult): StaticObjectResult {
  return {
    status: result.status,
    ...(result.value !== undefined && isStaticObject(result.value) ? { value: result.value } : {}),
    unresolvedKeys: [...result.unresolvedKeys].sort(compareStrings),
    truncatedKeys: [...result.truncatedKeys].sort(compareStrings),
    hasUnresolvedSpread: result.hasUnresolvedSpread
  }
}

function isStaticObject(value: StaticValue | undefined): value is StaticObject {
  return value !== null && value !== undefined && !Array.isArray(value) && typeof value === "object"
}

function limit(context: StaticValueContext, key: keyof Required<StaticValueLimits>): number {
  const value = context[key]
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_STATIC_VALUE_LIMITS[key]
}

function isProgram(value: EvaluationInput): value is t.Program {
  return !!value && typeof value === "object" && "type" in value && value.type === "Program"
}

function defineOwn(object: StaticObject, key: string, value: StaticValue): void {
  Object.defineProperty(object, key, { configurable: true, enumerable: true, writable: true, value })
}

function deleteOwn(object: StaticObject, key: string): void {
  if (Reflect.getOwnPropertyDescriptor(object, key)) Reflect.deleteProperty(object, key)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function walkAst(root: t.Node, visit: (node: t.Node) => void): void {
  const seen = new Set<object>()
  const walk = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    if (seen.has(value)) return
    seen.add(value)
    if (isAstNode(value)) visit(value)
    for (const [key, child] of Object.entries(value)) {
      if (key === "loc" || key === "start" || key === "end" || key === "extra" || key === "errors") continue
      if (Array.isArray(child)) {
        for (const item of child) walk(item)
      } else walk(child)
    }
  }
  walk(root)
}

function isAstNode(value: object): value is t.Node {
  return "type" in value && typeof (value as { type?: unknown }).type === "string"
}

function assignedNames(node: t.Node): string[] {
  if (node.type === "Identifier") return [node.name]
  if (node.type === "AssignmentPattern") return assignedNames(node.left)
  if (node.type === "RestElement") return assignedNames(node.argument)
  if (node.type === "ArrayPattern") return node.elements.flatMap((element) => (element ? assignedNames(element) : []))
  if (node.type === "ObjectPattern") {
    return node.properties.flatMap((property) => {
      if (property.type === "RestElement") return assignedNames(property.argument)
      if (property.type === "ObjectProperty") return assignedNames(property.value)
      return []
    })
  }
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") return assignedNames(node.object)
  return []
}
