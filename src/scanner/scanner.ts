import * as fs from "node:fs"
import * as path from "node:path"
import { parse } from "@babel/parser"
import type * as t from "@babel/types"
import { glob } from "glob"
import type { CodebaseSource, Collision, ComponentKind, ComponentMap, TokenMap } from "../types"

export class CodebaseScanner {
  constructor(private config: CodebaseSource) {}

  async scan(): Promise<{
    tokens: TokenMap
    components: ComponentMap
    collisions: Collision[]
    internalCssVars: number
  }> {
    const files = await this.getFiles()
    const { tokens, internalCssVars } = await this.extractTokens(files)
    const { components, collisions } = await this.extractComponents(files)
    return { tokens, components, collisions, internalCssVars }
  }

  private async getFiles(): Promise<string[]> {
    const files: string[] = []
    for (const pattern of this.config.patterns) {
      const matches = await glob(pattern, {
        cwd: this.config.root,
        ignore: this.config.ignore,
        absolute: false
      })
      files.push(...matches)
    }
    return files
  }

  private async extractTokens(files: string[]): Promise<{ tokens: TokenMap; internalCssVars: number }> {
    const tokens: TokenMap = {
      colors: {},
      spacing: {},
      typography: {},
      borderRadius: {},
      shadows: {}
    }

    // Reference registry: base scales (e.g. Polaris `export const size = { '100': '4px' }`)
    // get collected so alias tokens that reference them (`{ value: size[100] }`) resolve to a
    // literal. Pending refs are resolved after every file is walked (refs can be forward).
    const registry = new TokenRegistry()
    const pending: PendingRef[] = []
    let internalCssVars = 0

    for (const file of files) {
      const content = fs.readFileSync(path.resolve(this.config.root, file), "utf-8")
      const ext = path.extname(file)

      if (ext === ".css") {
        internalCssVars += this.extractCSSTokens(content, file, tokens)
      } else if (ext === ".ts" || ext === ".tsx" || ext === ".jsx") {
        const program = parseProgram(content)
        if (program) this.extractTSTokens(program, file, tokens, registry, pending)
      }
    }

    for (const ref of pending) {
      const value = registry.resolve(ref.ref)
      if (value !== undefined && isDesignValue(value)) {
        this.addToken({ tokens, name: ref.name, value, groupKey: ref.groupKey, file: ref.file, line: ref.line })
      }
    }

    return { tokens, internalCssVars }
  }

  // Returns the count of component-internal vars that were dropped (logged by the build).
  // A var is a design token only if its innermost selector is global (`:root`/`:host`/`html`/
  // `@theme`). Vars defined inside a component selector (`.root`, `.Thumbnail`) or matching a
  // component-prefix convention (`--pc-`) are component-internal implementation detail, not the
  // design-token scale — so they're excluded from the buckets and counted instead.
  private extractCSSTokens(content: string, file: string, tokens: TokenMap): number {
    let internal = 0

    for (const decl of cssCustomProperties(content)) {
      const value = decl.value.trim()

      // Skip aliases — tokens whose value is just a var() reference to another token.
      if (/^var\(--[\w-]+\)$/.test(value)) continue

      if (!isGlobalSelector(decl.selector) || isComponentInternalVar(decl.name)) {
        internal++
        continue
      }

      const category = this.categorizeToken(decl.name, value)
      if (!tokens[category]) tokens[category] = {}
      tokens[category][decl.name] = {
        name: decl.name,
        value,
        source: { adapter: "codebase", file, line: decl.line }
      }
    }

    return internal
  }

