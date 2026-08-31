import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { PrimitivMCPServer } from "./mcp/server"
import type { PrimitivContract } from "./types"

const CLI = path.join(__dirname, "cli.ts")

interface CliResult {
  exitCode: number
  stdout: string
  stderr: string
}

async function runCli(cwd: string, ...args: string[]): Promise<CliResult> {
  // Keep this asynchronous: the fixture server runs in this process and must be
  // able to answer while the child CLI performs its real HTTP request.
  const child = Bun.spawn(["bun", CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  return { exitCode, stdout, stderr }
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  const text = result.content?.find((item) => item.type === "text")?.text
  if (!text) throw new Error("MCP result did not contain text")
  return text
}

function writeFixture(root: string, storybookUrl: string): void {
  const files: Record<string, string> = {
    "stories/AdminButton.stories.tsx": `const baseArgs = { label: "Admin action", disabled: false }

export default {
  title: "Admin/Button",
  args: { ...baseArgs, runtimeOnly: makeRuntimeValue() },
  argTypes: {
    disabled: { type: "boolean", control: "boolean", required: true },
    tone: {
      type: { name: "enum", value: ["primary", "secondary", "danger"], required: false },
      control: "select",
      options: ["primary", "secondary"],
      mapping: { primary: "brand", secondary: getSecondaryTone() }
    },
    controlOnly: { control: false }
  }
}

export const Primary = { args: { tone: "primary" } }
export const Secondary = {
  args: { disabled: true, tone: chooseTone() },
  argTypes: { tone: { control: "radio", options: ["secondary"] } }
}
`,
    "stories/StorefrontButton.stories.tsx": `export default {
  title: "Storefront/Button",
  argTypes: {
    label: { type: "string", control: "text" }
  }
}

export const Primary = {}
`,
    "primitiv.config.js": `module.exports = {
  sources: {
    storybook: {
      url: ${JSON.stringify(storybookUrl)},
      sourceRoot: "."
    }
  },
  governance: { sourceOfTruth: "storybook", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}
`
  }

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content)
  }
}

