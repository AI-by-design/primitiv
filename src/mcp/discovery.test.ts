import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { ComponentCatalog, ComponentContext, ComponentShortlist } from "../discovery"
import { DISCOVERY_LIMITS } from "../discovery"
import type { PrimitivContract } from "../types"
import { emptyTokenMap } from "../types"
import { PrimitivMCPServer } from "./server"

let directory: string
let contractPath: string
let server: PrimitivMCPServer
let client: Client

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-discovery-test-"))
  contractPath = path.join(directory, "primitiv.contract.json")
})
afterEach(async () => {
  await client?.close()
  await server?.stop()
  fs.rmSync(directory, { recursive: true, force: true })
})

function fixture(): PrimitivContract {
  return {
    version: "0.3.0",
    generatedAt: "2026-10-07T00:00:00Z",
    sources: ["codebase"],
    sourceRoot: directory,
    configPath: path.join(directory, "primitiv.config.js"),
    tokens: emptyTokenMap(),
    components: {
      "ui/Button": {
        name: "Button",
        source: { adapter: "codebase" },
        classification: { atomicLevel: "atom", intents: ["input", "call-to-action"] },
        props: { label: { type: "string", required: true } },
        rationale: { why: "Existing reusable control", when: "Submit forms" }
      },
      "ui/Legacy": { name: "Legacy", source: { adapter: "codebase" }, uses: { "ui/Button": 2 } }
    },
    conflicts: []
  }
}
function write(value: unknown): void {
  fs.writeFileSync(contractPath, JSON.stringify(value))
}
async function connect(): Promise<void> {
  server = new PrimitivMCPServer(contractPath)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.start(serverTransport)
  client = new Client({ name: "discovery-test", version: "0.0.0" })
  await client.connect(clientTransport)
}
async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await client.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: "text"; text: string }>
  const payload = JSON.parse(content[0].text)
  expect(payload).toEqual(result.structuredContent)
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    name === "get_component_context" ? DISCOVERY_LIMITS.detailBytes : DISCOVERY_LIMITS.shortlistBytes
  )
  return payload as T
}
type ErrorPayload = {
  snapshotId: string | null
  reload: ComponentCatalog["reload"]
  error: { code: string }
}
async function waitForReload(
  state: ComponentCatalog["reload"]["state"],
  expectedSnapshot?: string
): Promise<ComponentCatalog> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const catalog = await call<ComponentCatalog>("get_component_catalog")
    if (catalog.reload.state === state && (expectedSnapshot === undefined || catalog.snapshotId !== expectedSnapshot)) {
      return catalog
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Contract did not reach reload state ${state}`)
}

describe("MCP component discovery", () => {
  test("registers typed read-only discovery tools and preserves legacy complete tools", async () => {
    write(fixture())
    await connect()
    const tools = (await client.listTools()).tools
    const find = tools.find((tool) => tool.name === "find_components")
    const detail = tools.find((tool) => tool.name === "get_component_context")
    expect(find?.annotations?.readOnlyHint).toBe(true)
    expect(find?.inputSchema.properties?.limit).toMatchObject({ type: "integer", maximum: 50 })
    expect(find?.inputSchema.properties?.level).not.toHaveProperty("default")
    expect(detail?.inputSchema.required).toEqual(["id", "snapshotId"])
    const catalog = await call<ComponentCatalog>("get_component_catalog")
    expect(catalog.total).toBe(2)
    expect(catalog.project).toEqual({ sourceRoot: directory, configPath: path.join(directory, "primitiv.config.js") })
    expect(catalog.generatedAt).toBe("2026-10-07T00:00:00Z")
    expect(catalog.coverage.missingEither).toBe(1)
    const shortlist = await call<ComponentShortlist>("find_components", { intents: ["input"] })
    expect(shortlist.items.map((item) => item.id)).toEqual(["ui/Button"])
    const unclassified = await call<ComponentShortlist>("find_components", { unclassified: "either" })
    expect(unclassified.items.map((item) => item.id)).toEqual(["ui/Legacy"])
    const context = await call<ComponentContext>("get_component_context", {
      id: "ui/Button",
      snapshotId: catalog.snapshotId
    })
    expect(context.complete).toBe(true)
    expect(context.sections?.api).toMatchObject({ declared: { props: { label: { required: true } } } })
    expect(context.sections?.relationships).toMatchObject({ usedBy: { "ui/Legacy": 2 } })
    const legacy = await client.callTool({ name: "get_component", arguments: { name: "Button" } })
    expect(legacy.isError).toBeUndefined()
    expect(JSON.parse((legacy.content as Array<{ text: string }>)[0].text).rationale.why).toBe(
      "Existing reusable control"
    )
  })

  test("unknown and invalid fields produce bounded errors with snapshot metadata", async () => {
    write(fixture())
    await connect()
    const cases: Array<[string, Record<string, unknown>]> = [
      ["get_component_catalog", { names: true }],
      ["find_components", { level: "unknown" }],
      ["find_components", { kind: "component", hidden: "x".repeat(200000) }],
      ["find_components", { intents: ["unknown"] }],
      ["find_components", { scope: "/" }],
      ["find_components", { limit: 51 }],
      ["get_component_context", {}],
      ["get_component_context", { id: 42, snapshotId: "anything" }],
      ["get_component_context", { id: "ui/Button", snapshotId: "anything", sections: ["unknown"] }]
    ]
    for (const [name, args] of cases) {
      const payload = await call<ErrorPayload>(name, args)
      expect(payload.error.code).toBe("invalid-query")
      expect(payload.snapshotId).toStartWith("discovery-v1:")
      expect(payload.reload).toEqual({ state: "ready", stale: false })
    }
  })

  test("validates a replacement before swapping, retains stale data, and recovers after deletion", async () => {
    const initial = fixture()
    write(initial)
    await connect()
    const first = await call<ComponentShortlist>("find_components", { limit: 1 })
    // Valid top-level JSON with malformed eager leaf must not replace any loaded facts.
    write({
      ...initial,
      components: { "ui/Broken": { name: "Broken", source: { adapter: "codebase" }, description: 3 } }
    })
    const stale = await waitForReload("reload-failed")
    expect(stale.snapshotId).toBe(first.snapshotId)
    expect(stale.reload.stale).toBe(true)
    expect(stale.total).toBe(2)
    const continued = await call<ComponentShortlist>("find_components", { limit: 1, cursor: first.nextCursor })
    expect(continued.items[0].id).toBe("ui/Legacy")
    const legacy = await client.callTool({ name: "get_component", arguments: { name: "Button" } })
    expect(legacy.isError).toBeUndefined()
    fs.unlinkSync(contractPath)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect((await call<ComponentCatalog>("get_component_catalog")).reload.stale).toBe(true)
    const next = fixture()
    next.components["ui/Button"].rationale = { when: "Changed guidance" }
    write(next)
    const recovered = await waitForReload("ready", first.snapshotId)
    expect(recovered.reload.stale).toBe(false)
    expect((await call<ErrorPayload>("find_components", { limit: 1, cursor: first.nextCursor })).error.code).toBe(
      "snapshot-changed"
    )
    expect(
      (await call<ErrorPayload>("get_component_context", { id: "ui/Button", snapshotId: first.snapshotId })).error.code
    ).toBe("snapshot-changed")
  })

  test.each(["missing", "malformed"])("initial %s load has no snapshot and creation recovers it", async (mode) => {
    if (mode === "malformed") fs.writeFileSync(contractPath, "{invalid")
    await connect()
    const initial = await call<ErrorPayload>("get_component_catalog")
    expect(initial.snapshotId).toBeNull()
    expect(initial.reload).toEqual({ state: "reload-failed", stale: false })
    expect(initial.error.code).toBe("contract-unavailable")
    write(fixture())
    const ready = await waitForReload("ready")
    expect(ready.snapshotId).toStartWith("discovery-v1:")
    expect(ready.total).toBe(2)
  })

  test("watcher errors retain stale data and polling recovers replacement/deletion/restoration", async () => {
    write(fixture())
    await connect()
    const initial = await call<ComponentCatalog>("get_component_catalog")
    const watcher = (server as unknown as { watcher: fs.FSWatcher }).watcher
    watcher.emit("error", new Error("Watcher unavailable"))
    const stale = await call<ComponentCatalog>("get_component_catalog")
    expect(stale.snapshotId).toBe(initial.snapshotId)
    expect(stale.reload).toEqual({ state: "reload-failed", stale: true })
    const replacement = fixture()
    replacement.components["ui/Button"].description = "Valid replacement"
    write(replacement)
    const recovered = await waitForReload("ready", initial.snapshotId)
    expect(recovered.reload.stale).toBe(false)
    fs.unlinkSync(contractPath)
    const deleted = await waitForReload("reload-failed")
    expect(deleted.snapshotId).toBe(recovered.snapshotId)
    write(fixture())
    const restored = await waitForReload("ready", recovered.snapshotId)
    expect(restored.snapshotId).toBe(initial.snapshotId)
  })

  test("rederives imported indexes and validates optional evidence only when requested", async () => {
    const contract = fixture()
    contract.componentNameIndex = { fabricated: ["not-there"] }
    contract.components["ui/Button"].props = {
      label: { required: "sometimes" }
    } as unknown as (typeof contract.components)[string]["props"]
    write(contract)
    await connect()
    const catalog = await call<ComponentCatalog>("get_component_catalog")
    const guidance = await call<ComponentContext>("get_component_context", {
      id: "ui/Button",
      snapshotId: catalog.snapshotId,
      sections: ["guidance"]
    })
    expect(guidance.complete).toBe(true)
    expect(
      (
        await call<ErrorPayload>("get_component_context", {
          id: "ui/Button",
          snapshotId: catalog.snapshotId,
          sections: ["api"]
        })
      ).error.code
    ).toBe("invalid-record")
    const legacy = await client.callTool({ name: "get_component", arguments: { name: "Button" } })
    expect(legacy.isError).toBeUndefined()
  })
})