  // Walk exported object literals (`export const theme = {…} as const`, `export default {…}`)
  // and pull design tokens from leaf properties. Categorize by the top-level group key first
  // (`border` → borderRadius, `space` → spacing) and fall back to value/name when the group is
  // unknown — the same shape-not-name discipline the component detector uses, so an unrecognized
  // group key doesn't silently drop its tokens. Leaf values are gated by `isDesignValue` so
  // Tailwind className strings (`createTheme({ root: { base: "flex h-fit …" } })`) never leak in.
  private extractTSTokens(program: t.Program, file: string, tokens: TokenMap, registry: TokenRegistry, pending: PendingRef[]): void {
    for (const [exportName, objectExpr] of exportedObjectLiterals(program)) {
      registry.collect(exportName, objectExpr)
      walkTokenObject({
        node: objectExpr,
        pathParts: [],
        exportName,
        onLeaf: (name, valueNode, groupKey, line) => {
          const literal = literalValue(valueNode)
          if (literal !== undefined) {
            if (isDesignValue(literal)) this.addToken({ tokens, name, value: literal, groupKey, file, line })
            return
          }
          const ref = referenceTarget(valueNode)
          if (ref) pending.push({ name, ref, groupKey, file, line })
        }
      })
    }
  }

  private addToken(opts: { tokens: TokenMap; name: string; value: string; groupKey: string; file: string; line: number }): void {
    const { tokens, name, value, groupKey, file, line } = opts
    const category = categorizeByGroup(groupKey) ?? this.categorizeToken(name, value)
    if (!tokens[category]) tokens[category] = {}
    // First write wins, mirroring the CSS path — provenance points at the earliest definition.
    if (tokens[category][name]) return
    tokens[category][name] = { name, value, source: { adapter: "codebase", file, line } }
  }

  private categorizeToken(rawName: string, value: string): string {
    const name = rawName.toLowerCase()
    // A color value is a strong signal — it wins regardless of the name.
    if (
      value.startsWith("#") ||
      value.startsWith("rgb") ||
      value.startsWith("hsl") ||
      value.startsWith("oklch") ||
      value.startsWith("oklab")
    )
      return "colors"
    // Specific name patterns first, BEFORE the broad color-name net — otherwise `border-radius`
    // and `border-width` get swallowed by the `border` → colors heuristic. Typography precedes
    // spacing so `letter-spacing`/`line-height` don't get pulled into spacing/sizes.
    if (
      name.includes("font") ||
      // Separator-agnostic so camelCase `lineHeight` (→ `lineheight`) and `LINE_HEIGHT`
      // (→ `line_height`) both land here and don't fall through to the `height` → sizes branch.
      /line[-_ ]?height/.test(name) ||
      name.includes("leading") ||
      name.includes("letter") ||
      name.includes("tracking") ||
      name.includes("text-")
    )
      return "typography"
    if (name.includes("radius") || name.includes("rounded")) return "borderRadius"
    if (name.includes("shadow") || name.includes("elevation")) return "shadows"
    if (name.includes("z-index") || name.includes("zindex") || name.includes("stacking")) return "zIndex"
    if (name.includes("breakpoint") || name.includes("screen")) return "breakpoints"
    if (
      name.includes("duration") ||
      name.includes("easing") ||
      name.includes("transition") ||
      name.includes("animation") ||
      name.includes("animate") ||
      name.includes("motion") ||
      name.includes("delay")
    )
      return "motion"
    // Sizing scale — width/height/size dimensions (icon sizes, container widths, `border-width`).
    // Before the color-name net so `border-width` / `sidebar-width` read as dimensions, not colors
    // (a width/height/size word is a stronger signal than a co-occurring color word like `border`).
    if (name.includes("width") || name.includes("height") || name.includes("size") || name.includes("diameter"))
      return "sizes"
    // Broad color-name net (covers `--border`, `--bg`, `--primary`, shadcn-style HSL channels
    // whose value isn't a recognizable color prefix). Runs after the specific patterns above.
    if (
      name.includes("color") ||
      name.includes("bg") ||
      name.includes("background") ||
      name.includes("foreground") ||
      name.includes("border") ||
      name.includes("ring") ||
      name.includes("primary") ||
      name.includes("secondary") ||
      name.includes("muted") ||
      name.includes("accent") ||
      name.includes("destructive") ||
      name.includes("popover") ||
      name.includes("card") ||
      name.includes("sidebar") ||
      name.includes("chart") ||
      name.includes("breach")
    )
      return "colors"
    if (
      name.includes("spacing") ||
      name.includes("space") ||
      name.includes("margin") ||
      name.includes("padding") ||
      name.includes("gap") ||
      name.includes("inset")
    )
      return "spacing"
    return "other"
  }

