import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

interface DetectedProject {
  framework: "next" | "vite" | "react" | "unknown"
  hasTypeScript: boolean
  hasTailwind: boolean
  hasFigma: boolean
  hasStorybook: boolean
  srcRoot: string
  patterns: string[]
  ignore: string[]
}

export interface Runner {
  // Executable that npm-style runners use to fetch-and-run a package (npx, bunx, pnpm, yarn).
  command: string
  // Any prefix tokens the runner requires before the package name (e.g. "dlx" for pnpm/yarn).
  argsPrefix: string[]
  // Human-readable label for the detected package manager (e.g. "npm", "pnpm", "yarn", "bun").
  label: string
}

// Detect the project's package manager from its lockfile so the generated MCP
// config uses a runner the user actually has installed. Defaults to npx — it's
// the most universal and every node toolchain ships it.
export function detectRunner(root: string): Runner {
  if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) {
    return { command: "bunx", argsPrefix: [], label: "bun" }
  }
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) {
    return { command: "pnpm", argsPrefix: ["dlx"], label: "pnpm" }
  }
  if (fs.existsSync(path.join(root, "yarn.lock"))) {
    return { command: "yarn", argsPrefix: ["dlx"], label: "yarn" }
  }
  // Fall through for package-lock.json, npm-shrinkwrap.json, or nothing at all.
  return { command: "npx", argsPrefix: [], label: "npm" }
}

function formatRunnerCommand(runner: Runner, ...args: string[]): string {
  return [runner.command, ...runner.argsPrefix, ...args].join(" ")
}

export async function init(targetDir?: string): Promise<void> {
  const root = targetDir || process.cwd()
  const configPath = path.join(root, "primitiv.config.js")

  if (fs.existsSync(configPath)) {
    console.log("⚠️  primitiv.config.js already exists. Remove it first to reinitialise.")
    process.exit(1)
  }

  console.log("🔍 Detecting project...")
  const project = detectProject(root)
  const runner = detectRunner(root)

  console.log(`   Framework:  ${project.framework}`)
  console.log(`   TypeScript: ${project.hasTypeScript ? "yes" : "no"}`)
  console.log(`   Tailwind:   ${project.hasTailwind ? "yes" : "no"}`)
  console.log(`   Figma:      ${project.hasFigma ? "token file found" : "not detected"}`)
  console.log(`   Storybook:  ${project.hasStorybook ? "yes" : "no"}`)
  console.log(`   Package mgr:${runner.label === "npm" ? " npm (default)" : ` ${runner.label}`}`)
  console.log(`   Source:     ${project.srcRoot}`)

  const config = generateConfig(project, root)
  fs.writeFileSync(configPath, config, "utf-8")

  console.log("\n✅ Created primitiv.config.js")
  writeAgentInstructions(root, runner)
  writeMcpConfig(root, runner)
  writeCodexConfig(root, runner)
  writeSkillFile(root)
  console.log("\nNext steps:")
  console.log("  1. Review and adjust primitiv.config.js if needed")
  console.log("  2. Run `primitiv build` to generate your contract")
  console.log("  3. Start the MCP server: `primitiv serve`")
}

function detectProject(root: string): DetectedProject {
  const pkg = readJSON(path.join(root, "package.json"))
  const dependencies: Record<string, string> = (pkg?.dependencies as Record<string, string>) || {}
  const devDependencies: Record<string, string> = (pkg?.devDependencies as Record<string, string>) || {}
  const deps = { ...dependencies, ...devDependencies }

  // Framework
  let framework: DetectedProject["framework"] = "unknown"
  if (deps.next) framework = "next"
  else if (deps.vite) framework = "vite"
  else if (deps.react) framework = "react"

  // TypeScript
  const hasTypeScript = fs.existsSync(path.join(root, "tsconfig.json")) || !!deps.typescript

  // Tailwind
  const hasTailwind =
    !!deps.tailwindcss ||
    fs.existsSync(path.join(root, "tailwind.config.js")) ||
    fs.existsSync(path.join(root, "tailwind.config.ts"))

  // Figma tokens
  const hasFigma =
    fs.existsSync(path.join(root, "tokens.json")) ||
    fs.existsSync(path.join(root, "design-tokens.json")) ||
    fs.existsSync(path.join(root, "src/tokens.json")) ||
    fs.existsSync(path.join(root, "src/design-tokens.json"))

  // Storybook
  const hasStorybook = !!deps.storybook || fs.existsSync(path.join(root, ".storybook"))

  // Source root
  const srcRoot = fs.existsSync(path.join(root, "src")) ? "./src" : "."

  // Patterns
  const extensions = hasTypeScript ? ["ts", "tsx"] : ["js", "jsx"]
  const patterns = ["**/*.css", ...extensions.map((ext) => `**/*.${ext}`)]

  // Ignore
  const ignore = [
    "node_modules",
    "dist",
    ".next",
    "out",
    "build",
    "coverage",
    "**/*.test.*",
    "**/*.spec.*",
    "**/*.stories.*"
  ]

  return { framework, hasTypeScript, hasTailwind, hasFigma, hasStorybook, srcRoot, patterns, ignore }
}

