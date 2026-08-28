import { describe, expect, test } from "bun:test"
import { parseArgTypes } from "./argTypes"

describe("parseArgTypes compatibility entry point", () => {
  test("returns only explicit semantic type evidence", () => {
    expect(
      parseArgTypes(`export default {
        argTypes: {
          size: { type: { name: "enum", value: ["sm", "lg"], required: true }, control: "radio" },
          disabled: { required: false, control: "boolean" },
          controlOnly: { control: "text", options: ["one"] }
        }
      }`)
    ).toEqual({
      disabled: { required: false },
      size: { type: "enum", required: true, values: ["lg", "sm"] }
    })
  })

  test("fails closed on malformed source and keeps authored keys inert", () => {
    expect(parseArgTypes("export default { argTypes: {")).toEqual({})
    const props = parseArgTypes(
      `export default { argTypes: { "__proto__": { type: "string" }, constructor: { required: true } } }`
    )
    expect(Object.getPrototypeOf(props)).toBeNull()
    expect(props.__proto__).toEqual({ type: "string" })
    expect(props.constructor).toEqual({ required: true })
  })
})