  private async extractComponents(files: string[]): Promise<{ components: ComponentMap; collisions: Collision[] }> {
    const components: ComponentMap = {}
    const collided: Record<string, string[]> = {}
    const componentFiles = files.filter((f) => f.endsWith(".tsx") || f.endsWith(".jsx"))

    for (const file of componentFiles) {
      const content = fs.readFileSync(path.resolve(this.config.root, file), "utf-8")
      for (const found of componentsInFile(content, file)) {
        const existing = components[found.name]
        if (existing) {
          // Same-name collision: keep the first, record the rest so the loss isn't silent.
          // (Coexistence via path-qualified identity is the Option-C work — see COMPONENT_IDENTITY_PLAN.md.)
          if (!collided[found.name]) collided[found.name] = [existing.source.file ?? "?"]
          collided[found.name].push(file)
          continue
        }
        components[found.name] = {
          name: found.name,
          kind: found.kind,
          source: { adapter: "codebase", file, line: found.line },
          props: this.extractProps(content)
        }
      }
    }

    const collisions: Collision[] = Object.entries(collided).map(([name, fileList]) => ({ name, files: fileList }))
    return { components, collisions }
  }

  private extractProps(content: string): Record<string, { type: string; required: boolean }> {
    const props: Record<string, { type: string; required: boolean }> = {}

    const propsMatch = content.match(/(?:interface|type)\s+\w*[Pp]rops\s*(?:=\s*)?{([^}]+)}/s)
    if (!propsMatch) return props

    const propsContent = propsMatch[1]
    const propRegex = /(\w+)(\?)?\s*:\s*([^;\n]+)/g

    for (const match of propsContent.matchAll(propRegex)) {
      const [, name, optional, type] = match
      props[name] = {
        type: type.trim(),
        required: !optional
      }
    }

    return props
  }
}

interface FoundComponent {
  name: string
  line: number
  kind: ComponentKind
}

// Parse a TS/JSX file and return the components it DEFINES and EXPORTS (definition-site only).
// Bare `export { X } from "..."` re-exports are ignored — the definition is found at its source,
// which also avoids barrel-file false collisions. Local `export { X }` (no source) is followed
// to the in-file declaration.
function componentsInFile(content: string, file: string): FoundComponent[] {
  const program = parseProgram(content)
  if (!program) return []

  const localInit = new Map<string, { node: t.Node; line: number }>()
  const exported = new Set<string>()
  const found: FoundComponent[] = []

  const remember = (decl: t.Declaration): string[] => {
    const names: string[] = []
    if ((decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") && decl.id) {
      localInit.set(decl.id.name, { node: decl, line: lineOf(decl) })
      names.push(decl.id.name)
    } else if (decl.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        if (d.id.type === "Identifier" && d.init) {
          localInit.set(d.id.name, { node: d.init, line: lineOf(d) })
          names.push(d.id.name)
        }
      }
    }
    return names
  }

  for (const stmt of program.body) {
    if (
      stmt.type === "FunctionDeclaration" ||
      stmt.type === "ClassDeclaration" ||
      stmt.type === "VariableDeclaration"
    ) {
      remember(stmt)
    } else if (stmt.type === "ExportNamedDeclaration") {
      if (stmt.declaration) {
        for (const name of remember(stmt.declaration)) exported.add(name)
      } else if (!stmt.source) {
        for (const spec of stmt.specifiers) {
          if (spec.type === "ExportSpecifier" && spec.local.type === "Identifier") exported.add(spec.local.name)
        }
      }
      // `export { X } from "..."` (stmt.source set) is a re-export — ignored.
    } else if (stmt.type === "ExportDefaultDeclaration") {
      const d = stmt.declaration
      if ((d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") && d.id) {
        if (isComponentNode(d))
          found.push({ name: d.id.name, line: lineOf(d), kind: classifyComponent(d.id.name, file) })
      } else if (isComponentNode(d)) {
        const name = path.basename(file, path.extname(file))
        if (/^[A-Z]/.test(name)) found.push({ name, line: lineOf(d), kind: classifyComponent(name, file) })
      }
    }
  }

  for (const name of exported) {
    if (!/^[A-Z]/.test(name) || found.some((f) => f.name === name)) continue
    const decl = localInit.get(name)
    if (decl && isComponentNode(decl.node)) {
      found.push({ name, line: decl.line, kind: classifyComponent(name, file) })
    }
  }

  return found
}

// A node is a component if it is (or wraps) a function/class that returns JSX, or a styled() factory.
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

// A factory/HOC call that produces a component: `styled(...)`, or any wrapper whose argument is a
// JSX-returning function — forwardRef, memo, Mantine's factory()/polymorphicFactory(), observer(), etc.
// Detected by shape (a JSX-returning argument), not a hard-coded wrapper name, so it doesn't rot.
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
    (a) => a.type !== "SpreadElement" && a.type !== "ArgumentPlaceholder" && isComponentNode(a)
  )
}

