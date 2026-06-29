import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { PrimitivContract } from "../types"
import { emptyTokenMap } from "../types"
import { PrimitivMCPServer } from "./server"

let tempDir: string
let server: PrimitivMCPServer | null = null
let client: Client | null = null

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-mcp-test-"))
})

afterEach(async () => {
  await client?.close()
  await server?.stop()
  client = null
  server = null
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeContract(overrides: Partial<PrimitivContract> = {}): string {
  const contractPath = path.join(tempDir, "primitiv.contract.json")
  const contract: PrimitivContract = {
    version: "0.3.0",
    generatedAt: new Date().toISOString(),
    sources: ["codebase"],
    sourceRoot: tempDir,
    configPath: path.join(tempDir, "primitiv.config.js"),
    tokens: emptyTokenMap(),
    components: {},
    conflicts: [],
    ...overrides
  }
  fs.writeFileSync(contractPath, JSON.stringify(contract, null, 2))
  return contractPath
}

async function connect(contractPath: string): Promise<Client> {
  server = new PrimitivMCPServer(contractPath)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.start(serverTransport)
  client = new Client({ name: "test-client", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

async function getComponent(c: Client, args: { name: string; context?: string }) {
  const result = await c.callTool({ name: "get_component", arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  return { isError: result.isError === true, text: content[0].text }
}

const twoCards: PrimitivContract["components"] = {
  "marketing/Card": {
    name: "Card",
    displayName: "Card",
    source: { adapter: "codebase", file: "marketing/Card.tsx" },
    rationale: { when: "marketing pages" }
  },
  "product/Card": {
    name: "Card",
    displayName: "Card",
    source: { adapter: "codebase", file: "product/Card.tsx" },
    rationale: { when: "product surfaces" }
  }
}

describe("get_component resolution", () => {
  test("name-only lookup with a single match returns the component with its id", async () => {
    const c = await connect(
      writeContract({
        components: {
          "ui/Button": { name: "Button", displayName: "Button", source: { adapter: "codebase", file: "ui/Button.tsx" } }
        },
        componentNameIndex: { Button: ["ui/Button"] }
      })
    )
    const { isError, text } = await getComponent(c, { name: "Button" })
    expect(isError).toBe(false)
    const payload = JSON.parse(text)
    expect(payload.id).toBe("ui/Button")
    expect(payload.displayName).toBe("Button")
  })

  test("a qualified id is a direct hit", async () => {
    const c = await connect(
      writeContract({ components: twoCards, componentNameIndex: { Card: ["marketing/Card", "product/Card"] } })
    )
    const { isError, text } = await getComponent(c, { name: "product/Card" })
    expect(isError).toBe(false)
    expect(JSON.parse(text).id).toBe("product/Card")
  })

  test("unknown name errors with available display names", async () => {
    const c = await connect(
      writeContract({ components: twoCards, componentNameIndex: { Card: ["marketing/Card", "product/Card"] } })
    )
    const { isError, text } = await getComponent(c, { name: "Modal" })
    expect(isError).toBe(true)
    expect(text).toContain("Card")
  })

  test("multi-match without context returns the ambiguous payload with the instruction", async () => {
    const c = await connect(
      writeContract({ components: twoCards, componentNameIndex: { Card: ["marketing/Card", "product/Card"] } })
    )
    const { isError, text } = await getComponent(c, { name: "Card" })
    expect(isError).toBe(false)
    const payload = JSON.parse(text)
    expect(payload.ambiguous).toBe(true)
    expect(payload.matches).toHaveLength(2)
    expect(payload.matches[0].rationale?.when).toBeDefined()
    expect(payload.instruction).toContain("do not choose arbitrarily")
  })

  test("context resolves a multi-match by path scope", async () => {
    const c = await connect(
      writeContract({ components: twoCards, componentNameIndex: { Card: ["marketing/Card", "product/Card"] } })
    )
    const { text } = await getComponent(c, { name: "Card", context: "src/marketing/pages/Home.tsx" })
    const payload = JSON.parse(text)
    expect(payload.id).toBe("marketing/Card")
    expect(payload.resolvedBy).toBe("scope")
  })

  test("a context that contains neither scope falls through to the ambiguous payload", async () => {
    const c = await connect(
      writeContract({ components: twoCards, componentNameIndex: { Card: ["marketing/Card", "product/Card"] } })
    )
    const { text } = await getComponent(c, { name: "Card", context: "src/shared/Header.tsx" })
    expect(JSON.parse(text).ambiguous).toBe(true)
  })

  test("an explicit scope field overrides the id's directory for scope resolution", async () => {
    const c = await connect(
      writeContract({
        components: {
          "legacy/Card": {
            name: "Card",
            displayName: "Card",
            scope: "app/checkout",
            source: { adapter: "codebase", file: "legacy/Card.tsx" }
          },
          "shared/Card": { name: "Card", displayName: "Card", source: { adapter: "codebase", file: "shared/Card.tsx" } }
        },
        componentNameIndex: { Card: ["legacy/Card", "shared/Card"] }
      })
    )
    const { text } = await getComponent(c, { name: "Card", context: "app/checkout/Form.tsx" })
    const payload = JSON.parse(text)
    expect(payload.id).toBe("legacy/Card")
    expect(payload.resolvedBy).toBe("scope")
  })

  test("a governed conflict (resolved id) wins before scope or escalation", async () => {
    const c = await connect(
      writeContract({
        components: {
          "promo/Banner": {
            name: "Banner",
            displayName: "Banner",
            source: { adapter: "codebase", file: "promo/Banner.tsx" }
          },
          "figma:Banner": { name: "Banner", displayName: "Banner", source: { adapter: "figma" } }
        },
        componentNameIndex: { Banner: ["figma:Banner", "promo/Banner"] },
        conflicts: [
          {
            type: "component",
            name: "Banner",
            sources: [
              { source: { adapter: "codebase", file: "promo/Banner.tsx" }, value: "promo/Banner.tsx" },
              { source: { adapter: "figma" }, value: "figma" }
            ],
            resolved: "promo/Banner",
            resolution: "pending"
          }
        ]
      })
    )
    const { text } = await getComponent(c, { name: "Banner" })
    const payload = JSON.parse(text)
    expect(payload.id).toBe("promo/Banner")
    expect(payload.resolvedBy).toBe("governance.sourceOfTruth")
  })

  test("pre-0.3 contracts (bare-name keys, no index) still resolve name lookups", async () => {
    const c = await connect(
      writeContract({
        version: "0.2.0",
        components: { Card: { name: "Card", source: { adapter: "codebase", file: "Card.tsx" } } }
      })
    )
    const { isError, text } = await getComponent(c, { name: "Card" })
    expect(isError).toBe(false)
    expect(JSON.parse(text).id).toBe("Card")
  })
})

describe("get_design_context", () => {
  test("summary surfaces the contract schema version", async () => {
    const c = await connect(writeContract({ version: "0.3.0" }))
    const result = await c.callTool({ name: "get_design_context", arguments: { category: "", tokenCategory: "" } })
    const content = result.content as Array<{ type: string; text: string }>
    const payload = JSON.parse(content[0].text)
    expect(payload.contractVersion).toBe("0.3.0")
  })

  test("summary token counts cover every canonical category", async () => {
    const c = await connect(writeContract({}))
    const result = await c.callTool({ name: "get_design_context", arguments: { category: "", tokenCategory: "" } })
    const content = result.content as Array<{ type: string; text: string }>
    const payload = JSON.parse(content[0].text)
    expect(Object.keys(payload.tokenCounts)).toContain("zIndex")
    expect(Object.keys(payload.tokenCounts)).toContain("motion")
  })
})

describe("get_violations", () => {
  test("an unknown category errors instead of silently returning empty (rule 10)", async () => {
    const c = await connect(writeContract({ violations: [] }))
    const result = await c.callTool({ name: "get_violations", arguments: { category: "typography" } })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("colors")
    expect(content[0].text).toContain("spacing")
  })

  test("a real lint category filters without error", async () => {
    const c = await connect(writeContract({ violations: [] }))
    const result = await c.callTool({ name: "get_violations", arguments: { category: "colors" } })
    expect(result.isError).toBeFalsy()
  })
})
