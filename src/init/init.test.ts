import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { init, writeAgentInstructions, writeGitHubWorkflow } from "./init"

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-init-test-"))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("init", () => {
  test("creates primitiv.config.js", async () => {
    await init(tempDir)
    expect(fs.existsSync(path.join(tempDir, "primitiv.config.js"))).toBe(true)
  })

  test("never writes to a user-level Codex configuration", async () => {
    const originalHome = process.env.HOME
    const home = path.join(tempDir, "home")
    const codexConfig = path.join(home, ".codex", "config.toml")
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true })
    fs.writeFileSync(codexConfig, "[mcp_servers.existing]\ncommand = 'keep'\n")
    process.env.HOME = home

    try {
      await init(tempDir)
      expect(fs.readFileSync(codexConfig, "utf-8")).toBe("[mcp_servers.existing]\ncommand = 'keep'\n")
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
    }
  })

  test("AGENT_BLOCK contains the Aura-style routing rule", async () => {
    await init(tempDir)
    const agents = fs.readFileSync(path.join(tempDir, "AGENTS.md"), "utf-8")
    expect(agents).toContain("When the user asks about design tokens")
    expect(agents).toContain("<!-- primitiv -->")
    expect(agents).toContain("<!-- /primitiv -->")
  })

  test("MCP config is created with primitiv entry (default runner is npx)", async () => {
    await init(tempDir)
    const mcpPath = path.join(tempDir, ".mcp.json")
    expect(fs.existsSync(mcpPath)).toBe(true)
    const config = JSON.parse(fs.readFileSync(mcpPath, "utf-8"))
    // No lockfile in the temp dir → detectRunner defaults to npx.
    expect(config.mcpServers?.primitiv?.command).toBe("npx")
    expect(config.mcpServers?.primitiv?.args[0]).toBe("@ai-by-design/primitiv")
  })

  test("MCP config uses bunx when bun.lock exists", async () => {
    fs.writeFileSync(path.join(tempDir, "bun.lock"), "")
    await init(tempDir)
    const config = JSON.parse(fs.readFileSync(path.join(tempDir, ".mcp.json"), "utf-8"))
    expect(config.mcpServers?.primitiv?.command).toBe("bunx")
    expect(config.mcpServers?.primitiv?.args).toEqual(["@ai-by-design/primitiv", "serve", "./primitiv.config.js"])
  })

  test("MCP config uses pnpm dlx when pnpm-lock.yaml exists", async () => {
    fs.writeFileSync(path.join(tempDir, "pnpm-lock.yaml"), "")
    await init(tempDir)
    const config = JSON.parse(fs.readFileSync(path.join(tempDir, ".mcp.json"), "utf-8"))
    expect(config.mcpServers?.primitiv?.command).toBe("pnpm")
    expect(config.mcpServers?.primitiv?.args[0]).toBe("dlx")
    expect(config.mcpServers?.primitiv?.args[1]).toBe("@ai-by-design/primitiv")
  })

  test("MCP config uses yarn dlx when yarn.lock exists", async () => {
    fs.writeFileSync(path.join(tempDir, "yarn.lock"), "")
    await init(tempDir)
    const config = JSON.parse(fs.readFileSync(path.join(tempDir, ".mcp.json"), "utf-8"))
    expect(config.mcpServers?.primitiv?.command).toBe("yarn")
    expect(config.mcpServers?.primitiv?.args[0]).toBe("dlx")
  })

  test("MCP config preserves existing servers", async () => {
    fs.writeFileSync(
      path.join(tempDir, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "foo" } } }, null, 2)
    )
    await init(tempDir)
    const config = JSON.parse(fs.readFileSync(path.join(tempDir, ".mcp.json"), "utf-8"))
    expect(config.mcpServers.other.command).toBe("foo")
    expect(config.mcpServers.primitiv).toBeDefined()
  })

  test("skill file is installed", async () => {
    await init(tempDir)
    const skillPath = path.join(tempDir, ".claude/commands/build-component.md")
    expect(fs.existsSync(skillPath)).toBe(true)
  })

  test("primitiv-setup skill file is installed", async () => {
    await init(tempDir)
    const setupSkillPath = path.join(tempDir, ".claude/commands/primitiv-setup.md")
    expect(fs.existsSync(setupSkillPath)).toBe(true)
  })

  test("skill files contain valid frontmatter with required fields", async () => {
    await init(tempDir)

    const buildComponent = fs.readFileSync(path.join(tempDir, ".claude/commands/build-component.md"), "utf-8")
    expect(buildComponent.startsWith("---\n")).toBe(true)
    expect(buildComponent).toContain("name: build-component")
    expect(buildComponent).toContain("description:")

    const setup = fs.readFileSync(path.join(tempDir, ".claude/commands/primitiv-setup.md"), "utf-8")
    expect(setup.startsWith("---\n")).toBe(true)
    expect(setup).toContain("name: primitiv-setup")
    expect(setup).toContain("description:")
    expect(setup).toContain(
      "allowed-tools: Bash(npx @ai-by-design/primitiv init *) Bash(npx @ai-by-design/primitiv build *)"
    )
  })

  test("init is idempotent — second run keeps user config and refreshes wiring", async () => {
    await init(tempDir)

    // Simulate user customization of the config so we can verify it survives a re-run.
    const customizedConfig = "// my custom edit\nmodule.exports = { custom: true }\n"
    fs.writeFileSync(path.join(tempDir, "primitiv.config.js"), customizedConfig)

    // Delete a wiring file to verify the second run refreshes it instead of erroring.
    fs.rmSync(path.join(tempDir, ".claude/commands/build-component.md"), { force: true })

    // Re-run init — must not exit, must not throw.
    await init(tempDir)

    // User config is preserved verbatim.
    const finalConfig = fs.readFileSync(path.join(tempDir, "primitiv.config.js"), "utf-8")
    expect(finalConfig).toContain("my custom edit")

    // Deleted wiring is restored; other wiring still in place.
    expect(fs.existsSync(path.join(tempDir, ".claude/commands/build-component.md"))).toBe(true)
    expect(fs.existsSync(path.join(tempDir, ".mcp.json"))).toBe(true)
    expect(fs.existsSync(path.join(tempDir, "AGENTS.md"))).toBe(true)
  })
})