// `styled.div\`...\`` or `styled(Base)\`...\``
function isStyledTag(tag: t.Expression): boolean {
  if (tag.type === "MemberExpression" && tag.object.type === "Identifier" && tag.object.name === "styled") return true
  return tag.type === "CallExpression" && tag.callee.type === "Identifier" && tag.callee.name === "styled"
}

// Does this subtree contain a JSX element/fragment anywhere?
function containsJSX(node: t.Node): boolean {
  if (node.type === "JSXElement" || node.type === "JSXFragment") return true
  const record = node as unknown as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key === "loc" || key === "start" || key === "end" || key === "leadingComments" || key === "trailingComments") {
      continue
    }
    const value = record[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item) && containsJSX(item)) return true
      }
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

function parseProgram(content: string): t.Program | null {
  try {
    return parse(content, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true }).program
  } catch {
    return null
  }
}

// ─── TS theme-token extraction (AST) ──────────────────────────────────────────

interface TokenRef {
  obj: string
  key: string
}

interface PendingRef {
  name: string
  ref: TokenRef
  groupKey: string
  file: string
  line: number
}

// Base scales (e.g. `export const size = { '100': '4px' }`) get collected so alias tokens that
// reference them (`{ value: size[100] }`) can resolve to a literal once every file is walked.
class TokenRegistry {
  private maps = new Map<string, Map<string, string>>()

  collect(exportName: string, obj: t.ObjectExpression): void {
    for (const prop of obj.properties) {
      if (prop.type !== "ObjectProperty") continue
      const key = propertyKey(prop)
      if (key === null) continue
      const value = literalValue(prop.value)
      if (value === undefined) continue
      let m = this.maps.get(exportName)
      if (!m) {
        m = new Map()
        this.maps.set(exportName, m)
      }
      if (!m.has(key)) m.set(key, value)
    }
  }

  resolve(ref: TokenRef): string | undefined {
    return this.maps.get(ref.obj)?.get(ref.key)
  }
}

