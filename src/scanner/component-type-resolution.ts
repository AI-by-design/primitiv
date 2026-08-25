import * as path from "node:path"
import type * as t from "@babel/types"

export interface TypeResolutionModule {
  file: string
  content: string
  program: t.Program
}

export interface ResolvedTypeMember {
  member: t.TSPropertySignature
  content: string
}

type ModuleMap = Map<string, TypeResolutionModule>
type Member = ResolvedTypeMember
type State = { modules: ModuleMap; stack: Set<string>; cache: Map<string, Member[]>; depth: number }

/** Resolve the deliberately small, source-only subset of TypeScript prop shapes. */
export function resolveTypeMembers(opts: {
  modules: ModuleMap
  file: string
  typeNode: t.TSType
}): ResolvedTypeMember[] | null {
  const file = normalizeFile(opts.file)
  if (!opts.modules.has(file)) return null
  return resolve(opts.typeNode, file, { modules: opts.modules, stack: new Set(), cache: new Map(), depth: 0 })
}

function resolve(node: t.TSType, file: string, state: State): Member[] | null {
  if (state.depth >= 64) return null
  const current = unwrapParenthesized(node)

  if (current.type === "TSTypeLiteral") {
    const source = module(state, file)
    return source ? mergeMembers(propertyMembers(current.members, source)) : null
  }
  if (current.type === "TSIntersectionType") {
    const parts: Member[][] = []
    for (const type of current.types) {
      const resolved = resolve(type, file, nextState(state))
      if (!resolved) return null
      parts.push(resolved)
    }
    return mergeMembers(parts.flat())
  }
  if (current.type !== "TSTypeReference") return null

  if (current.typeName.type !== "Identifier") return null
  const name = current.typeName.name
  const args = typeArguments(current)
  if (name === "Pick" || name === "Omit") {
    if (args.length !== 2) return null
    const base = resolve(args[0], file, nextState(state))
    const keys = literalKeys(args[1])
    if (!base || !keys) return null
    const selected = new Set(keys)
    if (keys.some((key) => !base.some((member) => memberName(member) === key))) return null
    return name === "Pick"
      ? base.filter((member) => selected.has(memberName(member)))
      : base.filter((member) => !selected.has(memberName(member)))
  }
  if (args.length > 0) return null
  return resolveNamed(name, file, state)
}

function resolveNamed(name: string, file: string, state: State): Member[] | null {
  const key = `${file}:${name}`
  const cached = state.cache.get(key)
  if (cached) return cached
  if (state.stack.has(key)) return null
  const source = module(state, file)
  if (!source) return null
  const target = declarationTarget(source, name, state)
  if (!target) return null
  if (typeArguments(target.declaration).length > 0) return null
  const nextState = { ...state, stack: new Set([...state.stack, key]), depth: state.depth + 1 }
  let resolved: Member[] | null
  if (target.declaration.type === "TSInterfaceDeclaration") {
    const parts: Member[][] = []
    for (const heritage of target.declaration.extends ?? []) {
      if (heritage.expression.type !== "Identifier" || typeArguments(heritage).length > 0) return null
      const inherited = resolveNamed(heritage.expression.name, target.file, nextState)
      if (!inherited) return null
      parts.push(inherited)
    }
    parts.push(propertyMembers(target.declaration.body.body, target.source))
    resolved = mergeMembers(parts.flat())
  } else {
    resolved = resolve(target.declaration.typeAnnotation, target.file, nextState)
  }
  if (resolved) state.cache.set(key, resolved)
  return resolved
}

interface Target {
  declaration: t.TSInterfaceDeclaration | t.TSTypeAliasDeclaration
  file: string
  source: TypeResolutionModule
}

type TargetLookup = { kind: "found"; target: Target } | { kind: "missing" } | { kind: "invalid" }

function declarationTarget(source: TypeResolutionModule, name: string, state: State): Target | null {
  const local = localDeclaration(source.program, name)
  if (local)
    return {
      declaration: local,
      file: source.file,
      source
    }

  return importedTarget(source, name, state)
}

