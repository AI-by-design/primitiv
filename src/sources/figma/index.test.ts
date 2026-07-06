import { describe, expect, test } from "bun:test"
import { FigmaAdapter } from "./index"

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
