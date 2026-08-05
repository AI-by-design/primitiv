import { describe, expect, test } from "bun:test"
import { StorybookAdapter } from "./index"

describe("StorybookAdapter — manifest request handling", () => {
  test("bounds each manifest endpoint and exposes a sanitised failure", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; signal?: AbortSignal | null }> = []
    const adapter = new StorybookAdapter({ url: "https://storybook.example.test" })
    ;(adapter as unknown as { requestTimeoutMs: number }).requestTimeoutMs = 10

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      requests.push({ url, signal: init?.signal })
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
      })
    }) as typeof fetch

    try {
      await expect(adapter.scan()).rejects.toThrow("Could not reach Storybook within 10ms")
      expect(requests.map((request) => request.url)).toEqual([
        "https://storybook.example.test/index.json",
        "https://storybook.example.test/stories.json"
      ])
      expect(requests.every((request) => request.signal?.aborted)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
