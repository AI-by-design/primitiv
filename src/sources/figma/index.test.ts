import { describe, expect, test } from "bun:test"
import { FigmaAdapter } from "./index"

describe("FigmaAdapter — durable identity capture", () => {
  test("a variable's publish-stable key and publish visibility land in token source metadata", async () => {
    // The ephemeral variableId alone cannot survive Figma's id regeneration — the
    // publish-stable key is what future cross-scan matching (rename vs remove) relies on.
    // Contracts are snapshots: a scan that fails to capture the key can't be retrofitted.
    const variablesResponse = {
      meta: {
        variables: {
          "VariableID:1:2": {
            id: "VariableID:1:2",
            name: "colors/primary/500",
            key: "durable-key-abc123",
            resolvedType: "COLOR",
            variableCollectionId: "VariableCollectionId:1:1",
            hiddenFromPublishing: true,
            valuesByMode: { "1:0": { r: 1, g: 0, b: 0, a: 1 } }
          }
        },
        variableCollections: {
          "VariableCollectionId:1:1": { name: "Primitives", defaultModeId: "1:0" }
        }
      }
    }
    const server = Bun.serve({
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname.endsWith("/variables/local")
          ? Response.json(variablesResponse)
          : Response.json({ meta: { components: [] } })
    })
    try {
      const adapter = new FigmaAdapter({ token: "test-token", fileId: "file123" })
      ;(adapter as unknown as { baseUrl: string }).baseUrl = `http://localhost:${server.port}`

      const { tokens } = await adapter.scan()
      const token = tokens.colors?.["colors-primary-500"]
      expect(token?.source.metadata).toMatchObject({
        variableId: "VariableID:1:2",
        variableKey: "durable-key-abc123",
        hiddenFromPublishing: true
      })
    } finally {
      server.stop(true)
    }
  })
})

describe("FigmaAdapter — error sanitization", () => {
  test("an API error message carries the status but never the response body", async () => {
    // The thrown message ends up persisted in the contract's sourceStatuses, which gets
    // committed and fed to LLMs — a leaked response body (or echoed token) is a security
    // bug, not a formatting choice.
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("SECRET-BODY-DO-NOT-PERSIST", { status: 403, statusText: "Forbidden" })
    })
    try {
      const adapter = new FigmaAdapter({ token: "test-token", fileId: "file123" })
      // baseUrl is a compile-time-private implementation field; overriding it is the only
      // way to point the adapter at a stub without adding config surface just for tests.
      ;(adapter as unknown as { baseUrl: string }).baseUrl = `http://localhost:${server.port}`

      let message = ""
      try {
        await adapter.scan()
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).toContain("403")
      expect(message).not.toContain("SECRET-BODY-DO-NOT-PERSIST")
    } finally {
      server.stop(true)
    }
  })
})