describe("writeAgentInstructions idempotency", () => {
  test("second call replaces the Primitiv block without duplicating", async () => {
    await init(tempDir)
    const firstContents = fs.readFileSync(path.join(tempDir, "AGENTS.md"), "utf-8")

    // Simulate user-added content around the Primitiv block.
    const withUserContent = `# My project notes\n\nKeep me.\n${firstContents}\n\n## More user notes\n`
    fs.writeFileSync(path.join(tempDir, "AGENTS.md"), withUserContent)

    // Re-run the instructions writer in isolation. init() is also idempotent now, but this
    // narrower test guards against future regressions in the marker-replacement logic.
    writeAgentInstructions(tempDir)

    const second = fs.readFileSync(path.join(tempDir, "AGENTS.md"), "utf-8")
    expect(second).toContain("# My project notes")
    expect(second).toContain("## More user notes")
    const markerCount = (second.match(/<!-- primitiv -->/g) || []).length
    expect(markerCount).toBe(1)
  })
})

describe("writeAgentInstructions target selection", () => {
  test("writes to CLAUDE.md only when AGENTS.md is absent", () => {
    fs.writeFileSync(path.join(tempDir, "CLAUDE.md"), "# Project notes\n")
    writeAgentInstructions(tempDir)

    const claude = fs.readFileSync(path.join(tempDir, "CLAUDE.md"), "utf-8")
    expect(claude).toContain("<!-- primitiv -->")
    expect(claude).toContain("## Primitiv — Design System")
    expect(claude).not.toContain("@AGENTS.md")
    expect(claude).toContain("# Project notes")
    expect(fs.existsSync(path.join(tempDir, "AGENTS.md"))).toBe(false)
  })

  test("writes to AGENTS.md only when CLAUDE.md is absent", () => {
    fs.writeFileSync(path.join(tempDir, "AGENTS.md"), "# Project notes\n")
    writeAgentInstructions(tempDir)

    const agents = fs.readFileSync(path.join(tempDir, "AGENTS.md"), "utf-8")
    expect(agents).toContain("<!-- primitiv -->")
    expect(agents).toContain("## Primitiv — Design System")
    expect(agents).toContain("# Project notes")
    expect(fs.existsSync(path.join(tempDir, "CLAUDE.md"))).toBe(false)
  })

  test("writes to AGENTS.md and references it from CLAUDE.md when both exist", () => {
    fs.writeFileSync(path.join(tempDir, "AGENTS.md"), "# Agents notes\n")
    fs.writeFileSync(path.join(tempDir, "CLAUDE.md"), "# Claude notes\n")
    writeAgentInstructions(tempDir)

    const agents = fs.readFileSync(path.join(tempDir, "AGENTS.md"), "utf-8")
    const claude = fs.readFileSync(path.join(tempDir, "CLAUDE.md"), "utf-8")
    expect(agents).toContain("<!-- primitiv -->")
    expect(agents).toContain("## Primitiv — Design System")
    expect(claude).toContain("<!-- primitiv -->")
    expect(claude).toContain("@AGENTS.md")
    expect(claude).not.toContain("## Primitiv — Design System")
    expect(claude).not.toContain("get_design_context")
    expect(agents).toContain("# Agents notes")
    expect(claude).toContain("# Claude notes")
  })

  test("replaces a legacy full CLAUDE.md block with the AGENTS.md reference", () => {
    fs.writeFileSync(path.join(tempDir, "CLAUDE.md"), "# Claude notes\n")
    writeAgentInstructions(tempDir)
    expect(fs.readFileSync(path.join(tempDir, "CLAUDE.md"), "utf-8")).toContain("get_design_context")

    fs.writeFileSync(path.join(tempDir, "AGENTS.md"), "# Agents notes\n")
    writeAgentInstructions(tempDir)

    const claude = fs.readFileSync(path.join(tempDir, "CLAUDE.md"), "utf-8")
    expect(claude).toContain("# Claude notes")
    expect(claude).toContain("@AGENTS.md")
    expect(claude).not.toContain("get_design_context")
    expect((claude.match(/<!-- primitiv -->/g) || []).length).toBe(1)
  })

  test("creates AGENTS.md when neither file exists", () => {
    writeAgentInstructions(tempDir)

    expect(fs.existsSync(path.join(tempDir, "AGENTS.md"))).toBe(true)
    expect(fs.existsSync(path.join(tempDir, "CLAUDE.md"))).toBe(false)
    const agents = fs.readFileSync(path.join(tempDir, "AGENTS.md"), "utf-8")
    expect(agents).toContain("<!-- primitiv -->")
  })
})

