import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { init, writeAgentInstructions } from "./init"

let tempDir: string
let origHome: string | undefined

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-init-test-"))
  origHome = process.env.HOME
  // Redirect os.homedir() to temp dir so Codex-config detection doesn't touch the real ~/.codex.
  process.env.HOME = tempDir
})

afterEach(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  fs.rmSync(tempDir, { recursive: true, force: true })
})

describe("init", () => {
  test("creates primitiv.config.js", async () => {
    await init(tempDir)
    expect(fs.existsSync(path.join(tempDir, "primitiv.config.js"))).toBe(true)
  })

  test("AGENT_BLOCK contains the Aura-style routing rule", async () => {
    await init(tempDir)
    const agents = fs.readFileSync(path.join(tempDir, "AGENTS.md"), "utf-8")
    expect(agents).toContain("When the user asks about design tokens")
    expect(agents).toContain("<!-- primitiv -->")
    expect(agents).toContain("<!-- /primitiv -->")
  })

  test("MCP config is created with primitiv entry", async () => {
    await init(tempDir)
    const mcpPath = path.join(tempDir, ".mcp.json")
    expect(fs.existsSync(mcpPath)).toBe(true)
    const config = JSON.parse(fs.readFileSync(mcpPath, "utf-8"))
    expect(config.mcpServers?.primitiv?.command).toBe("bunx")
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
})

describe("writeAgentInstructions idempotency", () => {
  test("second call replaces the Primitiv block without duplicating", async () => {
    await init(tempDir)
    const firstContents = fs.readFileSync(path.join(tempDir, "AGENTS.md"), "utf-8")

    // Simulate user-added content around the Primitiv block.
    const withUserContent = `# My project notes\n\nKeep me.\n${firstContents}\n\n## More user notes\n`
    fs.writeFileSync(path.join(tempDir, "AGENTS.md"), withUserContent)

    // Re-run just the instructions writer (init() would exit because config already exists).
    writeAgentInstructions(tempDir)

    const second = fs.readFileSync(path.join(tempDir, "AGENTS.md"), "utf-8")
    expect(second).toContain("# My project notes")
    expect(second).toContain("## More user notes")
    const markerCount = (second.match(/<!-- primitiv -->/g) || []).length
    expect(markerCount).toBe(1)
  })
})
