import * as fs from "node:fs"
import * as path from "node:path"
import { parse } from "@babel/parser"
import type * as t from "@babel/types"
import { glob } from "glob"
import { valuesEquivalent } from "../normalize/value"
import type { CodebaseSource, ComponentMap, TokenCategory, TokenMap, TokenRedefinition } from "../types"
import { emptyTokenMap } from "../types"
import { ComponentAnalyzer } from "./component-analysis"

export class CodebaseScanner {
  constructor(private config: CodebaseSource) {}

  async scan(): Promise<{
    tokens: TokenMap
    components: ComponentMap
    internalCssVars: number
    redefinitions: TokenRedefinition[]
  }> {
    const files = await this.getFiles()
    const componentAnalyzer = new ComponentAnalyzer()
    const { tokens, internalCssVars, redefinitions } = await this.extractTokens(files, componentAnalyzer)
    const components = componentAnalyzer.finish()
    return { tokens, components, internalCssVars, redefinitions }
  }

  private async getFiles(): Promise<string[]> {
    const files: string[] = []
    for (const pattern of this.config.patterns) {
      const matches = await glob(pattern, {
        cwd: this.config.root,
        ignore: this.config.ignore,
        // A directory can match a source pattern on name alone — `node_modules/ipaddr.js`
        // matches `**/*.js`. Reading it throws EISDIR and fails the entire scan.
        nodir: true,
        absolute: false
      })
      files.push(...matches)
    }
    // glob returns filesystem enumeration order, which varies across machines. Scan order
    // decides which definition "first write wins" keeps — sort so the kept value (and the
    // contract as a whole) is deterministic everywhere, not per-platform.
    return [...new Set(files)].sort()
  }

  private async extractTokens(
    files: string[],
    componentAnalyzer: ComponentAnalyzer
  ): Promise<{
    tokens: TokenMap
    internalCssVars: number
    redefinitions: TokenRedefinition[]
  }> {
    const tokens: TokenMap = emptyTokenMap()

    // Reference registry: base scales (e.g. Polaris `export const size = { '100': '4px' }`)
    // get collected so alias tokens that reference them (`{ value: size[100] }`) resolve to a
    // literal. Pending refs are resolved after every file is walked (refs can be forward).
    const registry = new TokenRegistry()
    const pending: PendingRef[] = []
    // Same-name-different-value definitions within this scan, and which stored tokens came
    // from a conditional (at-rule) scope — both feed the shared write discipline below.
    const capture: WriteCapture = { redefs: new Map(), conditionalKeys: new Set(), promotedKeys: new Set() }
    let internalCssVars = 0

    for (const file of files) {
      const content = fs.readFileSync(path.resolve(this.config.root, file), "utf-8")
      const ext = path.extname(file)

      if (ext === ".css") {
        internalCssVars += this.extractCSSTokens({ content, file, tokens, capture })
      } else if (ext === ".ts" || ext === ".tsx" || ext === ".jsx") {
        const parsed = parseProgram(content)
        if (parsed) {
          this.extractTSTokens(parsed.program, file, tokens, registry, pending, capture)
          if (!parsed.recovered) {
            componentAnalyzer.addModule(
              { content, file, program: parsed.program },
              { analyzeComponents: ext === ".tsx" || ext === ".jsx" }
            )
          }
        }
      }
    }

    for (const ref of pending) {
      const value = registry.resolve(ref.ref)
      if (value !== undefined && isDesignValue(value)) {
        this.addToken({
          tokens,
          name: ref.name,
          value,
          groupKey: ref.groupKey,
          file: ref.file,
          line: ref.line,
          capture
        })
      }
    }

    return { tokens, internalCssVars, redefinitions: [...capture.redefs.values()] }
  }

  // Returns the count of component-internal vars that were dropped (logged by the build).
  // A var is a design token when its scope is global (`:root`/`:host`/`html`/`@theme`) or a theme
  // variant (`.dark`, `[data-theme="dim"]`, `@media (prefers-color-scheme: …)`) — theme values
  // land in the token's `modes` map rather than as separate tokens. Vars inside a component
  // selector (`.root`, `.Thumbnail`) or matching a component-prefix convention (`--pc-`) are
  // component-internal implementation detail, not the token scale — excluded and counted instead.
  private extractCSSTokens(opts: { content: string; file: string; tokens: TokenMap; capture: WriteCapture }): number {
    const { content, file, tokens, capture } = opts
    let internal = 0

    for (const decl of cssCustomProperties(content)) {
      const value = decl.value.trim()

      // Skip aliases — tokens whose value is just a var() reference to another token.
      if (/^var\(--[\w-]+\)$/.test(value)) continue

      const scope = classifySelectorScope(decl.selectors)
      // Component-scoped vars, and the `--pc-` component-prefix convention, are implementation
      // detail, not the token scale — excluded and counted. The name check wins over scope, so a
      // `--pc-*` var inside a theme selector still stays component-internal.
      if (scope.kind === "component" || isComponentInternalVar(decl.name)) {
        internal++
        continue
      }

      const category = this.categorizeToken(decl.name, value)
      this.writeToken({
        tokens,
        capture,
        category,
        name: decl.name,
        value,
        source: { adapter: "codebase", file, line: decl.line },
        conditional: scope.conditional,
        mode: scope.mode
      })
    }

    return internal
  }

