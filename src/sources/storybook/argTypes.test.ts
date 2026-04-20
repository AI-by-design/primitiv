import { describe, expect, test } from "bun:test"
import { parseArgTypes } from "./argTypes"

describe("parseArgTypes", () => {
  test("returns empty when no argTypes block exists", () => {
    const source = `export default { title: "Button" }`
    expect(parseArgTypes(source)).toEqual({})
  })

  test("extracts prop names and maps control types to basic types", () => {
    const source = `
      const meta = {
        title: "Button",
        component: Button,
        argTypes: {
          variant: { control: "select", options: ["primary", "secondary"] },
          size: { control: "select", options: ["sm", "md", "lg"] },
          disabled: { control: "boolean" },
          label: { control: "text" },
          count: { control: "number" }
        }
      }
    `
    const result = parseArgTypes(source)
    expect(result.variant).toEqual({ type: "enum", required: false })
    expect(result.size).toEqual({ type: "enum", required: false })
    expect(result.disabled).toEqual({ type: "boolean", required: false })
    expect(result.label).toEqual({ type: "string", required: false })
    expect(result.count).toEqual({ type: "number", required: false })
  })

  test("handles object-form control hint", () => {
    const source = `
      export default {
        argTypes: {
          variant: {
            control: { type: "radio" },
            options: ["a", "b"]
          }
        }
      }
    `
    const result = parseArgTypes(source)
    expect(result.variant).toEqual({ type: "enum", required: false })
  })

  test("marks required props as required", () => {
    const source = `
      export default {
        argTypes: {
          label: { control: "text", required: true },
          icon: { control: "text" }
        }
      }
    `
    const result = parseArgTypes(source)
    expect(result.label.required).toBe(true)
    expect(result.icon.required).toBe(false)
  })

  test("falls back to control name when no mapping exists", () => {
    const source = `
      export default {
        argTypes: {
          theme: { control: "custom-thing" }
        }
      }
    `
    const result = parseArgTypes(source)
    expect(result.theme.type).toBe("custom-thing")
  })

  test("handles nested braces inside prop definitions without getting confused", () => {
    const source = `
      export default {
        argTypes: {
          style: {
            control: "object",
            table: {
              defaultValue: { summary: "{ color: 'red' }" }
            }
          },
          size: { control: "number" }
        }
      }
    `
    const result = parseArgTypes(source)
    expect(result.style.type).toBe("object")
    expect(result.size.type).toBe("number")
  })

  test("handles strings containing braces inside values", () => {
    const source = `
      export default {
        argTypes: {
          placeholder: { control: "text", description: "Use {name} as a token" },
          onClick: { action: "clicked" }
        }
      }
    `
    const result = parseArgTypes(source)
    expect(result.placeholder.type).toBe("string")
    // onClick has no control — falls through to the empty/unknown default.
    expect(result.onClick).toBeDefined()
  })

  test("unterminated argTypes block returns empty", () => {
    const source = `const meta = { argTypes: { broken: { control: "text" } `
    expect(parseArgTypes(source)).toEqual({})
  })
})
