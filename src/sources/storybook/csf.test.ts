import { describe, expect, test } from "bun:test"
import { matchParsedStory, parseStorybookSource, storybookStoryId } from "./csf"

describe("parseStorybookSource", () => {
  test("separates semantic argTypes from controls and retains bounded static args", () => {
    const parsed = parseStorybookSource(`
      const defaults = { disabled: false, nested: { count: 1 }, dynamic: choose() }
      const options = ["secondary", "primary"] as const
      export default {
        title: "Admin/Button",
        includeStories: chooseIncludedStories(),
        excludeStories: chooseExcludedStories(),
        args: { ...defaults, label: \`Button\`, nil: null },
        argTypes: {
          size: {
            type: { name: "enum", value: ["sm", "md", "lg"], required: true },
            control: { type: "radio", presetColors: ["ignored"] },
            options,
            mapping: { primary: { tone: 1 }, secondary: getTone() }
          },
          hidden: { control: false },
          compatible: { required: true, control: "boolean" },
          controlOnly: { control: "text" }
        }
      } satisfies Meta

      export const Primary = {
        name: "Source fallback",
        args: { disabled: true, label: runtimeLabel() },
        argTypes: { size: { control: "select", options: ["lg", dynamic, "sm"] } },
        loaders: [async () => ({ injected: true })],
        render: (args) => <button {...args} />
      }
    `)

    expect(parsed.title).toBe("Admin/Button")
    expect(parsed.values).toEqual({ disabled: false, label: "Button", nested: { count: 1 }, nil: null })
    expect(parsed.unresolvedKeys).toEqual(["dynamic"])
    expect(parsed.props).toEqual({
      compatible: { required: true },
      size: { type: "enum", required: true, values: ["lg", "md", "sm"] }
    })
    expect(parsed.controls).toEqual({
      compatible: { control: "boolean" },
      controlOnly: { control: "text" },
      hidden: { control: false },
      size: {
        control: "radio",
        choices: [
          { option: "primary", mappedValue: { tone: 1 } },
          { option: "secondary", mappingUnresolved: true }
        ]
      }
    })
    expect(parsed.stories).toEqual([
      {
        exportName: "Primary",
        name: "Source fallback",
        values: { disabled: true },
        unresolvedKeys: ["label"],
        controls: {
          size: {
            control: "select",
            choices: [{ option: "lg" }, { option: "sm" }],
            unresolvedChoices: true
          }
        }
      }
    ])
  })

  test("supports CSF2 assignments, local export aliases, and identity annotations", () => {
    const parsed = parseStorybookSource(`
      const meta = { id: "custom-kind", args: { count: 1 } }
      export default meta
      const Local = () => null
      Local.args = { count: 2 }
      Local.argTypes = { count: { type: "number", control: "range" } }
      Local.storyName = "Counted"
      Local.parameters = { __id: "exact-custom-story", addon: { argTypes: { fake: {} } } }
      export { Local as Primary }
    `)

    expect(parsed.metaId).toBe("custom-kind")
    expect(parsed.props).toEqual({})
    expect(parsed.stories).toEqual([
      {
        exportName: "Primary",
        name: "Counted",
        customId: "exact-custom-story",
        values: { count: 2 },
        controls: { count: { control: "range" } }
      }
    ])
    expect(storybookStoryId(parsed, parsed.stories[0], "Ignored/Title")).toBe("exact-custom-story")
    expect(matchParsedStory(parsed, "Ignored/Title", "exact-custom-story")?.exportName).toBe("Primary")
  })

  test("suppresses initializer evidence when a story object is dynamically replaced", () => {
    const parsed = parseStorybookSource(`
      export default { title: "Replacement" }
      export const Primary = { args: { stale: true } }
      Primary.story = runtimeStory()
    `)

    expect(parsed.stories).toEqual([{ exportName: "Primary" }])
  })

  test("does not claim initializer evidence from mutable story exports", () => {
    const parsed = parseStorybookSource(`
      export default { title: "Mutable" }
      export let Primary = { args: { stale: true } }
      Primary = runtimeStory()
    `)

    expect(parsed.stories).toEqual([{ exportName: "Primary" }])
  })

  test("matches current direct static story IDs", () => {
    const parsed = parseStorybookSource(`
      export default { title: "DirectId" }
      export const Primary = { __id: "direct-story-id", args: { safe: true } }
    `)

    expect(matchParsedStory(parsed, "DirectId", "direct-story-id")).toMatchObject({ exportName: "Primary" })
  })

  test("retains a local story initializer when CSF2 metadata mutates the story object", () => {
    const parsed = parseStorybookSource(`
      export default { title: "Local" }
      const Local = { args: { retained: true } }
      Local.storyName = "Local label"
      export { Local as Primary }
    `)

    expect(parsed.stories).toEqual([{ exportName: "Primary", name: "Local label", values: { retained: true } }])
  })

  test("supports direct-literal CSF factories and Storybook-compatible normal IDs", () => {
    const parsed = parseStorybookSource(`
      import preview from "#storybook/preview"
      const meta = preview.meta({ title: "Factory/Button", args: { active: true } })
      export const WithIcon2 = meta.story({ args: { icon: "add" }, __id: undefined })
    `)

    expect(parsed.title).toBe("Factory/Button")
    expect(parsed.values).toEqual({ active: true })
    expect(parsed.stories[0]).toEqual({ exportName: "WithIcon2", values: { icon: "add" } })
    expect(storybookStoryId(parsed, parsed.stories[0], "Factory/Button")).toBe("factory-button--with-icon-2")
    expect(storybookStoryId(parsed, { exportName: "URL2Value" }, "Äccent/Title")).toBe("äccent-title--url-2-value")
  })

  test("composes already parsed local story args and suppresses writes before unknown spreads", () => {
    const parsed = parseStorybookSource(`
      export default { title: "Composed" }
      export const Base = { args: { inherited: true, replaced: "base" } }
      export const Composed = {
        args: { before: "unsafe", ...runtimeArgs, after: "safe" }
      }
      export const Derived = {
        args: { ...Base.args, replaced: "derived" }
      }
    `)

    expect(parsed.stories).toEqual([
      { exportName: "Base", values: { inherited: true, replaced: "base" } },
      { exportName: "Composed", values: { after: "safe" }, hasUnresolvedSpread: true },
      { exportName: "Derived", values: { inherited: true, replaced: "derived" } }
    ])
  })

  test("caps top-level arg keys and omission markers canonically", () => {
    const properties = Array.from({ length: 45 }, (_, index) => `key${String(index).padStart(2, "0")}: ${index}`)
    const parsed = parseStorybookSource(
      `export default { title: "Bounded", args: { ${properties.reverse().join(",")} } }; export const Primary = {}`
    )

    expect(Object.keys(parsed.values ?? {})).toEqual(
      Array.from({ length: 20 }, (_, index) => `key${String(index).padStart(2, "0")}`)
    )
    expect(parsed.truncatedKeys).toEqual(
      Array.from({ length: 20 }, (_, index) => `key${String(index + 20).padStart(2, "0")}`)
    )
  })

  test("ignores storySort and canonicalizes source-authored ordering", () => {
    const first = parseStorybookSource(`
      export default {
        title: "Order",
        parameters: { options: { storySort: () => ["Zebra", "Alpha"] } },
        args: { nested: { z: 2, a: 1 } },
        argTypes: {
          zebra: { control: "text" },
          alpha: { type: "string", control: "radio", options: ["z", "a"] }
        }
      }
      export const Zebra = { args: { z: true } }
      export const Alpha = { args: { a: true } }
    `)
    const second = parseStorybookSource(`
      export default {
        argTypes: {
          alpha: { options: ["a", "z"], control: "radio", type: "string" },
          zebra: { control: "text" }
        },
        args: { nested: { a: 1, z: 2 } },
        title: "Order"
      }
      export const Alpha = { args: { a: true } }
      export const Zebra = { args: { z: true } }
    `)

    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  test("caps and sorts control choices independently of source order", () => {
    const options = Array.from({ length: 23 }, (_, index) => `value-${String(index).padStart(2, "0")}`).reverse()
    const parsed = parseStorybookSource(`
      export default { argTypes: { choice: { control: "select", options: ${JSON.stringify(options)} } } }
      export const Primary = {}
    `)
    const control = parsed.controls?.choice
    expect(control?.choices?.map((choice) => choice.option)).toEqual([...options].sort().slice(0, 20))
    expect(control?.truncatedChoices).toBe(true)
  })

  test("ignores nested addon argTypes and keeps prototype-looking keys inert", () => {
    const parsed = parseStorybookSource(`
      export default {
        title: "Safe",
        args: { "__proto__": "data", constructor: "own", prototype: null },
        parameters: { addon: { argTypes: { invented: { type: "string" } } } }
      }
      export const Primary = {}
    `)

    expect(parsed.props).toEqual({})
    expect(Object.getPrototypeOf(parsed.values)).toBeNull()
    expect(parsed.values?.__proto__).toBe("data")
    expect(parsed.values?.constructor).toBe("own")
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  test("throws on syntax errors so the adapter can degrade the file to manifest-only", () => {
    expect(() => parseStorybookSource("export default { args: {")).toThrow()
  })
})