function generateConfig(project: DetectedProject, _root: string): string {
  const figmaSection = project.hasFigma
    ? `\n    // Figma detected — add your access token and file ID to enable token sync
    // figma: {
    //   token: process.env.FIGMA_ACCESS_TOKEN,
    //   fileId: "your-figma-file-id"
    // },`
    : `\n    // Uncomment to add Figma as a source:
    // figma: {
    //   token: process.env.FIGMA_ACCESS_TOKEN,
    //   fileId: "your-figma-file-id"
    // },`

  const storybookSection = project.hasStorybook
    ? `\n    // Storybook detected — uncomment to add as a source:
    // storybook: {
    //   url: "http://localhost:6006",
    //   sourceRoot: "." // enables prop extraction from story files
    // },`
    : `\n    // Uncomment to add Storybook as a source:
    // storybook: {
    //   url: "http://localhost:6006",
    //   sourceRoot: "." // enables prop extraction from story files
    // },`

  const frameworkNote =
    project.framework !== "unknown"
      ? `// Detected: ${project.framework}${project.hasTailwind ? " + Tailwind" : ""}${project.hasTypeScript ? " + TypeScript" : ""}\n`
      : ""

  return `${frameworkNote}/** @type {import('./src/types').PrimitivConfig} */
module.exports = {
  sources: {
    codebase: {
      root: "${project.srcRoot}",
      patterns: ${JSON.stringify(project.patterns, null, 6).replace(/\n/g, "\n      ")},
      ignore: ${JSON.stringify(project.ignore, null, 6).replace(/\n/g, "\n      ")}
    },${figmaSection}${storybookSection}
  },

  governance: {
    // Which source wins when values conflict: "codebase" | "figma" | "storybook" | "manual"
    sourceOfTruth: "${project.hasFigma ? "figma" : "codebase"}",
    // What to do when a conflict is found: "error" | "warn" | "auto-resolve"
    onConflict: "warn"
  },

  output: {
    path: "./primitiv.contract.json"
  }
}
`
}

function writeMcpConfig(root: string, runner: Runner = detectRunner(root)): void {
  const candidates = [".mcp.json", ".cursor/mcp.json"]
  let targetFile: string | null = null

  for (const candidate of candidates) {
    const p = path.join(root, candidate)
    if (fs.existsSync(p)) {
      targetFile = p
      break
    }
  }

  if (!targetFile) {
    targetFile = path.join(root, ".mcp.json")
  }

  const existing = fs.existsSync(targetFile) ? JSON.parse(fs.readFileSync(targetFile, "utf-8")) : {}

  const servers = existing.mcpServers || {}
  if (servers.primitiv) return

  servers.primitiv = {
    command: runner.command,
    args: [...runner.argsPrefix, "@ai-by-design/primitiv", "serve", "./primitiv.config.js"]
  }

  fs.mkdirSync(path.dirname(targetFile), { recursive: true })
  fs.writeFileSync(targetFile, `${JSON.stringify({ ...existing, mcpServers: servers }, null, 2)}\n`, "utf-8")
  console.log(`✅ Updated ${path.relative(root, targetFile)} with Primitiv MCP server (${runner.label})`)
}

const AGENT_BLOCK_MARKER = "<!-- primitiv -->"
const AGENT_BLOCK_END_MARKER = "<!-- /primitiv -->"

function buildAgentBlock(runner: Runner): string {
  const rebuildExample = formatRunnerCommand(runner, "@ai-by-design/primitiv", "build", "/path/to/primitiv.config.js")
  return `
${AGENT_BLOCK_MARKER}
## Primitiv — Design System

When the user asks about design tokens, components, patterns, or anything about the look and feel of this product (e.g. "is there a X component?", "what token should I use for Y?", "how should Z look?"), treat it as a query for the Primitiv MCP. Use the tools below to answer — always in the context of this design system.

Before building or modifying any UI, call \`get_design_context\` and validate the response before proceeding.

### Step 1 — Load the contract
Call \`get_design_context\` (no args) to get the summary.

### Step 2 — Validate before using
Check the response for two things:

**a) sourceRoot must match this project.**
The response includes a \`sourceRoot\` field — the absolute path of the project this contract was built from.
If \`sourceRoot\` does not match the current project's directory, stop immediately.
Do not use the contract data. Tell the user: "Primitiv is pointed at a different project (\`sourceRoot\`). Run \`primitiv init\` and \`primitiv build\` in this project first, or update your MCP config to point at this project's \`primitiv.config.js\`."

**b) warnings must be empty.**
If the response includes a \`warnings\` array, stop and surface each warning to the user before continuing.
Each warning includes the exact command needed to fix it (e.g. \`${rebuildExample}\`).

### Step 3 — Use the contract
Once validated, use the contract for all UI work:

- \`get_design_context { category: "tokens" }\` — full token list
- \`get_design_context { category: "components" }\` — full component list
- \`get_token { name: "...", category: "..." }\` — look up a specific token
- \`get_component { name: "..." }\` — look up a specific component
- \`get_conflicts\` — see unresolved design conflicts
- \`get_inferred_rules\` — see design rules inferred from the codebase

### Rationale (when present)
Tokens and components may include a \`rationale\` object with \`why\`, \`when\`, \`deprecated\`, \`alternatives\`, \`examples\`, or \`tags\`. When rationale is present:

- Prefer tokens/components whose rationale matches the user's intent over ones with no rationale
- If \`deprecated: true\`, do not use it — suggest the \`alternatives\` instead
- Surface \`why\` and \`when\` to the user so they understand intent, not just the value
${AGENT_BLOCK_END_MARKER}
`
}

