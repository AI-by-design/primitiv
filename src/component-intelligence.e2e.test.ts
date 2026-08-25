import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { buildContract, type PrimitivContract } from "./index"
import { PrimitivMCPServer } from "./mcp/server"
import { verify } from "./verify/verify"

function writeGraphFixture(root: string): void {
  const files: Record<string, string> = {
    "components/Icon.tsx": `export function Icon() { return <svg /> }`,
    "components/Button.types.ts": `export interface ButtonProps {
  size?: "sm" | "md" | "lg"
  disabled?: false | true
  elevation?: 0 | 1 | 2
  label?: string
}`,
    "components/Button.tsx": `import { Icon } from "./Icon"
import type { ButtonProps } from "./Button.types"

export function Button({
  size = "md",
  disabled = false,
  elevation = 1,
  label = "Button"
}: ButtonProps) {
  return <button><Icon />{label}{size}{disabled}{elevation}</button>
}`,
    "components/Toolbar.tsx": `import { Button } from "./Button"

export function Toolbar() {
  return <><Button /><Button /></>
}`,
    "screens/Settings.tsx": `import { Button } from "../components/Button"
import { Toolbar } from "../components/Toolbar"

export function Settings() {
  return <><Toolbar /><Button /></>
}`,
    "primitiv.config.js": `module.exports = {
  sources: { codebase: { root: ".", patterns: ["**/*.ts", "**/*.tsx"], ignore: ["node_modules/**"] } },
  governance: { sourceOfTruth: "codebase", onConflict: "warn" },
  output: { path: "./primitiv.contract.json" }
}`
  }

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath)
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content)
  }
}

interface ComponentProjection {
  id: string
  props: Record<string, unknown>
  usage: unknown
  relationships: unknown
}

async function getComponent(client: Client, name: string): Promise<ComponentProjection> {
  const result = await client.callTool({ name: "get_component", arguments: { name, detail: "all" } })
  expect(result.isError).not.toBe(true)
  const content = result.content as Array<{ type: string; text: string }>
  return JSON.parse(content[0].text) as ComponentProjection
}

describe("component intelligence end-to-end", () => {
  test("builds props and relationships, detects drift, and projects committed MCP facts", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-component-intelligence-e2e-"))
    let server: PrimitivMCPServer | undefined
    let client: Client | undefined

    try {
      writeGraphFixture(tempDir)
      const contractPath = path.join(tempDir, "primitiv.contract.json")
      const initial = await buildContract(undefined, { cwd: tempDir, silent: true })
      fs.writeFileSync(contractPath, JSON.stringify(initial, null, 2))
      const contract = JSON.parse(fs.readFileSync(contractPath, "utf8")) as PrimitivContract

      expect(Object.keys(contract.components)).toEqual([
        "components/Button",
        "components/Icon",
        "components/Toolbar",
        "screens/Settings"
      ])
      expect(contract.components["components/Button"]?.props).toEqual({
        size: { type: '"sm" | "md" | "lg"', required: false, values: ["lg", "md", "sm"], default: "md" },
        disabled: { type: "false | true", required: false, values: [false, true], default: "false" },
        elevation: { type: "0 | 1 | 2", required: false, values: [0, 1, 2], default: "1" },
        label: { type: "string", required: false, default: "Button" }
      })
      expect(contract.components["components/Button"]?.uses).toEqual({ "components/Icon": 1 })
      expect(contract.components["components/Icon"]?.usage).toEqual({ sites: 1 })
      expect(contract.components["components/Toolbar"]?.uses).toEqual({ "components/Button": 2 })
      expect(contract.components["components/Toolbar"]?.usage).toEqual({ sites: 1 })
      expect(contract.components["components/Button"]?.usage).toEqual({ sites: 3 })
      expect(contract.components["screens/Settings"]?.uses).toEqual({
        "components/Button": 1,
        "components/Toolbar": 1
      })

      fs.writeFileSync(
        path.join(tempDir, "components/Toolbar.tsx"),
        `import { Button } from "./Button"

export function Toolbar() {
  return <><Button /><Button /><Button /></>
}`
      )
      const drift = await verify(undefined, { cwd: tempDir })
      expect(drift.status).toBe("stale")
      expect(drift.drift.changes).toContain(
        "component use count changed: components/Toolbar → components/Button (2 → 3)"
      )
      expect(drift.drift.changes).toContain("component usage changed: components/Button (3 → 4 sites)")

      server = new PrimitivMCPServer(contractPath)
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await server.start(serverTransport)
      client = new Client({ name: "component-intelligence-e2e", version: "0.0.0" })
      await client.connect(clientTransport)

      const button = await getComponent(client, "components/Button")
      expect(button.id).toBe("components/Button")
      expect(button.props.size).toEqual({
        type: '"sm" | "md" | "lg"',
        required: false,
        values: ["lg", "md", "sm"],
        default: "md"
      })
      expect(button.usage).toEqual({ sites: 3 })
      expect(button.relationships).toEqual({
        uses: { "components/Icon": 1 },
        usedBy: {
          "components/Toolbar": 2,
          "screens/Settings": 1
        }
      })

      const icon = await getComponent(client, "components/Icon")
      expect(icon.id).toBe("components/Icon")
      expect(icon.usage).toEqual({ sites: 1 })
      expect(icon.relationships).toEqual({
        uses: {},
        usedBy: { "components/Button": 1 }
      })
    } finally {
      try {
        await client?.close()
      } finally {
        try {
          await server?.stop()
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true })
        }
      }
    }
  })
})