// Exported object literals, by name. Handles the direct forms (`export const X = {…}`,
// `export const X = {…} as const`, `export default {…}`) and the definition-site forms where the
// object is a local const that's exported by reference (`const theme = {…}; export default theme`
// or `export { theme }`) — common in Tailwind/theme configs. Re-exports (`export { X } from …`)
// are skipped; the definition is found when that source file is scanned.
function exportedObjectLiterals(program: t.Program): Array<[string, t.ObjectExpression]> {
  const locals = new Map<string, t.ObjectExpression>()
  for (const stmt of program.body) {
    const decl = stmt.type === "ExportNamedDeclaration" ? stmt.declaration : stmt
    if (decl?.type === "VariableDeclaration") {
      for (const d of decl.declarations) {
        const obj = unwrapObject(d.init)
        if (d.id.type === "Identifier" && obj) locals.set(d.id.name, obj)
      }
    }
  }

  const out: Array<[string, t.ObjectExpression]> = []
  const seen = new Set<string>()
  const add = (name: string, obj: t.ObjectExpression): void => {
    if (seen.has(name)) return
    seen.add(name)
    out.push([name, obj])
  }

  for (const stmt of program.body) {
    if (stmt.type === "ExportNamedDeclaration") {
      if (stmt.declaration?.type === "VariableDeclaration") {
        for (const d of stmt.declaration.declarations) {
          const obj = unwrapObject(d.init)
          if (d.id.type === "Identifier" && obj) add(d.id.name, obj)
        }
      } else if (!stmt.source) {
        for (const spec of stmt.specifiers) {
          if (spec.type === "ExportSpecifier" && spec.local.type === "Identifier") {
            const obj = locals.get(spec.local.name)
            if (obj) add(spec.local.name, obj)
          }
        }
      }
    } else if (stmt.type === "ExportDefaultDeclaration") {
      const direct = unwrapObject(stmt.declaration)
      if (direct) add("default", direct)
      else if (stmt.declaration.type === "Identifier") {
        const obj = locals.get(stmt.declaration.name)
        if (obj) add(stmt.declaration.name, obj)
      }
    }
  }
  return out
}

function unwrapObject(node: t.Node | null | undefined): t.ObjectExpression | null {
  let n: t.Node | null | undefined = node
  while (
    n &&
    (n.type === "TSAsExpression" ||
      n.type === "TSSatisfiesExpression" ||
      n.type === "ParenthesizedExpression" ||
      n.type === "TSNonNullExpression")
  ) {
    n = n.expression
  }
  return n && n.type === "ObjectExpression" ? n : null
}

interface WalkTokenOpts {
  node: t.ObjectExpression
  pathParts: string[]
  exportName: string
  onLeaf: (name: string, valueNode: t.Node, groupKey: string, line: number) => void
  depth?: number
}

function walkTokenObject(opts: WalkTokenOpts): void {
  const { node, pathParts, exportName, onLeaf } = opts
  const depth = opts.depth ?? 0
  if (depth > 6) return
  for (const prop of node.properties) {
    if (prop.type !== "ObjectProperty") continue
    const key = propertyKey(prop)
    if (key === null) continue
    const nextPath = [...pathParts, key]

    // Meta-token wrapper `{ value: <literal> }` (Polaris / W3C-DTCG shape) — treat as a leaf.
    const meta = metaTokenValue(prop.value)
    if (meta) {
      emitLeaf(nextPath, exportName, meta, onLeaf)
      continue
    }
    const inner = unwrapObject(prop.value)
    if (inner) {
      walkTokenObject({ node: inner, pathParts: nextPath, exportName, onLeaf, depth: depth + 1 })
      continue
    }
    if (prop.value.type === "ArrayExpression") {
      prop.value.elements.forEach((el, idx) => {
        if (el && el.type !== "SpreadElement") emitLeaf([...nextPath, String(idx)], exportName, el, onLeaf)
      })
      continue
    }
    emitLeaf(nextPath, exportName, prop.value, onLeaf)
  }
}

function emitLeaf(
  pathParts: string[],
  exportName: string,
  valueNode: t.Node,
  onLeaf: (name: string, valueNode: t.Node, groupKey: string, line: number) => void
): void {
  // Group key drives categorization (nested groups use their first segment; flat token objects
  // use the export name). The name is the full path so it stays unique across the contract.
  const groupKey = pathParts.length >= 2 ? pathParts[0] : exportName
  onLeaf(tokenName(exportName, pathParts), valueNode, groupKey, lineOf(valueNode))
}

function tokenName(exportName: string, pathParts: string[]): string {
  if (pathParts.length === 1) {
    const only = pathParts[0]
    // Prefix a flat scale step (`100`, `md`) with its export so `size.100` → `size-100`, but don't
    // double up when the key already carries the group (`border['border-radius-100']`).
    return only.toLowerCase().startsWith(exportName.toLowerCase()) ? only : `${exportName}-${only}`
  }
  return pathParts.join("-")
}

