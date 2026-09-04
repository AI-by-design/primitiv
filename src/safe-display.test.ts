import { describe, expect, test } from "bun:test"
import { safeDisplayText, safeDisplayValue, structuredValueText } from "./safe-display"

describe("safe display", () => {
  test("escapes terminal and bidirectional controls", () => {
    expect(safeDisplayText("name\n\u001b[31m\u061c\u200e\u200f\u202evalue")).toBe(
      "name\\u{000a}\\u{001b}[31m\\u{061c}\\u{200e}\\u{200f}\\u{202e}value"
    )
  })

  test("escapes the boundaries of the shared unsafe identifier ranges", () => {
    expect(safeDisplayText("\u0000\u001f\u007f\u009f\u202a\u202e\u2066\u2069")).toBe(
      "\\u{0000}\\u{001f}\\u{007f}\\u{009f}\\u{202a}\\u{202e}\\u{2066}\\u{2069}"
    )
  })

  test("bounds the rendered line", () => {
    expect(safeDisplayText("abcdefgh", 5)).toBe("abcd…")
  })

  test("serializes structured values canonically and preserves primitive types", () => {
    expect(structuredValueText({ z: "1", a: [1, true, null] })).toBe('{"a":[1,true,null],"z":"1"}')
    expect(safeDisplayValue("\u001bvalue")).toBe('"\\u001bvalue"')
  })
})