// Helper: stand up a real git repo in `dir` with optional remote and default
// branch. Real git is faster than mocks here and catches shell-escaping bugs
// that would surface in user environments.
function setupGitRepo(dir: string, opts: { remote?: string; defaultBranch?: string } = {}): void {
  const branch = opts.defaultBranch ?? "main"
  execSync("git init", { cwd: dir, stdio: "ignore" })
  // `git symbolic-ref HEAD refs/heads/<branch>` works on older git too;
  // `git init -b` only landed in 2.28. Keeps the test compatible.
  execSync(`git symbolic-ref HEAD refs/heads/${branch}`, { cwd: dir, stdio: "ignore" })
  execSync('git config --local user.email "test@example.com"', { cwd: dir, stdio: "ignore" })
  execSync('git config --local user.name "Test"', { cwd: dir, stdio: "ignore" })
  // Empty commit so HEAD resolves to a real branch ref for `rev-parse`.
  execSync('git commit --allow-empty -m "init"', { cwd: dir, stdio: "ignore" })
  if (opts.remote) {
    execSync(`git remote add origin ${opts.remote}`, { cwd: dir, stdio: "ignore" })
    // Mirror what `git clone` sets so detection picks the right default branch.
    try {
      execSync(`git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/${branch}`, {
        cwd: dir,
        stdio: "ignore"
      })
    } catch {
      // Some git versions reject this without a fetch. Detection still falls back to rev-parse HEAD.
    }
  }
}

function captureConsoleLog<T>(fn: () => T): { result: T; logs: string[] } {
  const logs: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "))
  }
  try {
    const result = fn()
    return { result, logs }
  } finally {
    console.log = original
  }
}

