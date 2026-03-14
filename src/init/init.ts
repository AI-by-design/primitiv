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
    console.log("\nNext steps:")
    console.log("  1. Review and adjust primitiv.config.js if needed")
    console.log("  2. Run `primitiv build` to generate your contract")
    console.log("  3. Add Primitiv to your MCP config:\n")
    console.log(`     {
       "primitiv": {
         "command": "node",
         "args": ["${path.resolve(__dirname, "../../cli.js")}", "serve", "${configPath}"]
       }
     }`)
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

function readJSON(filePath: string): Record<string, unknown> | null {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"))
    } catch {
        return null
    }
}