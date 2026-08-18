import { describe, expect, test } from "bun:test"
import { normalizeForComparison, valuesEquivalent } from "./value"

describe("valuesEquivalent", () => {
  test("equates only supported alternative colour spellings", () => {
    expect(valuesEquivalent("#1E4FD8", "#1e4fd8", "colors")).toBe(true)
    expect(valuesEquivalent("#fff", "#ffffff", "colors")).toBe(true)
    expect(valuesEquivalent("#ffffffff", "#ffffff", "colors")).toBe(true)
    expect(valuesEquivalent("rgb(255, 255, 255)", "#ffffff", "colors")).toBe(true)
    expect(valuesEquivalent("rgba(255,255,255,1.0)", "#fff", "colors")).toBe(true)
  })

  test("equates zero length only in length categories", () => {
    expect(valuesEquivalent("0", "0px", "spacing")).toBe(true)
    expect(valuesEquivalent("0rem", "0em", "borderRadius")).toBe(true)
    expect(valuesEquivalent("0", "0px", "zIndex")).toBe(false)
  })

  test("canonicalizes safe trailing zero decimals", () => {
    expect(valuesEquivalent("0.50", "0.5", "typography")).toBe(true)
    expect(valuesEquivalent("1.0px", "1px", "sizes")).toBe(true)
  })

  test("handles long adversarial numeric inputs without changing their meaning", () => {
    const digits = "9".repeat(8_192)
    const zeros = "0".repeat(8_192)
    const malformedRgb = `rgba(1,1,1,${digits}!)`
    const malformedNumeric = `${digits}!`
    const validFraction = `1.${zeros}1`

    expect(normalizeForComparison(malformedRgb, "colors")).toBe(`raw:${malformedRgb}`)
    expect(normalizeForComparison(malformedNumeric, "typography")).toBe(`raw:${malformedNumeric}`)
    expect(normalizeForComparison(validFraction, "typography")).toBe(`numeric:${validFraction}`)
  })

  test("does not manufacture equivalence for context-dependent or unsupported values", () => {
    expect(valuesEquivalent("1rem", "16px", "spacing")).toBe(false)
    expect(valuesEquivalent("0%", "0px", "spacing")).toBe(false)
    expect(valuesEquivalent("600", "600px", "typography")).toBe(false)
    expect(valuesEquivalent("#fff", "#eee", "colors")).toBe(false)
    expect(valuesEquivalent("var(--Brand)", "var(--brand)", "colors")).toBe(false)
    expect(valuesEquivalent("rgba(0,0,0,0.5)", "#00000080", "colors")).toBe(false)
    expect(valuesEquivalent("rgb(0,0,0,0.5)", "#000", "colors")).toBe(false)
  })

  test("keeps unsupported values byte-exact", () => {
    expect(normalizeForComparison("Inter", "typography")).not.toBe(normalizeForComparison("inter", "typography"))
    expect(normalizeForComparison(" var(--Brand)", "colors")).not.toBe(normalizeForComparison("var(--Brand)", "colors"))
  })
})
