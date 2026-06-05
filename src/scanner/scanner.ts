import * as fs from "node:fs"
import * as path from "node:path"
import { glob } from "glob"
import type { CodebaseSource, Collision, ComponentMap, TokenMap } from "../types"

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
      const found = this.extractComponentNames(content, file)

      for (const result of found) {
        const existing = components[result.name]
        if (existing) {
          // Same-name collision: keep the first, record the rest so the loss isn't silent.
          // (Coexistence via path-qualified identity is the AST/Option-C work — see COMPONENT_IDENTITY_PLAN.md.)
          if (!collided[result.name]) collided[result.name] = [existing.source.file ?? "?"]
          collided[result.name].push(file)
          continue
        }
        components[result.name] = {
          name: result.name,
          source: { adapter: "codebase", file, line: result.line },
          props: this.extractProps(content)
        }
      }
    }

    const collisions: Collision[] = Object.entries(collided).map(([name, fileList]) => ({ name, files: fileList }))
    return { components, collisions }
  }

  // Enumerate every exported component in a file (not just the first). Falls back to the
  // capitalized filename only when the regex matches nothing (e.g. `export { X }` re-export styles).
  private extractComponentNames(content: string, file: string): Array<{ name: string; line: number }> {
    const results: Array<{ name: string; line: number }> = []
    const re = /export\s+(?:default\s+)?(?:function|const)\s+([A-Z][a-zA-Z]+)/g
    for (const match of content.matchAll(re)) {
      results.push({ name: match[1], line: lineFromIndex(content, match.index ?? 0) })
    }
    if (results.length === 0) {
      const basename = path.basename(file, path.extname(file))
      if (basename[0] === basename[0].toUpperCase()) results.push({ name: basename, line: 1 })
    }
    return results
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