  // Walk exported object literals (`export const theme = {…} as const`, `export default {…}`)
  // and pull design tokens from leaf properties. Categorize by the top-level group key first
  // (`border` → borderRadius, `space` → spacing) and fall back to value/name when the group is
  // unknown — the same shape-not-name discipline the component detector uses, so an unrecognized
  // group key doesn't silently drop its tokens. Leaf values are gated by `isDesignValue` so
  // Tailwind className strings (`createTheme({ root: { base: "flex h-fit …" } })`) never leak in.
  private extractTSTokens(
    program: t.Program,
    file: string,
    tokens: TokenMap,
    registry: TokenRegistry,
    pending: PendingRef[],
    capture: WriteCapture
  ): void {
    for (const [exportName, objectExpr] of exportedObjectLiterals(program)) {
      registry.collect(exportName, objectExpr)
      walkTokenObject({
        node: objectExpr,
        pathParts: [],
        exportName,
        onLeaf: (name, valueNode, groupKey, line) => {
          const literal = literalValue(valueNode)
          if (literal !== undefined) {
            if (isDesignValue(literal)) {
              this.addToken({ tokens, name, value: literal, groupKey, file, line, capture })
            }
            return
          }
          const ref = referenceTarget(valueNode)
          if (ref) pending.push({ name, ref, groupKey, file, line })
        }
      })
    }
  }

  private addToken(opts: {
    tokens: TokenMap
    name: string
    value: string
    groupKey: string
    file: string
    line: number
    capture: WriteCapture
  }): void {
    const { tokens, name, value, groupKey, file, line, capture } = opts
    const category = categorizeByGroup(groupKey) ?? this.categorizeToken(name, value)
    this.writeToken({
      tokens,
      capture,
      category,
      name,
      value,
      source: { adapter: "codebase", file, line },
      conditional: false
    })
  }

  // The one write path for both extraction pipelines (CSS + TS). First write wins so
  // provenance points at the earliest definition — and a later definition with a DIFFERENT
  // value is captured as a redefinition for ContractBuilder to surface (rule 11), instead of
  // silently losing one of the two. Conditional (at-rule) definitions are the exception:
  // a responsive `@media { :root { --space: 12px } }` override is a legitimate second value,
  // so it never wins over an unconditional definition and never counts as a redefinition.
  private writeToken(opts: {
    tokens: TokenMap
    capture: WriteCapture
    category: string
    name: string
    value: string
    source: { adapter: "codebase"; file: string; line: number }
    conditional: boolean
    mode?: string
  }): void {
    const { tokens, capture, category, name, value, source, conditional, mode } = opts
    if (!tokens[category]) tokens[category] = {}
    const key = `${category} ${name}`
    const existing = tokens[category][name]

    if (mode) {
      // A theme-scoped value routes into the token's `modes` map, never the default — a theme
      // value IS the same token in another mode, not a redefinition of it.
      if (!existing) {
        // No `:root` default seen yet (e.g. cal.com's `.dark`-only `--cal-*`): promote the mode
        // value to a placeholder default so the token exists, and record the mode. A real default
        // arriving later upgrades it (promotedKeys) while keeping the collected modes.
        tokens[category][name] = {
          name,
          value,
          source,
          modes: { [mode]: value },
          modeSources: { [mode]: source }
        }
        capture.promotedKeys.add(key)
        return
      }
      const token = tokens[category][name]
      if (!token.modes) token.modes = {}
      if (!token.modeSources) token.modeSources = {}
      // First value per mode wins, matching the default's first-write-wins discipline.
      if (!(mode in token.modes)) {
        token.modes[mode] = value
        token.modeSources[mode] = source
      }
      return
    }

    if (!existing) {
      tokens[category][name] = { name, value, source }
      if (conditional) capture.conditionalKeys.add(key)
      return
    }

    // A real unconditional default upgrades over a placeholder — one promoted from a theme mode,
    // or one seen only under a conditional (at-rule) scope — while preserving collected modes.
    if (!conditional && (capture.promotedKeys.has(key) || capture.conditionalKeys.has(key))) {
      tokens[category][name] = { ...existing, name, value, source }
      capture.promotedKeys.delete(key)
      capture.conditionalKeys.delete(key)
      return
    }

    if (valuesEquivalent(existing.value, value, category) || conditional) return

    const redef = capture.redefs.get(key)
    if (redef) {
      redef.discarded.push({ value, source })
    } else {
      capture.redefs.set(key, {
        category,
        name,
        kept: { value: existing.value, source: existing.source },
        discarded: [{ value, source }]
      })
    }
  }

