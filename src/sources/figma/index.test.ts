import { describe, expect, test } from "bun:test"
import { FigmaAdapter } from "./index"

function adapterWithTimeout(timeoutMs: number): FigmaAdapter {
  const adapter = new FigmaAdapter({ token: "test-token", fileId: "file123" })
  ;(adapter as unknown as { requestTimeoutMs: number }).requestTimeoutMs = timeoutMs
  return adapter
}

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
      fetch: (req) => {
        const pathname = new URL(req.url).pathname
        if (pathname.endsWith("/variables/local")) return Response.json(variablesResponse)
        if (pathname.endsWith("/component_sets")) return Response.json({ meta: { component_sets: [] } })
        return Response.json({ meta: { components: [] } })
      }
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
  test("a 403 names the required read scopes but never includes the response body", async () => {
    // The thrown message ends up persisted in the contract's sourceStatuses, which gets
    // committed and fed to LLMs — a leaked response body (or echoed token) is a security
    // bug, not a formatting choice.
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("SECRET-BODY-DO-NOT-PERSIST", { status: 403, statusText: "Forbidden" })) as typeof fetch
    try {
      const adapter = new FigmaAdapter({ token: "test-token", fileId: "file123" })
      let message = ""
      try {
        await adapter.scan()
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).toContain("403")
      expect(message).toContain("library_content:read")
      expect(message).toContain("file_content:read")
      expect(message).not.toContain("SECRET-BODY-DO-NOT-PERSIST")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("a 429 preserves only valid Retry-After guidance", async () => {
    const originalFetch = globalThis.fetch
    try {
      for (const [header, expected] of [
        ["120", "Retry after 120 seconds."],
        ["Thu, 27 Aug 2026 12:00:00 GMT", "Retry after Thu, 27 Aug 2026 12:00:00 GMT."],
        ["Thu, 31 Feb 2026 12:00:00 GMT", "Wait before trying again."],
        ["server-secret", "Wait before trying again."]
      ] as const) {
        globalThis.fetch = (async () =>
          new Response("SECRET-BODY-DO-NOT-PERSIST", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Retry-After": header }
          })) as typeof fetch
        let message = ""
        try {
          await new FigmaAdapter({ token: "test-token", fileId: "file123" }).scan()
        } catch (err) {
          message = err instanceof Error ? err.message : String(err)
        }
        expect(message).toContain(expected)
        expect(message).not.toContain("SECRET-BODY-DO-NOT-PERSIST")
        if (expected === "Wait before trying again.") expect(message).not.toContain(header)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("a 404 explains that published-library discovery requires the main-file key", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("SECRET-BODY-DO-NOT-PERSIST", { status: 404, statusText: "Not Found" })) as typeof fetch
    try {
      let message = ""
      try {
        await new FigmaAdapter({ token: "test-token", fileId: "branch-key" }).scan()
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
      }
      expect(message).toContain("published main-file key")
      expect(message).toContain("branch keys")
      expect(message).not.toContain("SECRET-BODY-DO-NOT-PERSIST")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("FigmaAdapter — FLOAT and request handling", () => {
  test("preserves FLOAT values as unitless numbers", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/variables/local")) {
        return Response.json({
          meta: {
            variables: {
              opacity: {
                id: "opacity",
                name: "opacity/disabled",
                resolvedType: "FLOAT",
                variableCollectionId: "collection",
                valuesByMode: { default: 0.4 }
              },
              weight: {
                id: "weight",
                name: "font/weight/semibold",
                resolvedType: "FLOAT",
                variableCollectionId: "collection",
                valuesByMode: { default: 600 }
              },
              spacing: {
                id: "spacing",
                name: "spacing/md",
                resolvedType: "FLOAT",
                variableCollectionId: "collection",
                valuesByMode: { default: 16 }
              }
            },
            variableCollections: { collection: { defaultModeId: "default" } }
          }
        })
      }
      if (url.endsWith("/component_sets")) return Response.json({ meta: { component_sets: [] } })
      return Response.json({ meta: { components: [] } })
    }) as typeof fetch

    try {
      const { tokens } = await new FigmaAdapter({ token: "test-token", fileId: "file123" }).scan()
      expect(tokens.spacing["opacity-disabled"]?.value).toBe("0.4")
      expect(tokens.typography["font-weight-semibold"]?.value).toBe("600")
      expect(tokens.spacing["spacing-md"]?.value).toBe("16")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("times out all concurrently requested Figma endpoints with a sanitised error", async () => {
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; signal?: AbortSignal | null }> = []
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString()
      requests.push({ url, signal: init?.signal })
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
      })
    }) as typeof fetch

    try {
      await expect(adapterWithTimeout(10).scan()).rejects.toThrow(
        "Figma API request timed out after 10ms. Check your network connection and try again."
      )
      // Promise.all rejects as soon as the first endpoint times out; give the concurrently
      // started requests their own timeout turn before asserting every signal fired.
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      expect(requests.map((request) => request.url)).toEqual(
        expect.arrayContaining([
          "https://api.figma.com/v1/files/file123/variables/local",
          "https://api.figma.com/v1/files/file123/components",
          "https://api.figma.com/v1/files/file123/component_sets"
        ])
      )
      expect(requests).toHaveLength(3)
      expect(requests.every((request) => request.signal?.aborted)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("FigmaAdapter — theme modes", () => {
  test("extracts each named non-default Figma mode with its own provenance", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/variables/local")) {
        return Response.json({
          meta: {
            variables: {
              brand: {
                id: "brand",
                name: "color/brand",
                resolvedType: "COLOR",
                variableCollectionId: "collection",
                valuesByMode: {
                  light: { r: 1, g: 1, b: 1, a: 1 },
                  dark: { r: 0, g: 0, b: 0, a: 1 },
                  night: { r: 0.1, g: 0.1, b: 0.1, a: 1 }
                }
              }
            },
            variableCollections: {
              collection: {
                defaultModeId: "light",
                modes: [
                  { modeId: "light", name: "Light" },
                  { modeId: "dark", name: "Dark" },
                  { modeId: "night", name: "Night" }
                ]
              }
            }
          }
        })
      }
      if (url.endsWith("/component_sets")) return Response.json({ meta: { component_sets: [] } })
      return Response.json({ meta: { components: [] } })
    }) as typeof fetch

    try {
      const { tokens } = await new FigmaAdapter({ token: "test-token", fileId: "file123" }).scan()
      const token = tokens.colors["color-brand"]
      expect(token?.value).toBe("#ffffff")
      // "Night" is not guessed to mean "dark"; it remains its own lexical mode key.
      expect(token?.modes).toEqual({ dark: "#000000", night: "#1a1a1a" })
      expect(token?.modeSources?.dark?.metadata).toMatchObject({ modeId: "dark", modeName: "Dark" })
      expect(token?.modeSources?.night?.metadata).toMatchObject({ modeId: "night", modeName: "Night" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("uses only explicit stable-key mappings for units, tokens, and modes", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/variables/local")) {
        return Response.json({
          meta: {
            variables: {
              spacing: {
                id: "spacing",
                key: "stable-spacing-key",
                name: "legacy/space",
                resolvedType: "FLOAT",
                variableCollectionId: "collection",
                valuesByMode: { light: 8, night: 12 }
              },
              brand: {
                id: "brand",
                key: "stable-brand-key",
                name: "legacy/brand",
                resolvedType: "COLOR",
                variableCollectionId: "collection",
                valuesByMode: {
                  light: { r: 1, g: 1, b: 1, a: 1 },
                  night: { r: 0, g: 0, b: 0, a: 1 }
                }
              }
            },
            variableCollections: {
              collection: {
                defaultModeId: "light",
                modes: [
                  { modeId: "light", name: "Light" },
                  { modeId: "night", name: "Night" }
                ]
              }
            }
          }
        })
      }
      if (url.endsWith("/component_sets")) return Response.json({ meta: { component_sets: [] } })
      return Response.json({ meta: { components: [] } })
    }) as typeof fetch

    try {
      const { tokens } = await new FigmaAdapter({
        token: "test-token",
        fileId: "file123",
        numericUnits: { "stable-spacing-key": "px" },
        tokenAliases: { "stable-brand-key": "color/brand-primary" },
        modeAliases: { night: "dark" }
      }).scan()

      const spacing = tokens.spacing["legacy-space"]
      expect(spacing?.value).toBe("8px")
      expect(spacing?.modes).toEqual({ dark: "12px" })

      const brand = tokens.colors["color-brand-primary"]
      expect(brand?.value).toBe("#ffffff")
      expect(brand?.modes).toEqual({ dark: "#000000" })
      // Aliasing the display key does not discard Figma's original provenance.
      expect(brand?.modeSources?.dark?.metadata).toMatchObject({ modeId: "night", modeName: "Night" })
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("FigmaAdapter — explicit mapping safety", () => {
  function mockFigmaVariables(variables: object, variableCollections: object): () => void {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/variables/local")) return Response.json({ meta: { variables, variableCollections } })
      if (url.endsWith("/component_sets")) return Response.json({ meta: { component_sets: [] } })
      return Response.json({ meta: { components: [] } })
    }) as typeof fetch
    return () => {
      globalThis.fetch = originalFetch
    }
  }

  test("fails instead of silently overwriting tokens whose aliases collide", async () => {
    const restore = mockFigmaVariables(
      {
        first: {
          id: "first",
          key: "KEY_A",
          name: "color/first",
          resolvedType: "COLOR",
          variableCollectionId: "collection",
          valuesByMode: { default: { r: 1, g: 0, b: 0, a: 1 } }
        },
        second: {
          id: "second",
          key: "KEY_B",
          name: "color/second",
          resolvedType: "COLOR",
          variableCollectionId: "collection",
          valuesByMode: { default: { r: 0, g: 0, b: 1, a: 1 } }
        }
      },
      { collection: { defaultModeId: "default" } }
    )

    try {
      await expect(
        new FigmaAdapter({
          token: "test-token",
          fileId: "file123",
          tokenAliases: { KEY_A: "colors/shared", KEY_B: "colors/shared" }
        }).scan()
      ).rejects.toThrow("Figma token mapping collision")
    } finally {
      restore()
    }
  })

  test("fails instead of dropping mode values whose aliases collide", async () => {
    const restore = mockFigmaVariables(
      {
        brand: {
          id: "brand",
          key: "KEY_A",
          name: "color/brand",
          resolvedType: "COLOR",
          variableCollectionId: "collection",
          valuesByMode: {
            light: { r: 1, g: 1, b: 1, a: 1 },
            night: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
            midnight: { r: 0, g: 0, b: 0, a: 1 }
          }
        }
      },
      {
        collection: {
          defaultModeId: "light",
          modes: [
            { modeId: "light", name: "Light" },
            { modeId: "night", name: "Night" },
            { modeId: "midnight", name: "Midnight" }
          ]
        }
      }
    )

    try {
      await expect(
        new FigmaAdapter({
          token: "test-token",
          fileId: "file123",
          modeAliases: { night: "dark", midnight: "dark" }
        }).scan()
      ).rejects.toThrow("Figma mode mapping collision")
    } finally {
      restore()
    }
  })

  test("does not treat an empty numeric-unit key as a wildcard for keyless variables", async () => {
    const restore = mockFigmaVariables(
      {
        spacing: {
          id: "spacing",
          name: "spacing/md",
          resolvedType: "FLOAT",
          variableCollectionId: "collection",
          valuesByMode: { default: 16 }
        }
      },
      { collection: { defaultModeId: "default" } }
    )

    try {
      const { tokens } = await new FigmaAdapter({
        token: "test-token",
        fileId: "file123",
        numericUnits: { "": "px" }
      }).scan()
      expect(tokens.spacing["spacing-md"]?.value).toBe("16")
    } finally {
      restore()
    }
  })
})

describe("FigmaAdapter — published component evidence", () => {
  test("assembles component sets and standalone components from targeted nodes", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname.endsWith("/variables/local")) {
        return Response.json({ meta: { variables: {}, variableCollections: {} } })
      }
      if (url.pathname.endsWith("/components")) {
        return Response.json({
          meta: {
            components: [
              { key: "child-key", node_id: "2:2", name: "Button, Size=Small", file_key: "file123" },
              { key: "standalone-key", node_id: "3:3", name: "Icon", file_key: "file123" }
            ]
          }
        })
      }
      if (url.pathname.endsWith("/component_sets")) {
        return Response.json({
          meta: {
            component_sets: [
              {
                key: "set-key",
                node_id: "2:1",
                name: "Button",
                description: "A button",
                updated_at: "2026-08-26T00:00:00Z",
                file_key: "file123"
              }
            ]
          }
        })
      }
      return Response.json({
        name: "Test file",
        version: "snapshot-1",
        lastModified: "2026-08-26T01:00:00Z",
        nodes: {
          "2:1": {
            document: {
              id: "2:1",
              type: "COMPONENT_SET",
              componentPropertyDefinitions: {
                Size: { type: "VARIANT", variantOptions: ["Large", "Small", "Small"], defaultValue: "Small" },
                Disabled: { type: "BOOLEAN", defaultValue: false },
                Label: { type: "TEXT", defaultValue: "Continue" },
                Swap: {
                  type: "INSTANCE_SWAP",
                  defaultValue: "3:3",
                  preferredValues: [
                    { type: "COMPONENT", key: "standalone-key" },
                    { type: "COMPONENT_SET", key: "set-key" },
                    { type: "COMPONENT", key: "standalone-key" }
                  ]
                },
                Unsupported: { type: "FUTURE_TYPE", defaultValue: "ignored" }
              }
            }
          },
          "2:2": {
            document: { id: "2:2", type: "COMPONENT", children: [{ id: "visual-tree" }] },
            components: { "2:2": { key: "child-key", componentSetId: "2:1" } }
          },
          "3:3": {
            document: { id: "3:3", type: "COMPONENT", fills: [{ type: "SOLID" }] },
            components: { "3:3": { key: "standalone-key" } }
          }
        }
      })
    }) as typeof fetch

    try {
      const result = await new FigmaAdapter({ token: "test-token", fileId: "file123" }).scan()
      expect(Object.keys(result.components)).toEqual(["figma:set-key", "figma:standalone-key"])
      expect(result.components["figma:child-key"]).toBeUndefined()
      expect(result.components["figma:set-key"]).toMatchObject({
        name: "Button",
        description: "A button",
        props: {
          Size: { kind: "variant", values: ["Large", "Small"], default: "Small" },
          Disabled: { type: "boolean", kind: "boolean", default: "false" },
          Label: { type: "string", kind: "text", default: "Continue" },
          Swap: {
            kind: "instance-swap",
            default: "standalone-key",
            preferredValues: [
              { type: "component", key: "standalone-key" },
              { type: "component-set", key: "set-key" }
            ]
          }
        },
        source: {
          metadata: {
            assetType: "component-set",
            assetKey: "set-key",
            nodeId: "2:1",
            fileKey: "file123",
            fileName: "Test file",
            fileVersion: "snapshot-1",
            fileLastModified: "2026-08-26T01:00:00Z",
            publishedUpdatedAt: "2026-08-26T00:00:00Z"
          }
        }
      })
      expect(JSON.stringify(result.components)).not.toContain("visual-tree")
      expect(JSON.stringify(result.components)).not.toContain("SOLID")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("fails when a successful node response omits required published evidence", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      if (url.pathname.endsWith("/variables/local")) {
        return Response.json({ meta: { variables: {}, variableCollections: {} } })
      }
      if (url.pathname.endsWith("/components")) {
        return Response.json({
          meta: {
            components: [{ key: "missing-key", node_id: "9:9", name: "Missing", file_key: "file123" }]
          }
        })
      }
      if (url.pathname.endsWith("/component_sets")) {
        return Response.json({ meta: { component_sets: [] } })
      }
      return Response.json({ version: "snapshot-1", nodes: { "9:9": null } })
    }) as typeof fetch

    try {
      await expect(new FigmaAdapter({ token: "test-token", fileId: "file123" }).scan()).rejects.toThrow(
        /missing targeted node evidence/i
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
