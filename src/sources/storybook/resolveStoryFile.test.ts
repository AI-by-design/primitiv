import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  MAX_CONTROL_CHOICES,
  MAX_DEMONSTRATED_BYTES_PER_COMPONENT,
  MAX_MANIFEST_BYTES,
  MAX_METADATA_STRING_BYTES,
  MAX_OMISSION_MARKER_NAMES,
  MAX_SERIALIZED_VALUE_BYTES,
  MAX_SOURCE_BYTES,
  MAX_STATIC_BINDING_DEPTH,
  MAX_STATIC_COLLECTION_ENTRIES,
  MAX_STATIC_RECURSION_DEPTH,
  MAX_STORIES_PER_COMPONENT
} from "./limits"
import { readStoryFile, resolveStoryFile } from "./resolveStoryFile"

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-storybook-"))
  temporaryRoots.push(root)
  return root
}

describe("Storybook input limits", () => {
  test("exports the Storybook input and evidence caps", () => {
    expect(MAX_MANIFEST_BYTES).toBe(10 * 1024 * 1024)
    expect(MAX_SOURCE_BYTES).toBe(2 * 1024 * 1024)
    expect(MAX_METADATA_STRING_BYTES).toBe(1024)
    expect(MAX_STORIES_PER_COMPONENT).toBe(50)
    expect(MAX_STATIC_BINDING_DEPTH).toBe(64)
    expect(MAX_STATIC_RECURSION_DEPTH).toBe(4)
    expect(MAX_STATIC_COLLECTION_ENTRIES).toBe(20)
    expect(MAX_CONTROL_CHOICES).toBe(20)
    expect(MAX_SERIALIZED_VALUE_BYTES).toBe(2 * 1024)
    expect(MAX_DEMONSTRATED_BYTES_PER_COMPONENT).toBe(64 * 1024)
    expect(MAX_OMISSION_MARKER_NAMES).toBe(20)
  })
})

describe("resolveStoryFile", () => {
  test("resolves an eligible story and reports its byte size", () => {
    const root = makeRoot()
    const story = path.join(root, "Button.stories.tsx")
    fs.writeFileSync(story, "export default {}")

    const result = resolveStoryFile(root, "Button.stories.tsx")

    expect(result).toEqual({ ok: true, path: fs.realpathSync(story), size: 17 })
  })

  test.each([
    ["Button.stories.css", "unsupported-extension"],
    ["Button.stories.mdx", "unsupported-extension"]
  ])("rejects unsupported story source %s", (importPath, code) => {
    const result = resolveStoryFile(makeRoot(), importPath)
    expect(result).toEqual({ ok: false, error: { code } })
  })

  test("rejects directories and source files over the cap", () => {
    const root = makeRoot()
    fs.mkdirSync(path.join(root, "Button.stories.ts"))
    fs.writeFileSync(path.join(root, "Large.stories.ts"), Buffer.alloc(MAX_SOURCE_BYTES + 1))

    expect(resolveStoryFile(root, "Button.stories.ts")).toEqual({ ok: false, error: { code: "not-a-file" } })
    expect(resolveStoryFile(root, "Large.stories.ts")).toEqual({ ok: false, error: { code: "too-large" } })
  })

  test("bounds actual bytes read and does not publish source in failures", () => {
    const root = makeRoot()
    fs.writeFileSync(path.join(root, "Button.stories.ts"), "export default {}")
    const success = readStoryFile(root, "Button.stories.ts")
    expect(success).toMatchObject({ ok: true, bytesRead: 17, source: "export default {}" })

    fs.writeFileSync(path.join(root, "Large.stories.ts"), Buffer.alloc(MAX_SOURCE_BYTES + 1, "x"))
    const failure = readStoryFile(root, "Large.stories.ts")
    expect(failure).toEqual({ ok: false, error: { code: "too-large" } })
    expect(JSON.stringify(failure)).not.toContain(root)
    expect(JSON.stringify(failure)).not.toContain("x")
  })

  test("rejects metadata strings over the byte cap without touching the filesystem", () => {
    const root = makeRoot()
    const result = resolveStoryFile(root, `${"a".repeat(MAX_METADATA_STRING_BYTES)}.ts`)
    expect(result).toEqual({ ok: false, error: { code: "metadata-too-large" } })
  })
})