describe("Storybook static evidence workflow", () => {
  test("Storybook HTTP → CLI build → contract → verify → MCP", async () => {
    // Canonicalize macOS's /var → /private/var alias so the spawned CLI and the
    // in-process MCP server agree on the contract's project root.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-storybook-workflow-")))
    const contractPath = path.join(root, "primitiv.contract.json")
    let mcpServer: PrimitivMCPServer | undefined
    let client: Client | undefined
    let storybook: ReturnType<typeof Bun.serve> | undefined
    let manifestRequestCount = 0

    const entryPairs = [
      [
        "storefront-primary",
        {
          type: "story",
          id: "storefront-button--primary",
          title: "Storefront/Button",
          name: "Primary",
          importPath: "./stories/StorefrontButton.stories.tsx"
        }
      ],
      [
        "admin-secondary",
        {
          type: "story",
          id: "admin-button--secondary",
          title: "Admin/Button",
          name: "Secondary",
          importPath: "./stories/AdminButton.stories.tsx"
        }
      ],
      [
        "admin-docs",
        {
          type: "docs",
          id: "admin-button--docs",
          title: "Admin/Button",
          name: "Docs",
          importPath: "./stories/AdminButton.stories.tsx"
        }
      ],
      [
        "admin-primary",
        {
          type: "story",
          id: "admin-button--primary",
          title: "Admin/Button",
          name: "Primary",
          importPath: "./stories/AdminButton.stories.tsx"
        }
      ]
    ] as const

    try {
      storybook = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          const url = new URL(request.url)
          if (url.pathname !== "/index.json") return new Response("Not found", { status: 404 })
          manifestRequestCount++
          const ordered = manifestRequestCount % 2 === 0 ? [...entryPairs].reverse() : entryPairs
          return Response.json({ entries: Object.fromEntries(ordered) })
        }
      })
      writeFixture(root, `http://127.0.0.1:${storybook.port}`)

      const firstBuild = await runCli(root, "build")
      expect(firstBuild.exitCode).toBe(0)
      expect(firstBuild.stderr).toBe("")
      expect(firstBuild.stdout).toContain("✓ Found 2 components")

      const firstContract = JSON.parse(fs.readFileSync(contractPath, "utf8")) as PrimitivContract
      expect(firstContract.sourceStatuses?.storybook).toEqual({ status: "ok", tokens: 0, components: 2 })
      expect(firstContract.conflicts).toEqual([])
      expect(Object.keys(firstContract.components)).toEqual(["storybook:Admin/Button", "storybook:Storefront/Button"])
      expect(firstContract.componentNameIndex?.Button).toEqual([
        "storybook:Admin/Button",
        "storybook:Storefront/Button"
      ])

      const admin = firstContract.components["storybook:Admin/Button"]
      expect(admin.name).toBe("Button")
      expect(admin.displayName).toBe("Button")
      expect(admin.variants).toBeUndefined()
      expect(admin.props).toEqual({
        disabled: { type: "boolean", required: true },
        tone: { type: "enum", required: false, values: ["danger", "primary", "secondary"] }
      })
      expect(admin.source).toEqual({
        adapter: "storybook",
        file: "./stories/AdminButton.stories.tsx",
        metadata: {
          storyIds: ["admin-button--primary", "admin-button--secondary"],
          title: "Admin/Button"
        }
      })
      expect(admin.demonstrated).toEqual({
        title: "Admin/Button",
        extraction: "source",
        storyCount: 2,
        defaultArgs: { disabled: false, label: "Admin action" },
        unresolvedDefaultArgs: ["runtimeOnly"],
        controls: {
          controlOnly: { control: false },
          disabled: { control: "boolean" },
          tone: {
            control: "select",
            choices: [
              { option: "primary", mappedValue: "brand" },
              { option: "secondary", mappingUnresolved: true }
            ]
          }
        },
        stories: [
          {
            id: "admin-button--primary",
            name: "Primary",
            exportName: "Primary",
            importPath: "./stories/AdminButton.stories.tsx",
            args: { tone: "primary" }
          },
          {
            id: "admin-button--secondary",
            name: "Secondary",
            exportName: "Secondary",
            importPath: "./stories/AdminButton.stories.tsx",
            args: { disabled: true },
            unresolvedArgs: ["tone"],
            controls: { tone: { control: "radio", choices: [{ option: "secondary" }] } }
          }
        ]
      })
      expect(JSON.stringify(admin)).not.toContain("admin-button--docs")

      const secondBuild = await runCli(root, "build")
      expect(secondBuild.exitCode).toBe(0)
      expect(secondBuild.stderr).toBe("")
      const secondContract = JSON.parse(fs.readFileSync(contractPath, "utf8")) as PrimitivContract
      expect(secondContract.components).toEqual(firstContract.components)
      expect(secondContract.componentNameIndex).toEqual(firstContract.componentNameIndex)

      const verification = await runCli(root, "verify", "--json")
      expect(verification.exitCode).toBe(0)
      expect(verification.stderr).toBe("")
      const verifyResult = JSON.parse(verification.stdout)
      expect(verifyResult.status).toBe("clean")
      expect(verifyResult.drift).toEqual({ isStale: false, changes: [] })
      expect(verifyResult.conflicts).toEqual({ total: 0, pending: 0 })
      expect(verifyResult.messages).toContainEqual(expect.stringContaining("intentional coexistence"))

      mcpServer = new PrimitivMCPServer(contractPath)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await mcpServer.start(serverTransport)
      client = new Client({ name: "storybook-static-evidence-workflow", version: "0.0.0" })
      await client.connect(clientTransport)

      const defaultResult = await client.callTool({
        name: "get_component",
        arguments: { name: "storybook:Admin/Button" }
      })
      expect(defaultResult.isError).not.toBe(true)
      const defaultPayload = JSON.parse(textOf(defaultResult))
      expect(defaultPayload.id).toBe("storybook:Admin/Button")
      expect(defaultPayload.props).toEqual(admin.props)
      expect(defaultPayload.source).toEqual(admin.source)
      expect(defaultPayload.demonstrated).toBeUndefined()
      expect(defaultPayload.variants).toBeUndefined()

      const allResult = await client.callTool({
        name: "get_component",
        arguments: { name: "storybook:Admin/Button", detail: "all" }
      })
      expect(allResult.isError).not.toBe(true)
      const allPayload = JSON.parse(textOf(allResult))
      expect(allPayload.api.props).toEqual(admin.props)
      expect(allPayload.usage).toEqual({ sites: 0 })
      expect(allPayload.relationships).toEqual({ uses: {}, usedBy: {} })
      expect(allPayload.demonstrated).toBeUndefined()

      const ambiguousResult = await client.callTool({ name: "get_component", arguments: { name: "Button" } })
      expect(ambiguousResult.isError).not.toBe(true)
      const ambiguous = JSON.parse(textOf(ambiguousResult))
      expect(ambiguous.ambiguous).toBe(true)
      expect(ambiguous.matches.map((match: { id: string }) => match.id)).toEqual([
        "storybook:Admin/Button",
        "storybook:Storefront/Button"
      ])

      expect(manifestRequestCount).toBe(3)
    } finally {
      try {
        await client?.close()
      } finally {
        try {
          await mcpServer?.stop()
        } finally {
          storybook?.stop(true)
          fs.rmSync(root, { recursive: true, force: true })
        }
      }
    }
  }, 30_000)
})
