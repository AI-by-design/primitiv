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

async function getComponent(
  c: Client,
  args: { name: string; context?: string; detail?: "api" | "usage" | "relationships" | "all" }
) {
  const result = await c.callTool({ name: "get_component", arguments: args })
  const content = result.content as Array<{ type: string; text: string }>
  return { isError: result.isError === true, text: content[0].text }
}

async function disconnect(): Promise<void> {
  await client?.close()
  await server?.stop()
  client = null
  server = null
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

describe("tool annotations", () => {
  test("every MCP tool advertises its read-only behaviour", async () => {
    const c = await connect(writeContract())
    const { tools } = await c.listTools()

    expect(tools).toHaveLength(6)
    for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true)
  })
})

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

describe("get_component relationship projections", () => {
  const componentsWithRelationships: PrimitivContract["components"] = {
    "ui/Button": {
      name: "Button",
      displayName: "Button",
      source: { adapter: "codebase", file: "ui/Button.tsx" },
      uses: { "ui/Zebra": 1, "ui/Icon": 2 },
      usage: { sites: 3 }
    },
    "forms/Input": {
      name: "Input",
      displayName: "Input",
      source: { adapter: "codebase", file: "forms/Input.tsx" },
      uses: { "ui/Icon": 1 }
    },
    "ui/Icon": {
      name: "Icon",
      displayName: "Icon",
      source: { adapter: "codebase", file: "ui/Icon.tsx" },
      usage: { sites: 3 }
    },
    "ui/Zebra": {
      name: "Zebra",
      displayName: "Zebra",
      source: { adapter: "codebase", file: "ui/Zebra.tsx" },
      usage: { sites: 1 }
    }
  }

  test("no-detail calls preserve the legacy payload and omit relationship facts", async () => {
    const generatedAt = new Date().toISOString()
    const baseComponent = {
      name: "Button",
      displayName: "Button",
      source: { adapter: "codebase" as const, file: "ui/Button.tsx" }
    }
    let c = await connect(
      writeContract({
        generatedAt,
        components: { "ui/Button": baseComponent },
        componentNameIndex: { Button: ["ui/Button"] }
      })
    )
    const withoutFacts = await getComponent(c, { name: "Button" })
    await disconnect()

    c = await connect(
      writeContract({
        generatedAt,
        components: { "ui/Button": { ...baseComponent, uses: { "ui/Icon": 2 }, usage: { sites: 4 } } },
        componentNameIndex: { Button: ["ui/Button"] }
      })
    )
    const withFacts = await getComponent(c, { name: "Button" })

    expect(withFacts.text).toBe(withoutFacts.text)
    expect(JSON.parse(withFacts.text).uses).toBeUndefined()
    expect(JSON.parse(withFacts.text).usage).toBeUndefined()
  })

  test("usage, relationships, and all expose only the requested deterministic projections", async () => {
    const c = await connect(
      writeContract({
        components: componentsWithRelationships,
        componentNameIndex: { Button: ["ui/Button"], Icon: ["ui/Icon"], Input: ["forms/Input"], Zebra: ["ui/Zebra"] }
      })
    )

    const usage = JSON.parse((await getComponent(c, { name: "ui/Button", detail: "usage" })).text)
    expect(usage.usage).toEqual({ sites: 3 })
    expect(usage.relationships).toBeUndefined()

    const relationships = JSON.parse((await getComponent(c, { name: "ui/Button", detail: "relationships" })).text)
    expect(relationships.usage).toBeUndefined()
    expect(relationships.relationships).toEqual({ uses: { "ui/Icon": 2, "ui/Zebra": 1 }, usedBy: {} })
    expect(Object.keys(relationships.relationships.uses)).toEqual(["ui/Icon", "ui/Zebra"])

    const all = JSON.parse((await getComponent(c, { name: "ui/Icon", detail: "all" })).text)
    expect(all.usage).toEqual({ sites: 3 })
    expect(all.relationships).toEqual({ uses: {}, usedBy: { "forms/Input": 1, "ui/Button": 2 } })
    expect(Object.keys(all.relationships.usedBy)).toEqual(["forms/Input", "ui/Button"])
  })

  test("api and usage projections normalize their nested facts", async () => {
    const components = {
      "ui/Panel": {
        name: "Panel",
        displayName: "Panel",
        source: { adapter: "codebase", file: "ui/Panel.tsx" },
        props: {
          zebra: {
            type: '"a" | "z"',
            required: false,
            default: "z",
            values: ["z", "a", "a"],
            source: "omit"
          },
          count: { type: "0 | 1", required: true, values: [1, 0, 1] },
          flag: { type: "false | true", required: false, values: [true, false, true] }
        },
        usage: {
          sites: 4,
          props: {
            zebra: ["z", "a", "z"],
            flag: [true, false, true]
          },
          truncatedProps: ["zebra", "flag", "zebra"]
        }
      }
    } as unknown as PrimitivContract["components"]
    const c = await connect(writeContract({ components, componentNameIndex: { Panel: ["ui/Panel"] } }))

    const api = JSON.parse((await getComponent(c, { name: "Panel", detail: "api" })).text)
    expect(api.api).toEqual({
      propCount: 3,
      propNames: ["count", "flag", "zebra"],
      props: {
        count: { type: "0 | 1", required: true, values: [0, 1] },
        flag: { type: "false | true", required: false, values: [false, true] },
        zebra: { type: '"a" | "z"', required: false, default: "z", values: ["a", "z"] }
      }
    })
    expect(api.api.props.zebra.source).toBeUndefined()
    expect(api.usage).toBeUndefined()
    expect(api.relationships).toBeUndefined()

    const usage = JSON.parse((await getComponent(c, { name: "Panel", detail: "usage" })).text)
    expect(usage.usage).toEqual({
      sites: 4,
      props: { flag: [false, true], zebra: ["a", "z"] },
      truncatedProps: ["flag", "zebra"]
    })
    expect(usage.api).toBeUndefined()
    expect(usage.relationships).toBeUndefined()

    const all = JSON.parse((await getComponent(c, { name: "Panel", detail: "all" })).text)
    expect(all.api).toEqual(api.api)
    expect(all.usage).toEqual(usage.usage)
    expect(all.relationships).toEqual({ uses: {}, usedBy: {} })
  })

  test("detail selectors validate only the facts they expose", async () => {
    const components = {
      "ui/Panel": {
        name: "Panel",
        source: { adapter: "codebase", file: "ui/Panel.tsx" },
        // Deliberately malformed API facts. The loose contract boundary keeps this
        // readable until the API projection is requested.
        props: { label: { type: "string", required: "sometimes" } },
        usage: { sites: 2 }
      },
      "ui/Card": {
        name: "Card",
        source: { adapter: "codebase", file: "ui/Card.tsx" },
        uses: { "ui/Panel": 1 }
      }
    } as unknown as PrimitivContract["components"]
    const c = await connect(
      writeContract({ components, componentNameIndex: { Panel: ["ui/Panel"], Card: ["ui/Card"] } })
    )

    expect((await getComponent(c, { name: "Panel" })).isError).toBe(false)
    expect((await getComponent(c, { name: "Panel", detail: "usage" })).isError).toBe(false)
    expect((await getComponent(c, { name: "Panel", detail: "api" })).text).toContain("malformed")

    const malformedUsage = {
      ...components,
      "ui/Panel": { ...components["ui/Panel"], props: {}, usage: { sites: 0 } }
    } as unknown as PrimitivContract["components"]
    await disconnect()
    const usageClient = await connect(writeContract({ components: malformedUsage }))
    expect((await getComponent(usageClient, { name: "Panel", detail: "api" })).isError).toBe(false)
    expect((await getComponent(usageClient, { name: "Panel", detail: "usage" })).text).toContain("malformed")

    const malformedRelationships = {
      ...malformedUsage,
      "ui/Card": { ...malformedUsage["ui/Card"], uses: { "ui/Panel": 0 } }
    } as unknown as PrimitivContract["components"]
    await disconnect()
    const relationshipClient = await connect(writeContract({ components: malformedRelationships }))
    expect((await getComponent(relationshipClient, { name: "Panel", detail: "api" })).isError).toBe(false)
    expect((await getComponent(relationshipClient, { name: "Panel", detail: "relationships" })).text).toContain(
      "malformed"
    )
  })

  test("pre-P0 contracts return zero and empty projections", async () => {
    const c = await connect(
      writeContract({
        version: "0.2.0",
        components: { Card: { name: "Card", source: { adapter: "codebase", file: "Card.tsx" } } }
      })
    )

    const payload = JSON.parse((await getComponent(c, { name: "Card", detail: "all" })).text)
    expect(payload.usage).toEqual({ sites: 0 })
    expect(payload.relationships).toEqual({ uses: {}, usedBy: {} })
    expect(payload.api).toEqual({ propCount: 0, propNames: [] })
  })

  test("ambiguity is resolved before projection and never exposes a candidate graph", async () => {
    const c = await connect(
      writeContract({
        components: {
          ...twoCards,
          "marketing/Card": { ...twoCards["marketing/Card"], uses: { "ui/Icon": 1 } }
        },
        componentNameIndex: { Card: ["marketing/Card", "product/Card"] }
      })
    )

    const payload = JSON.parse((await getComponent(c, { name: "Card", detail: "all" })).text)
    expect(payload.ambiguous).toBe(true)
    expect(payload.usage).toBeUndefined()
    expect(payload.relationships).toBeUndefined()
  })

  test("scope resolution projects the resolved qualified component", async () => {
    const c = await connect(
      writeContract({
        components: {
          ...twoCards,
          "marketing/Card": { ...twoCards["marketing/Card"], uses: { "ui/Icon": 1 } },
          "ui/Icon": { name: "Icon", source: { adapter: "codebase", file: "ui/Icon.tsx" }, usage: { sites: 1 } }
        },
        componentNameIndex: { Card: ["marketing/Card", "product/Card"], Icon: ["ui/Icon"] }
      })
    )

    const payload = JSON.parse(
      (await getComponent(c, { name: "Card", context: "src/marketing/Home.tsx", detail: "relationships" })).text
    )
    expect(payload.id).toBe("marketing/Card")
    expect(payload.resolvedBy).toBe("scope")
    expect(payload.relationships.uses).toEqual({ "ui/Icon": 1 })
  })

  test("usedBy is derived without mutating the persisted contract", async () => {
    const contractPath = writeContract({ components: componentsWithRelationships })
    const before = fs.readFileSync(contractPath, "utf-8")
    const c = await connect(contractPath)

    await getComponent(c, { name: "ui/Icon", detail: "relationships" })

    expect(fs.readFileSync(contractPath, "utf-8")).toBe(before)
    expect(before).not.toContain("usedBy")
  })

  test("a successful contract reload invalidates the cached reverse index", async () => {
    const contractPath = writeContract({
      components: {
        "ui/Button": { name: "Button", source: { adapter: "codebase" }, uses: { "ui/Icon": 1 } },
        "ui/Icon": { name: "Icon", source: { adapter: "codebase" }, usage: { sites: 1 } }
      }
    })
    const c = await connect(contractPath)
    const initial = JSON.parse((await getComponent(c, { name: "ui/Icon", detail: "relationships" })).text)
    expect(initial.relationships.usedBy).toEqual({ "ui/Button": 1 })

    writeContract({
      components: {
        "forms/Input": { name: "Input", source: { adapter: "codebase" }, uses: { "ui/Icon": 2 } },
        "ui/Icon": { name: "Icon", source: { adapter: "codebase" }, usage: { sites: 2 } }
      }
    })
    // Hot reload calls this same successful-load boundary. Invoke it directly so
    // this cache invariant does not depend on platform-specific fs.watch delivery.
    ;(server as unknown as { loadContract: () => void }).loadContract()

    const reloaded = JSON.parse((await getComponent(c, { name: "ui/Icon", detail: "relationships" })).text)
    expect(reloaded.relationships.usedBy).toEqual({ "forms/Input": 2 })
  })

  test("malformed present relationship facts error only when projection is requested", async () => {
    const contractPath = writeContract({
      components: { "ui/Button": { name: "Button", source: { adapter: "codebase" } } }
    })
    const raw = JSON.parse(fs.readFileSync(contractPath, "utf-8"))
    raw.components["ui/Button"].uses = { "ui/Icon": 0 }
    fs.writeFileSync(contractPath, JSON.stringify(raw, null, 2))
    const c = await connect(contractPath)

    expect((await getComponent(c, { name: "ui/Button" })).isError).toBe(false)
    const projected = await getComponent(c, { name: "ui/Button", detail: "relationships" })
    expect(projected.isError).toBe(true)
    expect(projected.text).toContain("malformed")
    expect(projected.text).toContain("primitiv build")
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

  test("summary surfaces a failed source as a warning and passes sourceStatuses through", async () => {
    const c = await connect(
      writeContract({
        sourceStatuses: {
          codebase: { status: "ok", tokens: 3, components: 2 },
          figma: { status: "failed", error: "Figma API error (403): Forbidden" },
          storybook: { status: "skipped" }
        }
      })
    )
    const result = await c.callTool({ name: "get_design_context", arguments: {} })
    const content = result.content as Array<{ type: string; text: string }>
    const payload = JSON.parse(content[0].text)
    expect(payload.sourceStatuses.figma.status).toBe("failed")
    expect(payload.warnings.some((w: string) => w.includes("SOURCE FAILED") && w.includes("figma"))).toBe(true)
  })

  test("summary token counts cover every canonical category", async () => {
    const c = await connect(writeContract({}))
    const result = await c.callTool({ name: "get_design_context", arguments: { category: "", tokenCategory: "" } })
    const content = result.content as Array<{ type: string; text: string }>
    const payload = JSON.parse(content[0].text)
    expect(Object.keys(payload.tokenCounts)).toContain("zIndex")
    expect(Object.keys(payload.tokenCounts)).toContain("motion")
  })

  test("theme modes pass through to the token payload", async () => {
    const tokens = emptyTokenMap()
    tokens.colors["color-bg"] = {
      name: "color-bg",
      value: "#ffffff",
      source: { adapter: "codebase", file: "theme.css", line: 1 },
      modes: { dark: "#000000" }
    }
    const c = await connect(writeContract({ tokens }))
    const result = await c.callTool({ name: "get_design_context", arguments: { category: "tokens" } })
    const content = result.content as Array<{ type: string; text: string }>
    const payload = JSON.parse(content[0].text)
    expect(payload.tokens.colors["color-bg"].modes).toEqual({ dark: "#000000" })
  })

  test("components category adds sorted prop names without exposing the full API", async () => {
    const c = await connect(
      writeContract({
        components: {
          "ui/Panel": {
            name: "Panel",
            source: { adapter: "codebase", file: "ui/Panel.tsx" },
            props: {
              zebra: { type: "string", required: false },
              alpha: { type: "boolean", required: true },
              middle: { type: "number", required: false }
            }
          }
        }
      })
    )
    const result = await c.callTool({ name: "get_design_context", arguments: { category: "components" } })
    const content = result.content as Array<{ type: string; text: string }>
    const payload = JSON.parse(content[0].text)
    expect(payload.components["ui/Panel"].propCount).toBe(3)
    expect(payload.components["ui/Panel"].propNames).toEqual(["alpha", "middle", "zebra"])
    expect(payload.components["ui/Panel"].props).toBeUndefined()
  })

  test("the no-argument summary is byte-equivalent with and without large API, usage, and relationship facts", async () => {
    const generatedAt = new Date().toISOString()
    const baseComponent = {
      name: "Button",
      displayName: "Button",
      source: { adapter: "codebase" as const, file: "ui/Button.tsx" }
    }
    const props = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `prop${String(index).padStart(3, "0")}`,
        { type: '"a" | "b"', required: false, values: ["a", "b"] }
      ])
    )
    const observedProps = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `prop${String(index).padStart(3, "0")}`,
        Array.from({ length: 20 }, (__, valueIndex) => valueIndex)
      ])
    )
    let c = await connect(writeContract({ generatedAt, components: { "ui/Button": baseComponent } }))
    const before = await c.callTool({ name: "get_design_context", arguments: {} })
    const beforeText = (before.content as Array<{ type: string; text: string }>)[0].text
    await disconnect()

    c = await connect(
      writeContract({
        generatedAt,
        components: {
          "ui/Button": {
            ...baseComponent,
            props,
            uses: { "ui/Icon": 2 },
            usage: { sites: 4, props: observedProps, truncatedProps: Object.keys(observedProps) }
          }
        }
      })
    )
    const after = await c.callTool({ name: "get_design_context", arguments: {} })
    const afterText = (after.content as Array<{ type: string; text: string }>)[0].text

    expect(afterText).toBe(beforeText)
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

