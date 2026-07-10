import * as fs from "node:fs"
import * as path from "node:path"
import { glob } from "glob"
import type { CodebaseSource, LintCategory, PrimitivConfig, PrimitivContract, Violation } from "../types"

// Tailwind utility prefixes that take a color arbitrary value, e.g. `bg-[#ff0000]`.
const COLOR_PREFIX_RE =
  /\b(?:bg|text|border|fill|stroke|ring|outline|decoration|caret|accent|divide|placeholder|from|via|to|shadow)-\[([^\]]+)\]/g

// Tailwind utility prefixes that take a length / sizing arbitrary value, e.g. `p-[7px]`.
const SPACING_PREFIX_RE =
  /\b(?:px|py|pt|pr|pb|pl|p|mx|my|mt|mr|mb|ml|m|gap-x|gap-y|gap|space-x|space-y|min-w|min-h|max-w|max-h|w|h|top|right|bottom|left|inset-x|inset-y|inset|size|basis|indent)-\[([^\]]+)\]/g

const COLOR_LITERAL_RE = /^(?:#[0-9a-fA-F]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab)\([^)]+\))$/
const SPACING_LITERAL_RE = /^-?\d+(?:\.\d+)?(?:px|rem|em|%|vh|vw|svh|dvh|lvh|ch|fr|pt)$/

const IGNORE_DIRECTIVE = "primitiv-ignore-next-line"

interface TokenIndexEntry {
  name: string
  category: string
  value: string
}

// Scan source files for hardcoded literals that bypass the design contract.
// Today: Tailwind arbitrary values in className strings. Per-file exemption uses
// `source.file` provenance from the contract — files that DEFINE tokens are
// trusted not to be linted (they hold the canonical literals by construction).
export async function lintTokenMisuse(config: PrimitivConfig, contract: PrimitivContract): Promise<Violation[]> {
  const codebase = config.sources.codebase
  if (!codebase) return []

  const exemptFiles = collectTokenSourceFiles(contract)
  const tokenIndex = buildTokenIndex(contract)
  const files = await collectFiles(codebase)
  const violations: Violation[] = []

  for (const relFile of files) {
    if (exemptFiles.has(normalizePath(relFile))) continue
    if (!hostsClassStrings(relFile)) continue
    const absPath = path.resolve(codebase.root, relFile)
    const content = fs.readFileSync(absPath, "utf-8")
    const lines = content.split("\n")

    collectMatches(content, lines, COLOR_PREFIX_RE, "colors", relFile, tokenIndex, violations)
    collectMatches(content, lines, SPACING_PREFIX_RE, "spacing", relFile, tokenIndex, violations)
  }

  return violations
}

async function collectFiles(source: CodebaseSource): Promise<string[]> {
  const files = new Set<string>()
  for (const pattern of source.patterns) {
    const matches = await glob(pattern, {
      cwd: source.root,
      ignore: source.ignore,
      absolute: false
    })
    for (const m of matches) files.add(m)
  }
  return [...files]
}

// Tailwind class strings live in JSX/TSX/HTML; helpers in plain TS/JS occasionally
// build className strings too. CSS rule scanning is out of MVP scope.
function hostsClassStrings(file: string): boolean {
  const ext = path.extname(file).toLowerCase()
  return ext === ".tsx" || ext === ".jsx" || ext === ".ts" || ext === ".js" || ext === ".html"
}

function collectTokenSourceFiles(contract: PrimitivContract): Set<string> {
  const files = new Set<string>()
  for (const category of Object.values(contract.tokens)) {
    for (const token of Object.values(category)) {
      if (token.source.file) files.add(normalizePath(token.source.file))
    }
  }
  return files
}

function buildTokenIndex(contract: PrimitivContract): Map<string, TokenIndexEntry> {
  const index = new Map<string, TokenIndexEntry>()
  for (const [category, tokens] of Object.entries(contract.tokens)) {
    for (const token of Object.values(tokens)) {
      // Index the default first, then each theme-mode value, so a hardcoded dark-mode literal
      // (e.g. `#000` that only appears as this token's `dark` value) still smart-matches its token.
      for (const value of [token.value, ...Object.values(token.modes ?? {})]) {
        const key = normalizeValue(value)
        // First match wins when multiple tokens (or modes) share a value (deferred decision).
        if (!index.has(key)) {
          index.set(key, { name: token.name, category, value })
        }
      }
    }
  }
  return index
}

function collectMatches(
  content: string,
  lines: string[],
  re: RegExp,
  category: LintCategory,
  file: string,
  tokenIndex: Map<string, TokenIndexEntry>,
  out: Violation[]
): void {
  const literalRe = category === "colors" ? COLOR_LITERAL_RE : SPACING_LITERAL_RE
  // The /g flag preserves lastIndex across exec() calls; reset it before each
  // file pass so module-level regexes don't silently skip matches.
  re.lastIndex = 0
  let match = re.exec(content)
  while (match !== null) {
    const inner = match[1].trim()
    if (!isTokenReference(inner) && literalRe.test(inner)) {
      const { line, column } = positionFromIndex(content, match.index)
      if (!hasIgnoreDirectiveAbove(lines, line)) {
        const suggestion = tokenIndex.get(normalizeValue(inner))
        out.push({
          type: "token-misuse",
          category,
          found: inner,
          context: match[0],
          source: { file, line, column },
          suggestion: suggestion
            ? { token: suggestion.name, category: suggestion.category, value: suggestion.value }
            : undefined
        })
      }
    }
    match = re.exec(content)
  }
}

function isTokenReference(v: string): boolean {
  if (v.startsWith("var(")) return true
  if (v.startsWith("--")) return true
  if (v.startsWith("theme(")) return true
  // calc() expressions that reach a token via var() are intentional, not bypasses.
  if (v.startsWith("calc(") && /var\(--/.test(v)) return true
  return false
}

function normalizeValue(v: string): string {
  return v.trim().toLowerCase()
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/")
}

function positionFromIndex(content: string, index: number): { line: number; column: number } {
  let line = 1
  let lastNewline = -1
  for (let i = 0; i < index; i++) {
    if (content[i] === "\n") {
      line++
      lastNewline = i
    }
  }
  return { line, column: index - lastNewline }
}

// `// primitiv-ignore-next-line` on the directly-preceding non-blank line
// suppresses the violation on `line` (1-indexed).
function hasIgnoreDirectiveAbove(lines: string[], line: number): boolean {
  for (let i = line - 2; i >= 0; i--) {
    const text = lines[i]
    if (text.trim() === "") continue
    return text.includes(IGNORE_DIRECTIVE)
  }
  return false
}
