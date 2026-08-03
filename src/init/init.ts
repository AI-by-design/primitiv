import { execFileSync, execSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

interface DetectedProject {
  framework:
    | "next"
    | "nuxt"
    | "astro"
    | "sveltekit"
    | "remix"
    | "expo"
    | "qwik"
    | "vite"
    | "solid"
    | "react"
    | "unknown"
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

function formatRunnerArgv(runner: Runner, ...args: string[]): string[] {
  return [runner.command, ...runner.argsPrefix, ...args]
}

function formatRunnerCommand(runner: Runner, ...args: string[]): string {
  return formatRunnerArgv(runner, ...args).join(" ")
}

export async function init(targetDir?: string): Promise<void> {
  const root = targetDir || process.cwd()
  const configPath = path.join(root, "primitiv.config.js")
  const runner = detectRunner(root)

  if (fs.existsSync(configPath)) {
    console.log("ℹ️  primitiv.config.js already exists — keeping yours, refreshing other wiring.")
  } else {
    console.log("🔍 Detecting project...")
    const project = detectProject(root)

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
  }

  writeAgentInstructions(root, runner)
  writeMcpConfig(root, runner)
  writeCodexConfig(root, runner)
  writeSkillFile(root)
  writeSetupSkill(root)
  writeGitHubWorkflow(root)
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

  // Framework. Order matters — meta-frameworks (Next, Nuxt, SvelteKit, Remix,
  // Astro, Expo, Qwik) are checked before the underlying libs they're built on
  // (React, Vite, Solid). Many of them depend on Vite internally, so a flat
  // "deps.vite first" check would mislabel Astro/SvelteKit/Remix as Vite.
  let framework: DetectedProject["framework"] = "unknown"
  if (deps.next) framework = "next"
  else if (deps.nuxt) framework = "nuxt"
  else if (deps.astro) framework = "astro"
  else if (deps["@sveltejs/kit"]) framework = "sveltekit"
  else if (deps["@remix-run/react"] || deps["@remix-run/node"]) framework = "remix"
  else if (deps.expo) framework = "expo"
  else if (deps["@builder.io/qwik"]) framework = "qwik"
  else if (deps.vite) framework = "vite"
  else if (deps["solid-js"]) framework = "solid"
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

  // Ignore. Directory entries need `**/<dir>/**` — a bare "node_modules" only matches an
  // entry with that exact name, leaving everything beneath it in scope. That put whole
  // dependency trees through the scanner, and any file pattern is then free to match a
  // directory (`node_modules/ipaddr.js` matches `**/*.js`).
  const ignore = [
    "**/node_modules/**",
    "**/dist/**",
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/coverage/**",
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
    //   // optional: false, // uncomment to fail the build when this source can't be scanned
    // },`
    : `\n    // Uncomment to add Figma as a source:
    // figma: {
    //   token: process.env.FIGMA_ACCESS_TOKEN,
    //   fileId: "your-figma-file-id"
    //   // optional: false, // uncomment to fail the build when this source can't be scanned
    // },`

  const storybookSection = project.hasStorybook
    ? `\n    // Storybook detected — uncomment to add as a source:
    // storybook: {
    //   url: "http://localhost:6006",
    //   sourceRoot: "." // enables prop extraction from story files
    //   // optional: false, // uncomment to fail the build when this source can't be scanned
    // },`
    : `\n    // Uncomment to add Storybook as a source:
    // storybook: {
    //   url: "http://localhost:6006",
    //   sourceRoot: "." // enables prop extraction from story files
    //   // optional: false, // uncomment to fail the build when this source can't be scanned
    // },`

  const frameworkNote =
    project.framework !== "unknown"
      ? `// Detected: ${project.framework}${project.hasTailwind ? " + Tailwind" : ""}${project.hasTypeScript ? " + TypeScript" : ""}\n`
      : ""

  // No `@type` JSDoc: the only resolvable path would be into Primitiv's own repo
  // (`./src/types`), which never exists in the project this config is written to,
  // and the published package doesn't re-export the config type. A broken import
  // hint is worse than none — it just lights up the user's editor with an error.
  return `${frameworkNote}module.exports = {
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
    // What to do when a conflict is found:
    //   "warn"         record conflicts as pending; build succeeds (default)
    //   "error"        write the contract, then fail the build (exit 2) while conflicts are pending
    //   "auto-resolve" conflicts the sourceOfTruth decides are marked resolved; standoffs stay pending
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

  let existing: Record<string, unknown> = {}
  if (fs.existsSync(targetFile)) {
    const parsed = readJSON(targetFile)
    if (parsed === null) {
      // Don't clobber a file we can't parse — it likely holds the user's other MCP
      // servers. Warn with the fix and leave it untouched rather than crash init.
      console.log(
        `⚠️  Skipped MCP config: ${path.relative(root, targetFile)} isn't valid JSON. Fix it and re-run \`primitiv init\`.`
      )
      return
    }
    existing = parsed
  }

  const servers = (existing.mcpServers as Record<string, unknown>) ?? {}
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
- \`get_component { name: "...", context: "<your working file or dir>" }\` — look up a specific component; pass your working path so same-name components resolve by scope. An \`ambiguous\` response carries an \`instruction\` — follow it (scope → \`rationale.when\` vs the user's intent → ask the user); never pick one arbitrarily
- \`get_conflicts\` — see unresolved design conflicts
- \`get_inferred_rules\` — see design rules inferred from the codebase
- \`get_violations\` — see hardcoded literals in the codebase that bypass the contract

### Step 4 — Avoid token misuse
Before generating any \`className\` or style with a literal value (e.g. \`bg-[#hex]\`, \`p-[8px]\`), call \`get_violations\` to see active misuses and \`get_design_context\` for available tokens. Prefer existing tokens — \`bg-[var(--color-primary)]\`, \`p-[var(--spacing-2)]\` — over hardcoded literals. If a violation already has a \`suggestion.token\`, use that name.

### Rationale (when present)
Tokens and components may include a \`rationale\` object with \`why\`, \`when\`, \`deprecated\`, \`alternatives\`, \`examples\`, or \`tags\`. When rationale is present:

- Prefer tokens/components whose rationale matches the user's intent over ones with no rationale
- If \`deprecated: true\`, do not use it — suggest the \`alternatives\` instead
- Surface \`why\` and \`when\` to the user so they understand intent, not just the value
${AGENT_BLOCK_END_MARKER}
`
}

export function writeAgentInstructions(root: string, runner: Runner = detectRunner(root)): void {
  // Write to every existing agent-instruction file. Claude Code reads CLAUDE.md;
  // Codex/Cursor/others read AGENTS.md. If both exist we need both, otherwise
  // one tool sees the Primitiv block and the other doesn't. If neither exists,
  // create AGENTS.md as the cross-tool default.
  const candidates = ["AGENTS.md", "CLAUDE.md"]
  const existing = candidates.filter((c) => fs.existsSync(path.join(root, c)))
  const targets = existing.length > 0 ? existing : ["AGENTS.md"]

  const block = buildAgentBlock(runner)
  for (const filename of targets) {
    const p = path.join(root, filename)
    const content = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : ""
    const hadBlock = content.includes(AGENT_BLOCK_MARKER)
    const next = replaceMarkedBlock(content, block, AGENT_BLOCK_MARKER, AGENT_BLOCK_END_MARKER)

    fs.writeFileSync(p, next, "utf-8")
    const action = hadBlock ? "Refreshed" : "Added"
    console.log(`✅ ${action} Primitiv block in ${filename}`)
  }
}

// Refresh a marker-delimited block inside `existing`. If the start marker isn't
// present, the block is appended. Used for AGENTS.md/CLAUDE.md and the
// generated GitHub workflow file — anywhere init re-runs need to be idempotent
// without trampling user content.
function replaceMarkedBlock(existing: string, block: string, startMarker: string, endMarker: string): string {
  if (!existing.includes(startMarker)) {
    return existing + block
  }
  const blockRegex = new RegExp(`\\n?${escapeRegex(startMarker)}[\\s\\S]*?${escapeRegex(endMarker)}\\n?`)
  return existing.replace(blockRegex, block)
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ---------- GitHub Actions workflow installer ----------

interface GitHubContext {
  isGit: boolean
  isGitHub: boolean
  defaultBranch: string
  owner: string | null
  repo: string | null
}

const WORKFLOW_BLOCK_MARKER = "# <!-- primitiv -->"
const WORKFLOW_BLOCK_END_MARKER = "# <!-- /primitiv -->"
const WORKFLOW_RELATIVE_PATH = ".github/workflows/primitiv-verify.yml"

function detectGitHubContext(root: string): GitHubContext {
  const baseResult: GitHubContext = {
    isGit: false,
    isGitHub: false,
    defaultBranch: "main",
    owner: null,
    repo: null
  }

  if (!fs.existsSync(path.join(root, ".git"))) return baseResult

  // Repo is git but may not have a remote yet — fall through to "git but not GitHub".
  const remoteUrl = tryGit("git config --get remote.origin.url", root)
  if (!remoteUrl) return { ...baseResult, isGit: true }

  // Match both https://github.com/owner/repo(.git) and git@github.com:owner/repo(.git).
  const match = remoteUrl.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/)
  if (!match) return { ...baseResult, isGit: true }

  const [, owner, repo] = match

  return {
    isGit: true,
    isGitHub: true,
    defaultBranch: detectDefaultBranch(root),
    owner,
    repo
  }
}

function detectDefaultBranch(root: string): string {
  // Prefer the symbolic-ref of origin/HEAD — set when the repo is cloned from a remote.
  const symbolicRef = tryGit("git symbolic-ref refs/remotes/origin/HEAD", root)
  if (symbolicRef) {
    const stripped = symbolicRef.replace(/^refs\/remotes\/origin\//, "")
    if (stripped) return stripped
  }

  // Falls back for repos initialised locally without a remote HEAD.
  const initDefault = tryGit("git config --get init.defaultBranch", root)
  if (initDefault) return initDefault

  const headRef = tryGit("git rev-parse --abbrev-ref HEAD", root)
  if (headRef && headRef !== "HEAD") return headRef

  return "main"
}

function tryGit(command: string, cwd: string): string | null {
  try {
    return execSync(command, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

function buildGitHubWorkflow(defaultBranch: string): string {
  return `${WORKFLOW_BLOCK_MARKER}
# Generated by \`primitiv init\`. Refreshed on re-runs.
# Edits between the markers will be overwritten on next init.
# To customize permanently: remove the markers, or rename the file.
name: Primitiv Verify

on:
  pull_request:
    branches: [${defaultBranch}]
  push:
    branches: [${defaultBranch}]

jobs:
  verify:
    name: Verify design contract
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Verify Primitiv contract
        run: npx --yes @ai-by-design/primitiv verify --strict
${WORKFLOW_BLOCK_END_MARKER}
`
}

export function writeGitHubWorkflow(root: string): void {
  const ctx = detectGitHubContext(root)

  if (!ctx.isGit) {
    console.log("ℹ️  Not a git repository — skipping CI workflow install. Run `primitiv init` again after `git init`.")
    return
  }

  if (!ctx.isGitHub) {
    console.log(
      "ℹ️  Remote is not on GitHub — skipping CI workflow install. GitLab/Bitbucket support is on the roadmap."
    )
    return
  }

  const target = path.join(root, WORKFLOW_RELATIVE_PATH)
  const block = buildGitHubWorkflow(ctx.defaultBranch)

  let action: "Installed" | "Refreshed"
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, block, "utf-8")
    action = "Installed"
  } else {
    const existing = fs.readFileSync(target, "utf-8")
    if (!existing.includes(WORKFLOW_BLOCK_MARKER)) {
      console.log(`⚠️  ${WORKFLOW_RELATIVE_PATH} already exists and is not Primitiv-managed. Skipping.`)
      return
    }
    const next = replaceMarkedBlock(existing, block, WORKFLOW_BLOCK_MARKER, WORKFLOW_BLOCK_END_MARKER)
    fs.writeFileSync(target, next, "utf-8")
    action = "Refreshed"
  }

  console.log(`✅ ${action} ${WORKFLOW_RELATIVE_PATH} (default branch: ${ctx.defaultBranch})`)
  if (ctx.owner && ctx.repo) {
    console.log(`   → Enable branch protection on \`${ctx.defaultBranch}\` to gate merges on contract verification:`)
    console.log(`     https://github.com/${ctx.owner}/${ctx.repo}/settings/branches`)
  }
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
  const runnerArgv = formatRunnerArgv(runner, "@ai-by-design/primitiv", "serve", configPath)
  try {
    execFileSync("codex", ["mcp", "add", "primitiv", "--", ...runnerArgv], { stdio: "ignore" })
    console.log("✅ Added Primitiv to Codex (~/.codex/config.toml)")
  } catch {
    console.log("⚠️  `codex mcp add` failed. Add [mcp_servers.primitiv] to ~/.codex/config.toml manually.")
  }
}

// The installable skill markdown lives in the repo-root `skills/` folder (shipped via the
// package.json "files" allowlist). init compiles to dist/init/init.js and `skills/` ships at the
// package root, so `../../skills` resolves the same in the source tree and in an installed package.
function readSkillTemplate(name: string): string {
  const file = path.join(__dirname, "..", "..", "skills", name)
  try {
    return fs.readFileSync(file, "utf-8")
  } catch {
    throw new Error(
      `primitiv: skill template not found at ${file} — the package may be built or published incorrectly.`
    )
  }
}

function writeSkillFile(root: string): void {
  const target = path.join(root, ".claude/commands/build-component.md")
  if (fs.existsSync(target)) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, readSkillTemplate("build-component.md"), "utf-8")
  console.log("✅ Installed build-component skill → .claude/commands/build-component.md")
}

const SETUP_SKILL_CONTENT = `---
name: primitiv-setup
description: One-time install for Primitiv in this project. Run when the user asks to install Primitiv or when an MCP tool returns a noContract error.
allowed-tools: Bash(npx @ai-by-design/primitiv init *) Bash(npx @ai-by-design/primitiv build *)
---

# Primitiv Setup

Mode: SETUP. One-time install for Primitiv in this project. Idempotent — safe to re-run.

## What runs

\`primitiv init\` writes or refreshes:
- **Project config + contract** — \`primitiv.config.js\`, \`primitiv.contract.json\`
- **Claude Code wiring** — \`/build-component\` skill at \`.claude/commands/build-component.md\`
- **Agent instructions** — Primitiv block in \`AGENTS.md\` or \`CLAUDE.md\`

Also adds an entry to \`.mcp.json\` or \`.cursor/mcp.json\`. Takes ~30 seconds.

## Steps

1. Confirm with the user what will be created (use the 3 groups above) and ask for consent before proceeding.
2. Run \`npx @ai-by-design/primitiv init\` in the project root.
3. Run \`npx @ai-by-design/primitiv build\`.
4. Confirm setup is complete. Agents can now use Primitiv tools (\`get_design_context\`, \`get_token\`, \`get_component\`, \`get_conflicts\`, \`get_inferred_rules\`, \`get_violations\`).

## Uninstall

Delete \`primitiv.config.js\`, \`primitiv.contract.json\`, \`.claude/commands/build-component.md\`, \`.claude/commands/primitiv-setup.md\`, and remove the \`<!-- primitiv -->\` block from \`AGENTS.md\`/\`CLAUDE.md\`. Remove the \`primitiv\` entry from your MCP config.
`

function writeSetupSkill(root: string): void {
  const target = path.join(root, ".claude/commands/primitiv-setup.md")
  if (fs.existsSync(target)) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, SETUP_SKILL_CONTENT, "utf-8")
  console.log("✅ Installed primitiv-setup skill → .claude/commands/primitiv-setup.md")
}

function readJSON(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"))
  } catch {
    return null
  }
}