// Every filter arg is declared .optional() — a strict MCP client must be able to make the
// no-arg calls the tool descriptions (and the init agent block) promise. Pre-fix these five
// failed schema validation before the handler ran.
describe("omittable args are declared optional", () => {
  test("get_design_context with no args returns the summary", async () => {
    const c = await connect(writeContract({ version: "0.3.0" }))
    const result = await c.callTool({ name: "get_design_context", arguments: {} })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0].text).contractVersion).toBe("0.3.0")
  })

  test("get_token with name only searches every category", async () => {
    const c = await connect(
      writeContract({
        tokens: {
          ...emptyTokenMap(),
          colors: { primary: { name: "primary", value: "#663399", source: { adapter: "codebase" } } }
        }
      })
    )
    const result = await c.callTool({ name: "get_token", arguments: { name: "primary" } })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    const payload = JSON.parse(content[0].text)
    expect(payload.value).toBe("#663399")
    expect(payload.category).toBe("colors")
  })

  test("get_conflicts with no args defaults to all types, pending status", async () => {
    const c = await connect(
      writeContract({
        conflicts: [
          {
            type: "token",
            name: "colors.primary",
            sources: [
              { source: { adapter: "codebase", file: "tokens.css" }, value: "#663399" },
              { source: { adapter: "figma" }, value: "#639" }
            ],
            resolution: "pending"
          }
        ]
      })
    )
    const result = await c.callTool({ name: "get_conflicts", arguments: {} })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0].text).count).toBe(1)
  })

  test("get_inferred_rules uses the contract timestamp for newly written contracts", async () => {
    const generatedAt = "2026-08-05T12:00:00.000Z"
    const c = await connect(
      writeContract({
        generatedAt,
        inferredRules: {
          rules: [
            { id: "spacing-scale", category: "spacing", rule: "4px base scale", confidence: "high", evidence: [] }
          ]
        }
      })
    )
    const result = await c.callTool({ name: "get_inferred_rules", arguments: {} })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0].text)).toMatchObject({ count: 1, generatedAt })
  })

  test("get_inferred_rules keeps older contracts with a nested timestamp readable", async () => {
    const generatedAt = "2026-08-05T12:00:00.000Z"
    const c = await connect(
      writeContract({
        generatedAt,
        inferredRules: {
          generatedAt: "2026-01-01T00:00:00.000Z",
          rules: [
            { id: "spacing-scale", category: "spacing", rule: "4px base scale", confidence: "high", evidence: [] }
          ]
        }
      })
    )
    const result = await c.callTool({ name: "get_inferred_rules", arguments: { category: "spacing" } })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0].text)).toMatchObject({ count: 1, generatedAt })
  })

  test("get_violations with no args returns all violations", async () => {
    const c = await connect(writeContract({ violations: [] }))
    const result = await c.callTool({ name: "get_violations", arguments: {} })
    expect(result.isError).toBeFalsy()
    const content = result.content as Array<{ type: string; text: string }>
    expect(JSON.parse(content[0].text).count).toBe(0)
  })
})

describe("contract boundary validation", () => {
  test("a structurally malformed contract degrades to the setup error instead of crashing", async () => {
    const contractPath = path.join(tempDir, "primitiv.contract.json")
    // Valid JSON, but missing the fields the tools dereference (conflicts/tokens/components).
    // Pre-fix this passed the truthy null-guard and crashed at `.conflicts.filter()`.
    fs.writeFileSync(contractPath, JSON.stringify({ version: "9.9.9", note: "truncated" }))
    const c = await connect(contractPath)
    const result = await c.callTool({
      name: "get_design_context",
      arguments: { category: "summary", tokenCategory: "" }
    })
    expect(result.isError).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].text).toContain("contract_missing")
  })

  test("an unparseable contract file degrades instead of crashing", async () => {
    const contractPath = path.join(tempDir, "primitiv.contract.json")
    fs.writeFileSync(contractPath, "{ not valid json")
    const c = await connect(contractPath)
    const result = await c.callTool({ name: "get_token", arguments: { name: "x", category: "" } })
    expect(result.isError).toBe(true)
  })
})