function propertyKey(prop: t.ObjectProperty): string | null {
  const k = prop.key
  if (k.type === "Identifier") return k.name
  if (k.type === "StringLiteral") return k.value
  if (k.type === "NumericLiteral") return String(k.value)
  return null
}

function metaTokenValue(node: t.Node): t.Node | null {
  const obj = unwrapObject(node)
  if (!obj) return null
  for (const prop of obj.properties) {
    if (prop.type !== "ObjectProperty") continue
    const k = propertyKey(prop)
    if (k === "value" || k === "$value") return prop.value
  }
  return null
}

function literalValue(node: t.Node): string | undefined {
  switch (node.type) {
    case "StringLiteral":
      return node.value
    case "NumericLiteral":
      return String(node.value)
    case "UnaryExpression":
      return node.operator === "-" && node.argument.type === "NumericLiteral" ? String(-node.argument.value) : undefined
    case "TemplateLiteral":
      return node.expressions.length === 0 ? node.quasis.map((q) => q.value.cooked ?? "").join("") : undefined
    default:
      return undefined
  }
}

// `size[100]`, `size['100']`, `palette.blue` → a resolvable reference into the registry.
function referenceTarget(node: t.Node): TokenRef | undefined {
  if (node.type !== "MemberExpression" || node.object.type !== "Identifier") return undefined
  const obj = node.object.name
  const p = node.property
  if (node.computed) {
    if (p.type === "StringLiteral") return { obj, key: p.value }
    if (p.type === "NumericLiteral") return { obj, key: String(p.value) }
    return undefined
  }
  return p.type === "Identifier" ? { obj, key: p.name } : undefined
}

// Map a known token-group key to a category. Returns null for ambiguous groups (`border` mixes
// radius + width; `size` mixes spacing + dimension) so the full-name/value path decides — the
// same shape-not-name discipline the component detector uses, so a group we didn't enumerate
// still gets categorized by value instead of silently dropped.
function categorizeByGroup(groupKey: string): string | null {
  const g = groupKey.toLowerCase()
  if (/(boxshadow|shadow|elevation)/.test(g)) return "shadows"
  if (/(zindex|zindices)/.test(g)) return "zIndex"
  if (/(breakpoint|screens)/.test(g)) return "breakpoints"
  if (/(duration|transition|motion|easing|animation)/.test(g)) return "motion"
  if (/(borderradius|radii|radius|rounded|corner)/.test(g)) return "borderRadius"
  if (/(spacing|^space$)/.test(g)) return "spacing"
  if (/(fontsize|fontweight|lineheight|letterspacing|typography|^font$|^fonts$)/.test(g)) return "typography"
  if (/(^color$|^colors$|palette)/.test(g)) return "colors"
  return null
}

// A leaf value is a design token only if it reads as a CSS value: every whitespace/comma
// separated (paren-aware) part is a dimension, number, color, function, or known keyword. This is
// what rejects Tailwind className strings (`"flex h-fit items-center hover:bg-cyan-200"`) that
// live in `createTheme({…})` objects without hard-coding a list of class prefixes to exclude.
function isDesignValue(raw: string): boolean {
  const v = raw.trim()
  if (v === "" || v.length > 200) return false
  const parts = splitTopLevelValue(v)
  return parts.length > 0 && parts.every(isValuePart)
}

function splitTopLevelValue(v: string): string[] {
  const parts: string[] = []
  let cur = ""
  let depth = 0
  for (const c of v) {
    if (c === "(") {
      depth++
      cur += c
    } else if (c === ")") {
      if (depth > 0) depth--
      cur += c
    } else if (depth === 0 && (/\s/.test(c) || c === ",")) {
      if (cur) parts.push(cur)
      cur = ""
    } else {
      cur += c
    }
  }
  if (cur) parts.push(cur)
  return parts
}

const VALUE_KEYWORDS = new Set([
  "none",
  "auto",
  "transparent",
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "normal",
  "bold",
  "bolder",
  "lighter",
  "italic",
  "oblique",
  "solid",
  "dashed",
  "dotted",
  "double",
  "groove",
  "ridge",
  "inset",
  "outset",
  "hidden"
])

