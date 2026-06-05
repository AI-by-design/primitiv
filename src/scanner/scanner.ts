import * as fs from "node:fs"
import * as path from "node:path"
import { parse } from "@babel/parser"
import type * as t from "@babel/types"
import { glob } from "glob"
import type { CodebaseSource, Collision, ComponentKind, ComponentMap, TokenMap } from "../types"

export class CodebaseScanner {
  constructor(private config: CodebaseSource) {}

  async scan(): Promise<{ tokens: TokenMap; components: ComponentMap; collisions: Collision[] }> {
    const files = await this.getFiles()
    const tokens = await this.extractTokens(files)
    const { components, collisions } = await this.extractComponents(files)
    return { tokens, components, collisions }
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

  private async extractTokens(files: string[]): Promise<TokenMap> {
    const tokens: TokenMap = {
      colors: {},
      spacing: {},
      typography: {},
      borderRadius: {},
      shadows: {}
    }

    for (const file of files) {
      const content = fs.readFileSync(path.resolve(this.config.root, file), "utf-8")
      const ext = path.extname(file)

      if (ext === ".css") {
        this.extractCSSTokens(content, file, tokens)
      } else if (ext === ".ts" || ext === ".tsx") {
        this.extractTSTokens(content, file, tokens)
      }
    }

    return tokens
  }

  private extractCSSTokens(content: string, file: string, tokens: TokenMap): void {
    const cssVarRegex = /--([\w-]+):\s*([^;]+);/g

    for (const match of content.matchAll(cssVarRegex)) {
      const [, name, value] = match
      const trimmed = value.trim()

      // Skip aliases — tokens whose value is just a var() reference to another token.
      if (/^var\(--[\w-]+\)$/.test(trimmed)) continue

      const line = lineFromIndex(content, match.index ?? 0)
      const category = this.categorizeToken(name, trimmed)
      if (!tokens[category]) tokens[category] = {}
      tokens[category][name] = {
        name,
        value: trimmed,
        source: { adapter: "codebase", file, line }
      }
    }
  }

  private extractTSTokens(content: string, file: string, tokens: TokenMap): void {
    const colorRegex = /(\w+):\s*['"]?(#[0-9a-fA-F]{3,8}|rgb[a]?\([^)]+\)|hsl[a]?\([^)]+\)|oklch\([^)]+\))['"]?/g

    for (const match of content.matchAll(colorRegex)) {
      const [, name, value] = match
      if (!tokens.colors[name]) {
        const line = lineFromIndex(content, match.index ?? 0)
        tokens.colors[name] = {
          name,
          value: value.trim(),
          source: { adapter: "codebase", file, line }
        }
      }
    }
  }

  private categorizeToken(name: string, value: string): string {
    const isColorValue =
      value.startsWith("#") ||
      value.startsWith("rgb") ||
      value.startsWith("hsl") ||
      value.startsWith("oklch") ||
      value.startsWith("oklab")
    const isColorName =
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
    if (isColorValue || isColorName) return "colors"
    // Typography first so `letter-spacing`/`leading`/`tracking` don't get pulled into spacing.
    if (
      name.includes("font") ||
      name.includes("line-height") ||
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

function lineFromIndex(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) {
    if (content[i] === "\n") line++
  }
  return line
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
  let program: t.Program
  try {
    program = parse(content, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true }).program
  } catch {
    return []
  }

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