function localDeclaration(program: t.Program, name: string): Target["declaration"] | null {
  let found: Target["declaration"] | null = null
  for (const statement of program.body) {
    const declaration = declarationOf(statement)
    if (
      (declaration?.type === "TSInterfaceDeclaration" || declaration?.type === "TSTypeAliasDeclaration") &&
      declaration.id.name === name
    ) {
      if (found) return null
      found = declaration
    }
  }
  return found
}

function importedTarget(source: TypeResolutionModule, name: string, state: State): Target | null {
  const candidates: Target[] = []
  for (const statement of source.program.body) {
    if (statement.type === "ImportDeclaration") {
      for (const specifier of statement.specifiers) {
        if (specifier.local.name !== name) continue
        const imported =
          specifier.type === "ImportDefaultSpecifier"
            ? "default"
            : specifier.type === "ImportSpecifier"
              ? exportedName(specifier.imported)
              : null
        if (imported) {
          const target = exportedTarget(source.file, statement.source.value, imported, state)
          if (!target) return null
          candidates.push(target)
        }
      }
    }
  }
  if (candidates.length > 1) return identicalTargets(candidates) ? candidates[0] : null
  return candidates[0] ?? null
}

function exportedTarget(
  importer: string,
  specifier: string,
  name: string,
  state: State,
  seen: Set<string> = new Set()
): Target | null {
  const result = exportedTargetLookup(importer, specifier, name, state, seen)
  return result.kind === "found" ? result.target : null
}

function exportedTargetLookup(
  importer: string,
  specifier: string,
  name: string,
  state: State,
  seen: Set<string>
): TargetLookup {
  const targetFile = resolveModule(importer, specifier, state.modules)
  if (!targetFile) return { kind: "invalid" }
  const targetModule = state.modules.get(targetFile)
  if (!targetModule) return { kind: "invalid" }
  return exportedTargetFromModule(targetModule, name, state, seen)
}

function exportedTargetFromModule(
  moduleRecord: TypeResolutionModule,
  name: string,
  state: State,
  seen: Set<string>
): TargetLookup {
  const lookupKey = `${moduleRecord.file}:${name}`
  if (seen.has(lookupKey) || seen.size >= 64) return { kind: "invalid" }
  const nextSeen = new Set([...seen, lookupKey])

  const direct: Target[] = []
  for (const statement of moduleRecord.program.body) {
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration
      if (
        (declaration?.type === "TSInterfaceDeclaration" || declaration?.type === "TSTypeAliasDeclaration") &&
        declaration.id.name === name
      ) {
        direct.push({ declaration, file: moduleRecord.file, source: moduleRecord })
      }
      if (statement.source) {
        for (const specifier of statement.specifiers) {
          if (specifier.type === "ExportSpecifier" && exportedName(specifier.exported) === name) {
            const target = exportedTargetLookup(
              moduleRecord.file,
              statement.source.value,
              exportedName(specifier.local),
              state,
              nextSeen
            )
            if (target.kind !== "found") return { kind: "invalid" }
            direct.push(target.target)
          }
        }
      } else {
        for (const specifier of statement.specifiers) {
          if (specifier.type === "ExportSpecifier" && exportedName(specifier.exported) === name) {
            const localName = exportedName(specifier.local)
            const local = localDeclaration(moduleRecord.program, localName)
            const target = local
              ? { declaration: local, file: moduleRecord.file, source: moduleRecord }
              : importedTarget(moduleRecord, localName, state)
            if (!target) return { kind: "invalid" }
            direct.push(target)
          }
        }
      }
    } else if (statement.type === "ExportDefaultDeclaration" && name === "default") {
      const declaration = statement.declaration as t.Declaration
      if (declaration.type === "TSInterfaceDeclaration" || declaration.type === "TSTypeAliasDeclaration") {
        direct.push({ declaration, file: moduleRecord.file, source: moduleRecord })
      }
    }
  }
  if (name !== "default") {
    for (const statement of moduleRecord.program.body) {
      if (statement.type !== "ExportAllDeclaration") continue
      const targetFile = resolveModule(moduleRecord.file, statement.source.value, state.modules)
      if (!targetFile) return { kind: "invalid" }
      const targetModule = state.modules.get(targetFile)
      if (!targetModule) return { kind: "invalid" }
      const target = exportedTargetFromModule(targetModule, name, state, nextSeen)
      if (target.kind === "invalid") return target
      if (target.kind === "found") direct.push(target.target)
    }
  }
  if (direct.length === 0) return { kind: "missing" }
  return direct.every((target) => sameTarget(target, direct[0]))
    ? { kind: "found", target: direct[0] }
    : { kind: "invalid" }
}

