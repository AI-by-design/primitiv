import * as fs from "fs"
import * as path from "path"

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

export async function init(targetDir?: string): Promise<void> {
    const root = targetDir || process.cwd()
    const configPath = path.join(root, "primitiv.config.js")

    if (fs.existsSync(configPath)) {
        console.log("⚠️  primitiv.config.js already exists. Remove it first to reinitialise.")
        process.exit(1)
    }

    console.log("🔍 Detecting project...")
    const project = detectProject(root)

    console.log(`   Framework:  ${project.framework}`)
    console.log(`   TypeScript: ${project.hasTypeScript ? "yes" : "no"}`)
    console.log(`   Tailwind:   ${project.hasTailwind ? "yes" : "no"}`)
    console.log(`   Figma:      ${project.hasFigma ? "token file found" : "not detected"}`)
    console.log(`   Storybook:  ${project.hasStorybook ? "yes" : "no"}`)
    console.log(`   Source:     ${project.srcRoot}`)

    const config = generateConfig(project, root)
    fs.writeFileSync(configPath, config, "utf-8")

    console.log("\n✅ Created primitiv.config.js")
    writeAgentInstructions(root)
    writeMcpConfig(root)
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
    const hasTailwind = !!deps.tailwindcss ||
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
    const patterns = ["**/*.css", ...extensions.map(ext => `**/*.${ext}`)]

    // Ignore
    const ignore = ["node_modules", "dist", ".next", "out", "build", "coverage", "**/*.test.*", "**/*.spec.*", "**/*.stories.*"]

    return { framework, hasTypeScript, hasTailwind, hasFigma, hasStorybook, srcRoot, patterns, ignore }
}

function generateConfig(project: DetectedProject, root: string): string {
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
    //   url: "http://localhost:6006"
    // },`
        : `\n    // Uncomment to add Storybook as a source:
    // storybook: {
    //   url: "http://localhost:6006"
    // },`

    const frameworkNote = project.framework !== "unknown"
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

function writeMcpConfig(root: string): void {
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

    const existing = fs.existsSync(targetFile)
        ? JSON.parse(fs.readFileSync(targetFile, "utf-8"))
        : {}

    const servers = existing.mcpServers || {}
    if (servers.primitiv) return

    servers.primitiv = {
        command: "bunx",
        args: ["@ai-by-design/primitiv", "serve", "./primitiv.config.js"]
    }

    fs.mkdirSync(path.dirname(targetFile), { recursive: true })
    fs.writeFileSync(targetFile, JSON.stringify({ ...existing, mcpServers: servers }, null, 2) + "\n", "utf-8")
    console.log(`✅ Updated ${path.relative(root, targetFile)} with Primitiv MCP server`)
}

const AGENT_BLOCK_MARKER = "<!-- primitiv -->"

const AGENT_BLOCK = `
${AGENT_BLOCK_MARKER}
## Primitiv — Design System

Before building or modifying any UI, call \`get_design_context\` to load the resolved design contract. This gives you the correct tokens, components, and naming conventions for this codebase.

- \`get_design_context\` — summary of available tokens and components
- \`get_design_context { category: "tokens" }\` — full token list
- \`get_design_context { category: "components" }\` — full component list
- \`get_token { name: "...", category: "..." }\` — look up a specific token
- \`get_component { name: "..." }\` — look up a specific component
- \`get_conflicts\` — see unresolved design conflicts
- \`get_inferred_rules\` — see design rules inferred from the codebase
<!-- /primitiv -->
`

function writeAgentInstructions(root: string): void {
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
    if (existing.includes(AGENT_BLOCK_MARKER)) return

    fs.writeFileSync(targetFile, existing + AGENT_BLOCK, "utf-8")
    const filename = path.basename(targetFile)
    console.log(`✅ Updated ${filename} with Primitiv usage instructions`)
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