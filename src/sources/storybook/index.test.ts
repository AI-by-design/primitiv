import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { StorybookAdapter } from "./index"
import { MAX_MANIFEST_BYTES, MAX_METADATA_STRING_BYTES, MAX_STORIES_PER_COMPONENT } from "./limits"

async function scanManifest(
  manifest: unknown,
  config: { sourceRoot?: string } = {}
): Promise<Awaited<ReturnType<StorybookAdapter["scan"]>>> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => Response.json(manifest)) as typeof fetch
  try {
    return await new StorybookAdapter({ url: "https://storybook.example.test", ...config }).scan()
  } finally {
    globalThis.fetch = originalFetch
  }
}

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

  test("falls back independently when the modern manifest is malformed or oversized", async () => {
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    const legacy = {
      stories: {
        primary: {
          id: "admin-button--primary",
          title: "Admin/Button",
          name: "Primary",
          importPath: "./Button.stories.tsx"
        }
      }
    }
    let modernAttempt = 0
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      requests.push(url)
      if (url.endsWith("/stories.json")) return Response.json(legacy)
      modernAttempt++
      if (modernAttempt === 1) return new Response("{not-json")
      return new Response("{}", { headers: { "content-length": String(MAX_MANIFEST_BYTES + 1) } })
    }) as typeof fetch

    try {
      const adapter = new StorybookAdapter({ url: "https://storybook.example.test" })
      expect(Object.keys((await adapter.scan()).components)).toEqual(["storybook:Admin/Button"])
      expect(Object.keys((await adapter.scan()).components)).toEqual(["storybook:Admin/Button"])
      expect(requests).toEqual([
        "https://storybook.example.test/index.json",
        "https://storybook.example.test/stories.json",
        "https://storybook.example.test/index.json",
        "https://storybook.example.test/stories.json"
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("falls back from a non-OK modern endpoint", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith("/index.json")) return new Response("private upstream detail", { status: 503 })
      return Response.json({
        stories: {
          primary: { id: "button--primary", title: "Button", name: "Primary" }
        }
      })
    }) as typeof fetch

    try {
      const result = await new StorybookAdapter({ url: "https://storybook.example.test" }).scan()
      expect(Object.keys(result.components)).toEqual(["storybook:Button"])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("bounds streamed bytes even without Content-Length and keeps the final error sanitised", async () => {
    const originalFetch = globalThis.fetch
    const secret = "https://user:password@storybook.example.test/private"
    globalThis.fetch = (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_MANIFEST_BYTES))
          controller.enqueue(new Uint8Array(1))
          controller.close()
        }
      })
      return new Response(body)
    }) as typeof fetch

    try {
      const adapter = new StorybookAdapter({ url: secret })
      let message = ""
      try {
        await adapter.scan()
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expect(message).toContain("Could not reach Storybook")
      expect(message).not.toContain(secret)
      expect(message).not.toContain("password")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe("StorybookAdapter — component identity", () => {
  test("keeps equal leaf names distinct and emits deterministic manifest-only story evidence", async () => {
    const entries = {
      storefront: {
        type: "story",
        id: "storefront-button--primary",
        title: "Storefront/Button",
        name: "Primary",
        importPath: "./StorefrontButton.stories.tsx"
      },
      adminSecondary: {
        type: "story",
        id: "admin-button--secondary",
        title: "Admin/Button",
        name: "Secondary",
        importPath: "./AdminButton.stories.tsx"
      },
      docs: { type: "docs", id: "admin-button--docs", title: "Admin/Button", name: "Docs" },
      adminPrimary: {
        type: "story",
        id: "admin-button--primary",
        title: "Admin/Button",
        name: "Primary",
        importPath: "./AdminButton.stories.tsx"
      }
    }
    const forward = await scanManifest({ entries })
    const reverse = await scanManifest({ entries: Object.fromEntries(Object.entries(entries).reverse()) })

    expect(forward.components).toEqual(reverse.components)
    expect(Object.keys(forward.components)).toEqual(["storybook:Admin/Button", "storybook:Storefront/Button"])
    const admin = forward.components["storybook:Admin/Button"]
    expect(admin.name).toBe("Button")
    expect(admin.displayName).toBe("Button")
    expect("variants" in admin).toBe(false)
    expect(admin.demonstrated).toEqual({
      title: "Admin/Button",
      extraction: "manifest-only",
      storyCount: 2,
      stories: [
        {
          id: "admin-button--primary",
          name: "Primary",
          importPath: "./AdminButton.stories.tsx"
        },
        {
          id: "admin-button--secondary",
          name: "Secondary",
          importPath: "./AdminButton.stories.tsx"
        }
      ]
    })
    expect(admin.source).toEqual({
      adapter: "storybook",
      file: "./AdminButton.stories.tsx",
      metadata: {
        storyIds: ["admin-button--primary", "admin-button--secondary"],
        title: "Admin/Button"
      }
    })
  })

  test("deduplicates and caps stories in canonical id order", async () => {
    const stories = Array.from({ length: MAX_STORIES_PER_COMPONENT + 2 }, (_, index) => ({
      type: "story",
      id: `catalog-grid--story-${String(index).padStart(3, "0")}`,
      title: "Catalog/Grid",
      name: `Story ${index}`,
      importPath: "./Grid.stories.tsx"
    }))
    const entries = Object.fromEntries(
      [...stories.reverse(), { ...stories[0], name: "Duplicate" }].map((story, index) => [`entry-${index}`, story])
    )
    const { components } = await scanManifest({ entries })
    const grid = components["storybook:Catalog/Grid"]

    expect(grid.demonstrated?.storyCount).toBe(MAX_STORIES_PER_COMPONENT + 2)
    expect(grid.demonstrated?.stories).toHaveLength(MAX_STORIES_PER_COMPONENT)
    expect(grid.demonstrated?.truncatedStories).toBe(true)
    expect(grid.demonstrated?.stories?.map((story) => story.id)).toEqual(
      [...(grid.demonstrated?.stories ?? [])].map((story) => story.id).sort()
    )
    expect(grid.source.metadata?.storyIds).toEqual(grid.demonstrated?.stories?.map((story) => story.id))
  })

  test("keeps prototype-like manifest keys inert", async () => {
    const manifest = JSON.parse(`{
      "entries": {
        "__proto__": {
          "type": "story",
          "id": "prototype--safe",
          "title": "__proto__",
          "name": "Safe",
          "importPath": "./Safe.stories.ts"
        },
        "constructor": null,
        "prototype": []
      }
    }`)
    const { components } = await scanManifest(manifest)

    expect(Object.getPrototypeOf(components)).toBeNull()
    expect(components["storybook:__proto__"].demonstrated?.stories?.[0]?.id).toBe("prototype--safe")
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  test("bounds every retained manifest string and omits malformed entries", async () => {
    const exactId = "i".repeat(MAX_METADATA_STRING_BYTES)
    const { components } = await scanManifest({
      entries: {
        exact: {
          type: "story",
          id: exactId,
          title: "Safe",
          name: "n".repeat(MAX_METADATA_STRING_BYTES + 1),
          importPath: `${"p".repeat(MAX_METADATA_STRING_BYTES)}.ts`
        },
        longId: { type: "story", id: "i".repeat(MAX_METADATA_STRING_BYTES + 1), title: "Skipped" },
        longTitle: {
          type: "story",
          id: "skipped--title",
          title: "t".repeat(MAX_METADATA_STRING_BYTES + 1)
        },
        badType: { type: 42, id: "skipped--type", title: "Skipped" },
        notAnEntry: "story"
      }
    })

    expect(Object.keys(components)).toEqual(["storybook:Safe"])
    expect(components["storybook:Safe"].demonstrated?.stories).toEqual([{ id: exactId }])
    expect(components["storybook:Safe"].source.file).toBeUndefined()
  })
})

describe("StorybookAdapter — source extraction", () => {
  test("reads a valid in-root story through the bounded resolver", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-storybook-index-"))
    try {
      fs.writeFileSync(
        path.join(root, "Button.stories.tsx"),
        `export default { argTypes: { disabled: { control: "boolean", required: true } } }`
      )
      const { components } = await scanManifest(
        {
          entries: {
            primary: {
              type: "story",
              id: "admin-button--primary",
              title: "Admin/Button",
              name: "Primary",
              importPath: "./Button.stories.tsx"
            }
          }
        },
        { sourceRoot: root }
      )

      const button = components["storybook:Admin/Button"]
      expect(button.props).toEqual({ disabled: { required: true } })
      expect(button.demonstrated?.extraction).toBe("source")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("joins manifest stories to source exports by exact ID and retains scoped evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-storybook-evidence-"))
    try {
      fs.writeFileSync(
        path.join(root, "Button.stories.tsx"),
        `const defaults = { label: "Button", dynamic: getDefault() }
         export default {
           id: "custom-button",
           args: defaults,
           argTypes: {
             tone: {
               type: { name: "enum", value: ["primary", "secondary"], required: true },
               control: "radio",
               options: ["secondary", "primary"],
               mapping: { primary: "brand", secondary: getTone() }
             },
             controlOnly: { control: false }
           },
           parameters: { addon: { argTypes: { invented: { type: "string" } } } }
         }
         export const Primary = { name: "Source Primary", args: { tone: "primary", count: 1 } }
         export const Secondary = {
           __id: "button-special",
           args: { tone: chooseTone(), count: 2 },
           argTypes: { tone: { control: "select", options: ["secondary"] } }
         }
         export const Helper = { args: { shouldNotAppear: true } }
        `
      )
      const { components } = await scanManifest(
        {
          entries: {
            secondary: {
              type: "story",
              id: "button-special",
              title: "Admin/Button",
              importPath: "./Button.stories.tsx"
            },
            mismatch: {
              type: "story",
              id: "custom-button--missing",
              title: "Admin/Button",
              name: "Manifest mismatch",
              importPath: "./Button.stories.tsx"
            },
            primary: {
              type: "story",
              id: "custom-button--primary",
              title: "Admin/Button",
              name: "Manifest Primary",
              importPath: "./Button.stories.tsx"
            }
          }
        },
        { sourceRoot: root }
      )

      const button = components["storybook:Admin/Button"]
      expect(button.props).toEqual({
        tone: { type: "enum", required: true, values: ["primary", "secondary"] }
      })
      expect(button.demonstrated).toEqual({
        title: "Admin/Button",
        extraction: "source",
        storyCount: 3,
        defaultArgs: { label: "Button" },
        unresolvedDefaultArgs: ["dynamic"],
        controls: {
          controlOnly: { control: false },
          tone: {
            control: "radio",
            choices: [
              { option: "primary", mappedValue: "brand" },
              { option: "secondary", mappingUnresolved: true }
            ]
          }
        },
        stories: [
          {
            id: "button-special",
            exportName: "Secondary",
            importPath: "./Button.stories.tsx",
            args: { count: 2 },
            unresolvedArgs: ["tone"],
            controls: { tone: { control: "select", choices: [{ option: "secondary" }] } }
          },
          {
            id: "custom-button--missing",
            name: "Manifest mismatch",
            importPath: "./Button.stories.tsx"
          },
          {
            id: "custom-button--primary",
            name: "Manifest Primary",
            exportName: "Primary",
            importPath: "./Button.stories.tsx",
            args: { count: 1, tone: "primary" }
          }
        ]
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("keeps per-file story evidence but omits ambiguous component-wide meta evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-storybook-multifile-"))
    try {
      fs.writeFileSync(
        path.join(root, "One.stories.ts"),
        `export default { args: { fromOne: true } }; export const One = { args: { value: 1 } }`
      )
      fs.writeFileSync(
        path.join(root, "Two.stories.ts"),
        `export default { args: { fromTwo: true } }; export const Two = { args: { value: 2 } }`
      )
      const { components } = await scanManifest(
        {
          entries: {
            one: { id: "shared--one", title: "Shared", importPath: "./One.stories.ts" },
            two: { id: "shared--two", title: "Shared", importPath: "./Two.stories.ts" }
          }
        },
        { sourceRoot: root }
      )

      const shared = components["storybook:Shared"]
      expect(shared.source.file).toBeUndefined()
      expect(shared.props).toEqual({})
      expect(shared.demonstrated?.defaultArgs).toBeUndefined()
      expect(shared.demonstrated?.stories).toEqual([
        { id: "shared--one", exportName: "One", importPath: "./One.stories.ts", args: { value: 1 } },
        { id: "shared--two", exportName: "Two", importPath: "./Two.stories.ts", args: { value: 2 } }
      ])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("does not let the retained-story cap hide a second source file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-storybook-retained-cap-files-"))
    try {
      fs.writeFileSync(path.join(root, "One.stories.ts"), `export default { args: { fromOne: true } }`)
      fs.writeFileSync(path.join(root, "Two.stories.ts"), `export default { args: { fromTwo: true } }`)
      const stories = Array.from({ length: MAX_STORIES_PER_COMPONENT }, (_, index) => ({
        id: `shared--a-${String(index).padStart(2, "0")}`,
        title: "Shared",
        importPath: "./One.stories.ts"
      }))
      stories.push({ id: "shared--z-overflow", title: "Shared", importPath: "./Two.stories.ts" })

      const { components } = await scanManifest(
        { entries: Object.fromEntries(stories.map((story) => [story.id, story])) },
        { sourceRoot: root }
      )
      const shared = components["storybook:Shared"]

      expect(shared.source.file).toBe("./One.stories.ts")
      expect(shared.props).toEqual({})
      expect(shared.demonstrated?.storyCount).toBe(MAX_STORIES_PER_COMPONENT + 1)
      expect(shared.demonstrated?.stories).toHaveLength(MAX_STORIES_PER_COMPONENT)
      expect(shared.demonstrated?.defaultArgs).toBeUndefined()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("parses one canonical file once across equivalent manifest paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-storybook-canonical-cache-"))
    try {
      fs.mkdirSync(path.join(root, "stories"))
      fs.writeFileSync(
        path.join(root, "stories", "Shared.stories.ts"),
        `export default { args: { shared: true } };
         export const One = { args: { value: 1 } };
         export const Two = { args: { value: 2 } }`
      )
      const { components } = await scanManifest(
        {
          entries: {
            one: { id: "shared--one", title: "Shared", importPath: "./stories/Shared.stories.ts" },
            two: { id: "shared--two", title: "Shared", importPath: "stories/Shared.stories.ts" }
          }
        },
        { sourceRoot: root }
      )

      const shared = components["storybook:Shared"]
      expect(shared.source.file).toBeUndefined()
      expect(shared.demonstrated?.defaultArgs).toEqual({ shared: true })
      expect(shared.demonstrated?.stories?.map((story) => story.exportName)).toEqual(["One", "Two"])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test("degrades a source parse error to manifest-only evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-storybook-parse-error-"))
    try {
      fs.writeFileSync(path.join(root, "Broken.stories.ts"), "export default { args: {")
      const { components } = await scanManifest(
        {
          entries: {
            primary: { id: "broken--primary", title: "Broken", importPath: "./Broken.stories.ts" }
          }
        },
        { sourceRoot: root }
      )
      expect(components["storybook:Broken"].demonstrated).toEqual({
        title: "Broken",
        extraction: "manifest-only",
        storyCount: 1,
        stories: [{ id: "broken--primary", importPath: "./Broken.stories.ts" }]
      })
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