describe("writeGitHubWorkflow", () => {
  const workflowRel = ".github/workflows/primitiv-verify.yml"

  test("skips on non-git directory", () => {
    const { logs } = captureConsoleLog(() => writeGitHubWorkflow(tempDir))
    expect(fs.existsSync(path.join(tempDir, workflowRel))).toBe(false)
    expect(logs.some((l) => l.includes("Not a git repository"))).toBe(true)
  })

  test("skips on non-GitHub remote", () => {
    setupGitRepo(tempDir, { remote: "https://gitlab.com/x/y.git" })
    const { logs } = captureConsoleLog(() => writeGitHubWorkflow(tempDir))
    expect(fs.existsSync(path.join(tempDir, workflowRel))).toBe(false)
    expect(logs.some((l) => l.includes("not on GitHub"))).toBe(true)
  })

  test("installs workflow on GitHub https remote", () => {
    setupGitRepo(tempDir, { remote: "https://github.com/test/repo.git" })
    writeGitHubWorkflow(tempDir)

    const target = path.join(tempDir, workflowRel)
    expect(fs.existsSync(target)).toBe(true)
    const content = fs.readFileSync(target, "utf-8")
    expect(content).toContain("# <!-- primitiv -->")
    expect(content).toContain("# <!-- /primitiv -->")
    expect(content).toContain("name: Primitiv Verify")
    expect(content).toContain("npx --yes @ai-by-design/primitiv verify")
    expect(content).toContain("branches: [main]")
  })

  test("installs workflow on GitHub ssh remote", () => {
    setupGitRepo(tempDir, { remote: "git@github.com:test/repo.git" })
    writeGitHubWorkflow(tempDir)
    expect(fs.existsSync(path.join(tempDir, workflowRel))).toBe(true)
  })

  test("uses detected default branch when not main", () => {
    setupGitRepo(tempDir, { remote: "https://github.com/test/repo.git", defaultBranch: "develop" })
    writeGitHubWorkflow(tempDir)
    const content = fs.readFileSync(path.join(tempDir, workflowRel), "utf-8")
    expect(content).toContain("branches: [develop]")
    expect(content).not.toContain("branches: [main]")
  })

  test("re-running is idempotent (single marker, stable content)", () => {
    setupGitRepo(tempDir, { remote: "https://github.com/test/repo.git" })
    writeGitHubWorkflow(tempDir)
    const first = fs.readFileSync(path.join(tempDir, workflowRel), "utf-8")
    writeGitHubWorkflow(tempDir)
    const second = fs.readFileSync(path.join(tempDir, workflowRel), "utf-8")

    expect(second).toBe(first)
    const markerCount = (second.match(/# <!-- primitiv -->/g) || []).length
    expect(markerCount).toBe(1)
  })

  test("refresh preserves content outside markers", () => {
    setupGitRepo(tempDir, { remote: "https://github.com/test/repo.git" })
    const target = path.join(tempDir, workflowRel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const userHeader = "# User comment above the block\n"
    const oldBlock = `# <!-- primitiv -->\n# old block content\n# <!-- /primitiv -->\n`
    const userFooter = "\n# User comment below the block\n"
    fs.writeFileSync(target, userHeader + oldBlock + userFooter)

    writeGitHubWorkflow(tempDir)

    const content = fs.readFileSync(target, "utf-8")
    expect(content).toContain("# User comment above the block")
    expect(content).toContain("# User comment below the block")
    expect(content).toContain("name: Primitiv Verify")
    expect(content).not.toContain("# old block content")
  })

  test("skips when existing file has no Primitiv marker", () => {
    setupGitRepo(tempDir, { remote: "https://github.com/test/repo.git" })
    const target = path.join(tempDir, workflowRel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const userContent = "# Some user-managed workflow\nname: Custom\n"
    fs.writeFileSync(target, userContent)

    const { logs } = captureConsoleLog(() => writeGitHubWorkflow(tempDir))

    expect(fs.readFileSync(target, "utf-8")).toBe(userContent)
    expect(logs.some((l) => l.includes("not Primitiv-managed"))).toBe(true)
  })

  test("preserves other workflow files", () => {
    setupGitRepo(tempDir, { remote: "https://github.com/test/repo.git" })
    const otherPath = path.join(tempDir, ".github/workflows/test.yml")
    fs.mkdirSync(path.dirname(otherPath), { recursive: true })
    const otherContent = "name: Test\nrun-name: Some test workflow\n"
    fs.writeFileSync(otherPath, otherContent)

    writeGitHubWorkflow(tempDir)

    expect(fs.readFileSync(otherPath, "utf-8")).toBe(otherContent)
    expect(fs.existsSync(path.join(tempDir, workflowRel))).toBe(true)
  })

  test("post-install message includes owner/repo settings link", () => {
    setupGitRepo(tempDir, { remote: "https://github.com/AI-by-design/primitiv.git" })
    const { logs } = captureConsoleLog(() => writeGitHubWorkflow(tempDir))
    expect(logs.join("\n")).toContain("https://github.com/AI-by-design/primitiv/settings/branches")
  })
})

describe("init — boundary fixes", () => {
  test("generated config carries no broken ./src/types JSDoc path", async () => {
    await init(tempDir)
    const config = fs.readFileSync(path.join(tempDir, "primitiv.config.js"), "utf-8")
    expect(config).not.toContain("./src/types")
    expect(config).toContain("module.exports")
  })

  test("a malformed existing .mcp.json doesn't crash init and is left intact", async () => {
    const mcpPath = path.join(tempDir, ".mcp.json")
    fs.writeFileSync(mcpPath, "{ this is not valid json")
    await expect(init(tempDir)).resolves.toBeUndefined()
    // Non-destructive: the unparseable file is preserved, not overwritten.
    expect(fs.readFileSync(mcpPath, "utf-8")).toBe("{ this is not valid json")
  })
})