export function writeAgentInstructions(root: string, runner: Runner = detectRunner(root)): void {
  const candidates = ["AGENTS.md", "CLAUDE.md"]
  let targetFile: string | null = null

  for (const candidate of candidates) {
    const p = path.join(root, candidate)
    if (fs.existsSync(p)) {
      targetFile = p
      break
    }
  }

  if (!targetFile) {
    targetFile = path.join(root, "AGENTS.md")
  }

  const existing = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf-8") : ""
  const hadBlock = existing.includes(AGENT_BLOCK_MARKER)
  const block = buildAgentBlock(runner)

  let next: string
  if (hadBlock) {
    // Replace the existing Primitiv block between markers — keeps user's other content intact.
    const blockRegex = new RegExp(
      `\\n?${escapeRegex(AGENT_BLOCK_MARKER)}[\\s\\S]*?${escapeRegex(AGENT_BLOCK_END_MARKER)}\\n?`
    )
    next = existing.replace(blockRegex, block)
  } else {
    next = existing + block
  }

  fs.writeFileSync(targetFile, next, "utf-8")
  const filename = path.basename(targetFile)
  const action = hadBlock ? "Refreshed" : "Added"
  console.log(`✅ ${action} Primitiv block in ${filename}`)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function writeCodexConfig(root: string, runner: Runner = detectRunner(root)): void {
  // Prefer $HOME so tests can redirect the lookup to a temp dir; fall back to os.homedir() for portability.
  const home = process.env.HOME || os.homedir()
  const codexDir = path.join(home, ".codex")
  if (!fs.existsSync(codexDir)) return

  let hasCodexCli = false
  try {
    execSync("command -v codex", { stdio: "ignore" })
    hasCodexCli = true
  } catch {
    hasCodexCli = false
  }

  if (!hasCodexCli) {
    console.log("ℹ️  ~/.codex found but `codex` CLI not on PATH — skipping Codex MCP setup.")
    return
  }

  const configPath = path.join(root, "primitiv.config.js")
  const runnerCmd = formatRunnerCommand(runner, "@ai-by-design/primitiv", "serve", configPath)
  try {
    execSync(`codex mcp add primitiv -- ${runnerCmd}`, { stdio: "ignore" })
    console.log("✅ Added Primitiv to Codex (~/.codex/config.toml)")
  } catch {
    console.log("⚠️  `codex mcp add` failed. Add [mcp_servers.primitiv] to ~/.codex/config.toml manually.")
  }
}

const SKILL_CONTENT = `# Build Component

Mode: BUILD. One component at a time. Contract before code.

1. Check for Primitiv (\`.mcp.json\` or \`primitiv.contract.json\`) — if missing, fall back to CLAUDE.md only
2. Call \`get_design_context { category: "all" }\` — load full contract
3. Call \`get_conflicts\` — if \`actionableCount > 0\`, surface each \`suggestedFix\` and ask the user to resolve before continuing; if \`pendingDecisionCount > 0\`, warn the user that manual governance config is needed; if no conflicts, continue
4. Confirm component spec with user: name, props, states, variants, composition, Server vs Client
5. Build — use contract tokens only, no hardcoded values; all interactive states required; reuse existing components before creating new ones
6. Self-check against contract: verify token usage, component naming, prop shapes
7. Run \`primitiv build\` — update the contract with the new component
`

function writeSkillFile(root: string): void {
  const target = path.join(root, ".claude/commands/build-component.md")
  if (fs.existsSync(target)) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, SKILL_CONTENT, "utf-8")
  console.log("✅ Installed build-component skill → .claude/commands/build-component.md")
}

function readJSON(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"))
  } catch {
    return null
  }
}