function isValuePart(p: string): boolean {
  if (
    /^-?(\d+\.?\d*|\.\d+)(px|rem|em|ex|ch|%|vw|vh|vmin|vmax|pt|pc|cm|mm|in|q|fr|deg|rad|grad|turn|ms|s|x|dpi|dppx)?$/i.test(
      p
    )
  )
    return true
  if (/^#[0-9a-f]{3,8}$/i.test(p)) return true
  if (/^(rgba?|hsla?|hwb|oklch|oklab|lab|lch|color|var|calc|min|max|clamp|env)\(/i.test(p)) return true
  return VALUE_KEYWORDS.has(p.toLowerCase())
}

// ─── CSS custom-property extraction (selector-scope aware) ─────────────────────

interface CssDecl {
  name: string
  value: string
  selector: string
  line: number
}

// Walk CSS and yield each custom property with the innermost selector that scopes it.
// Brace/paren/quote/comment-aware so a value or selector containing `;`/`{`/`}` doesn't corrupt
// the scope stack. Deliberately lightweight — no postcss dependency for the one fact we need.
function cssCustomProperties(css: string): CssDecl[] {
  const out: CssDecl[] = []
  const stack: string[] = []
  let token = ""
  let tokenLine = 1
  let started = false
  let line = 1
  let quote = ""
  let paren = 0

  const append = (c: string): void => {
    if (!started && !/\s/.test(c)) {
      started = true
      tokenLine = line
    }
    token += c
  }
  const reset = (): void => {
    token = ""
    started = false
  }
  const flush = (): void => {
    const decl = token.trim()
    reset()
    if (!decl.startsWith("--")) return
    const colon = decl.indexOf(":")
    if (colon === -1) return
    const name = decl.slice(2, colon).trim()
    const value = decl.slice(colon + 1).trim()
    if (name && value) out.push({ name, value, selector: stack[stack.length - 1] ?? "", line: tokenLine })
  }

  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (quote) {
      append(c)
      if (c === "\n") line++
      if (c === quote && css[i - 1] !== "\\") quote = ""
      continue
    }
    if (c === "\n") {
      line++
      append(c)
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      append(c)
      continue
    }
    if (c === "/" && css[i + 1] === "*") {
      i += 2
      while (i < css.length && !(css[i] === "*" && css[i + 1] === "/")) {
        if (css[i] === "\n") line++
        i++
      }
      i++
      continue
    }
    if (c === "(") {
      paren++
      append(c)
      continue
    }
    if (c === ")") {
      if (paren > 0) paren--
      append(c)
      continue
    }
    if (paren > 0) {
      append(c)
      continue
    }
    if (c === "{") {
      stack.push(token.trim())
      reset()
      continue
    }
    if (c === "}") {
      flush()
      stack.pop()
      continue
    }
    if (c === ";") {
      flush()
      continue
    }
    append(c)
  }
  return out
}

// A custom property is a global design token when its innermost selector targets the document
// root / element-wide scope. Vars defined inside a component selector (`.root`, `.Thumbnail`) are
// component-internal implementation detail, not the design-token scale.
function isGlobalSelector(selector: string): boolean {
  const s = selector.trim().toLowerCase()
  if (s === "") return true
  if (s.startsWith("@theme") || s.startsWith("@property")) return true
  return s.split(",").some((part) => {
    const p = part.trim()
    return (
      p === "*" ||
      /^:root\b/.test(p) ||
      /^:host\b/.test(p) ||
      /^html\b/.test(p) ||
      /^body\b/.test(p) ||
      p.includes(":root") ||
      p.includes(":host") ||
      p.includes(":global")
    )
  })
}

// Component-prefix conventions: vars a design system namespaces per-component rather than as
// global tokens. Polaris uses `--pc-` (Polaris Component). Extend as new conventions surface.
function isComponentInternalVar(name: string): boolean {
  return name.startsWith("pc-")
}
