import { glob } from "glob"
import * as fs from "fs"
import * as path from "path"
import { CodebaseSource, TokenMap, ComponentMap } from "../types"

export class CodebaseScanner {
  constructor(private config: CodebaseSource) { }

  async scan(): Promise<{ tokens: TokenMap; components: ComponentMap }> {
    const files = await this.getFiles()
    const tokens = await this.extractTokens(files)
    const components = await this.extractComponents(files)
    return { tokens, components }
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
    let match

    while ((match = cssVarRegex.exec(content)) !== null) {
      const [, name, value] = match
      const trimmed = value.trim()

      // Skip aliases — tokens whose value is just a var() reference to another token.
      if (/^var\(--[\w-]+\)$/.test(trimmed)) continue

      const line = lineFromIndex(content, match.index)
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
    let match

    while ((match = colorRegex.exec(content)) !== null) {
      const [, name, value] = match
      if (!tokens.colors[name]) {
        const line = lineFromIndex(content, match.index)
        tokens.colors[name] = {
          name,
          value: value.trim(),
          source: { adapter: "codebase", file, line }
        }
      }
    }
  }

  private categorizeToken(name: string, value: string): string {
    const isColorValue = (
      value.startsWith("#") ||
      value.startsWith("rgb") ||
      value.startsWith("hsl") ||
      value.startsWith("oklch") ||
      value.startsWith("oklab")
    )
    const isColorName = (
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
    if (isColorValue || isColorName) return "colors"
    if (name.includes("spacing") || name.includes("margin") || name.includes("padding") || name.includes("gap")) return "spacing"
    if (name.includes("font") || name.includes("line-height") || name.includes("letter") || name.includes("text-")) return "typography"
    if (name.includes("radius") || name.includes("rounded")) return "borderRadius"
    if (name.includes("shadow")) return "shadows"
    return "other"
  }

  private async extractComponents(files: string[]): Promise<ComponentMap> {
    const components: ComponentMap = {}
    const componentFiles = files.filter(f => f.endsWith(".tsx") || f.endsWith(".jsx"))

    for (const file of componentFiles) {
      const content = fs.readFileSync(path.resolve(this.config.root, file), "utf-8")
      const result = this.extractComponentName(content, file)

      if (result) {
        components[result.name] = {
          name: result.name,
          source: { adapter: "codebase", file, line: result.line },
          props: this.extractProps(content)
        }
      }
    }

    return components
  }

  private extractComponentName(content: string, file: string): { name: string; line: number } | null {
    const exportMatch = content.match(/export\s+(?:default\s+)?(?:function|const)\s+([A-Z][a-zA-Z]+)/)
    if (exportMatch) {
      return { name: exportMatch[1], line: lineFromIndex(content, exportMatch.index!) }
    }

    const basename = path.basename(file, path.extname(file))
    if (basename[0] === basename[0].toUpperCase()) {
      return { name: basename, line: 1 }
    }

    return null
  }

  private extractProps(content: string): Record<string, { type: string; required: boolean }> {
    const props: Record<string, { type: string; required: boolean }> = {}

    const propsMatch = content.match(/(?:interface|type)\s+\w*[Pp]rops\s*(?:=\s*)?{([^}]+)}/s)
    if (!propsMatch) return props

    const propsContent = propsMatch[1]
    const propRegex = /(\w+)(\?)?\s*:\s*([^;\n]+)/g
    let match

    while ((match = propRegex.exec(propsContent)) !== null) {
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