  private categorizeToken(rawName: string, value: string): TokenCategory | "other" {
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
}

// Scan-scoped state for the shared token write path: redefinitions found so far (keyed by
// category+name), which stored tokens came from a conditional scope, and which stored tokens
// have only a placeholder default promoted from a theme mode (no real `:root` definition yet).
interface WriteCapture {
  redefs: Map<string, TokenRedefinition>
  conditionalKeys: Set<string>
  promotedKeys: Set<string>
}

function lineOf(node: t.Node): number {
  return node.loc?.start.line ?? 1
}

function parseProgram(content: string): { program: t.Program; recovered: boolean } | null {
  try {
    const result = parse(content, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true })
    return { program: result.program, recovered: result.errors.length > 0 }
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
function categorizeByGroup(groupKey: string): TokenCategory | null {
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
  // The full frame stack scoping this declaration, outermost → innermost: at-rule frames
  // (`@media …`, `@theme`) and selector frames (`:root`, `.dark`). classifySelectorScope reads
  // the whole stack so it can distinguish a `@media (prefers-color-scheme: …)` theme mode from a
  // plain responsive override, and see both the media condition and the inner selector at once.
  selectors: string[]
  line: number
}

// Walk CSS and yield each custom property with the full frame stack that scopes it.
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
    if (name && value) {
      out.push({ name, value, selectors: [...stack], line: tokenLine })
    }
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

// The scope a custom property is declared in. `token` = part of the design-token scale (a
// document-root or theme-variant scope); `component` = implementation detail, excluded. A `token`
// carries `mode` when it is theme-scoped (the value belongs in the token's `modes` map, not the
// default) and `conditional` when wrapped in a non-theme at-rule (a responsive override that must
// not win over or conflict with the unconditional value — see writeToken).
type SelectorScope = { kind: "component" } | { kind: "token"; mode?: string; conditional: boolean }

// Classify the full frame stack (outermost → innermost) that scopes a declaration. Design-token
// scope is a document-root selector (`:root`/`:host`/`html`/`body`/`*`/`:global`) or a Tailwind
// `@theme`/`@property` block; a theme-variant selector (`.dark`, `:root.theme-dim`, `[data-theme]`)
// or a `@media (prefers-color-scheme: …)` makes it a mode of that token. Everything else — a
// component selector, or any nesting under one — is component-internal.
function classifySelectorScope(selectors: string[]): SelectorScope {
  const atRules: string[] = []
  const selectorFrames: string[] = []
  for (const frame of selectors) {
    const f = frame.trim()
    if (f.startsWith("@")) atRules.push(f)
    else if (f) selectorFrames.push(f)
  }

  // Nesting under an ancestor selector (native CSS nesting) scopes the var to that subtree —
  // component-internal, the same as a descendant combinator (`.dark .card`).
  if (selectorFrames.length > 1) return { kind: "component" }

  const self = classifyInnermostSelector(selectorFrames[0] ?? "")
  const hasGlobalAtRule = atRules.some(isGlobalAtRule)
  const mediaMode = prefersColorSchemeMode(atRules)
  // Any at-rule that isn't @theme/@property or prefers-color-scheme (a responsive @media, @supports,
  // @container, @layer) makes the value a conditional override.
  const conditional = atRules.some((a) => !isGlobalAtRule(a) && prefersColorSchemeMode([a]) === null)

  if (self === "component") return { kind: "component" }
  // An empty innermost (declaration directly under an at-rule) is a token only when that at-rule is
  // a global-token block (`@theme`) or a prefers-color-scheme media; otherwise it isn't token scope.
  if (self === "empty" && !hasGlobalAtRule && mediaMode === null) return { kind: "component" }

  const selfMode = typeof self === "object" ? self.mode : undefined
  return { kind: "token", mode: selfMode ?? mediaMode ?? undefined, conditional }
}

// Classify a single (innermost) selector string: "global" root scope, "component", "empty", or a
// theme scope carrying its mode. A compound is a theme scope only when EVERY comma-part is a theme
// qualifier — optionally anchored to `:root`/`html`/`body`, no descendant combinator.
function classifyInnermostSelector(selector: string): "global" | "component" | "empty" | { mode: string } {
  const parts = selector
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return "empty"

  const modes = parts.map(themeModeOfPart)
  if (modes.every((m) => m !== null)) return { mode: modes[0] as string }
  if (parts.some(isGlobalSelectorPart)) return "global"
  return "component"
}

// A document-root / element-wide scope — the pre-existing global-token test, unchanged so the
// non-theme classification stays identical to before.
function isGlobalSelectorPart(part: string): boolean {
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
}

const THEME_ATTRS = new Set(["data-theme", "data-mode", "data-color-scheme", "data-color-mode"])

// The theme mode a single compound selector encodes, or null if it isn't a theme scope. A theme
// compound is one or more theme qualifiers (a `dark`/`light`/`theme-*` class or a theme data
// attribute), optionally anchored to `:root`/`html`/`body`, with no combinator. Mode key: class
// name sans `theme-` (`.theme-dim` → `dim`), attribute value (`[data-theme="dim"]` → `dim`), or a
// bare attribute's name sans `data-` (`[data-theme]` → `theme`).
function themeModeOfPart(part: string): string | null {
  const p = part.trim()
  if (p === "" || hasCombinator(p)) return null

  const tokens = p.match(/\[[^\]]*\]|::?[a-zA-Z][\w-]*|\.[\w-]+|[a-zA-Z][\w-]*|\*/g)
  if (!tokens) return null

  let mode: string | null = null
  for (const tok of tokens) {
    if (tok === ":root" || /^(html|body)$/i.test(tok)) continue // anchor, no mode of its own
    let m: string | null
    if (tok.startsWith("[")) m = themeAttrMode(tok)
    else if (tok.startsWith(".")) m = themeClassMode(tok.slice(1))
    else return null // element, universal, or other pseudo — not a theme qualifier
    if (m === null) return null
    if (mode !== null && mode !== m) return null // a compound spanning two modes isn't one scope
    mode = m
  }
  return mode
}

function themeClassMode(cls: string): string | null {
  const c = cls.toLowerCase()
  if (c === "dark" || c === "light") return c
  if (c.startsWith("theme-")) return c.slice("theme-".length) || null
  return null
}

function themeAttrMode(tok: string): string | null {
  const inner = tok.slice(1, -1).trim()
  const m = inner.match(/^([a-zA-Z][\w-]*)\s*(?:[~|^$*]?=\s*(.*))?$/)
  if (!m) return null
  const name = m[1].toLowerCase()
  if (!THEME_ATTRS.has(name)) return null
  const rawVal = m[2]
  if (rawVal === undefined) return name.replace(/^data-/, "") // bare attribute → name sans data-
  const val = rawVal
    .trim()
    .replace(/\s+i$/i, "") // drop a case-insensitivity flag
    .trim()
    .replace(/^["']|["']$/g, "")
  return val || name.replace(/^data-/, "")
}

// True when the selector has a top-level combinator (descendant/child/sibling) outside `[]`/`()`,
// so `.dark .card` and `.dark > .card` are NOT single theme scopes but `html.dark` is.
function hasCombinator(selector: string): boolean {
  let depth = 0
  for (const c of selector) {
    if (c === "[" || c === "(") depth++
    else if (c === "]" || c === ")") depth = Math.max(0, depth - 1)
    else if (depth === 0 && (c === ">" || c === "+" || c === "~" || /\s/.test(c))) return true
  }
  return false
}

function isGlobalAtRule(atRule: string): boolean {
  const s = atRule.trim().toLowerCase()
  return s.startsWith("@theme") || s.startsWith("@property")
}

// The mode a `@media (prefers-color-scheme: dark|light)` frame encodes, or null. Theme via media
// query is the same token in another mode — not a responsive override.
function prefersColorSchemeMode(atRules: string[]): string | null {
  for (const a of atRules) {
    const m = a.toLowerCase().match(/prefers-color-scheme\s*:\s*(dark|light)/)
    if (m) return m[1]
  }
  return null
}

// Component-prefix conventions: vars a design system namespaces per-component rather than as
// global tokens. Polaris uses `--pc-` (Polaris Component). Extend as new conventions surface.
function isComponentInternalVar(name: string): boolean {
  return name.startsWith("pc-")
}