function mergeMembers(members: Member[]): Member[] | null {
  const result: Member[] = []
  const byName = new Map<string, Member>()
  for (const member of members) {
    const name = memberName(member)
    const existing = byName.get(name)
    if (!existing) {
      result.push(member)
      byName.set(name, member)
      continue
    }
    if (!sameMember(existing, member)) return null
  }
  return result
}

function sameMember(a: Member, b: Member): boolean {
  return Boolean(a.member.optional) === Boolean(b.member.optional) && memberTypeText(a) === memberTypeText(b)
}

function memberTypeText(member: Member): string {
  const annotation = member.member.typeAnnotation
  if (
    !annotation ||
    typeof annotation.typeAnnotation.start !== "number" ||
    typeof annotation.typeAnnotation.end !== "number"
  )
    return "unknown"
  return member.content.slice(annotation.typeAnnotation.start, annotation.typeAnnotation.end).trim()
}

function propertyMembers(members: readonly t.TSTypeElement[], source: TypeResolutionModule): Member[] {
  return members
    .filter(
      (member): member is t.TSPropertySignature =>
        member.type === "TSPropertySignature" &&
        (member.key.type === "Identifier" || member.key.type === "StringLiteral")
    )
    .map((member) => ({ member, content: source.content }))
}

function literalKeys(node: t.TSType): string[] | null {
  const current = unwrapParenthesized(node)
  const values = current.type === "TSUnionType" ? current.types : [current]
  const keys: string[] = []
  for (const value of values) {
    const literal = unwrapParenthesized(value)
    if (literal.type !== "TSLiteralType" || literal.literal.type !== "StringLiteral") return null
    keys.push(literal.literal.value)
  }
  return keys.length > 0 && new Set(keys).size === keys.length ? keys : null
}

function typeArguments(node: t.Node): t.TSType[] {
  const record = node as unknown as Record<string, unknown>
  for (const key of ["typeArguments", "typeParameters"] as const) {
    const value = record[key]
    if (typeof value === "object" && value !== null && "params" in value && Array.isArray(value.params))
      return value.params as t.TSType[]
  }
  return []
}

function nextState(state: State): State {
  return { ...state, depth: state.depth + 1 }
}

function declarationOf(statement: t.Node): t.Declaration | null {
  if (statement.type === "ExportNamedDeclaration" && statement.declaration) return statement.declaration
  const candidate = statement as t.Declaration
  if (candidate.type === "TSInterfaceDeclaration" || candidate.type === "TSTypeAliasDeclaration") return candidate
  return null
}

function resolveModule(importer: string, specifier: string, modules: ModuleMap): string | null {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(normalizeFile(importer)), specifier))
  if (base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) return null
  const ext = path.posix.extname(base)
  if ([".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"].includes(ext)) return null
  const candidates = [".ts", ".tsx"].includes(ext)
    ? [base]
    : [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  const matches = candidates.filter((candidate) => modules.has(candidate))
  return matches.length === 1 ? matches[0] : null
}

function exportedName(node: t.Identifier | t.StringLiteral): string {
  return node.type === "Identifier" ? node.name : node.value
}

function unwrapParenthesized(node: t.TSType): t.TSType {
  return node.type === "TSParenthesizedType" ? unwrapParenthesized(node.typeAnnotation) : node
}

function module(state: State, file: string): TypeResolutionModule | null {
  return state.modules.get(normalizeFile(file)) ?? null
}

function normalizeFile(file: string): string {
  return file.split(path.sep).join("/")
}

function memberName(member: Member): string {
  const key = member.member.key
  return key.type === "Identifier" ? key.name : key.type === "StringLiteral" ? key.value : ""
}

function sameTarget(a: Target, b: Target): boolean {
  return a.file === b.file && a.declaration.start === b.declaration.start && a.declaration.end === b.declaration.end
}

function identicalTargets(targets: Target[]): boolean {
  return targets.every((target) => sameTarget(target, targets[0]))
}
