import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MAX_IDENTIFIER_CHARS,
  hasUnsafeIdentifierCodePoint,
  identifierListUtf8Bytes,
  isSafeIdentifier,
  isSafeIdentifierPath,
  isSafeNonEmptyIdentifier,
  isWithinDurableParticipantBounds,
  MAX_CONFLICT_COMPONENT_ID_BYTES,
  MAX_CONFLICT_COMPONENT_IDS,
  MAX_IDENTIFIER_PATH_SEGMENTS
} from "./safe-identifier"

describe("safe identifiers", () => {
  test("accepts opaque punctuation and prototype-like path text without rewriting it", () => {
    const values = [
      "code/components/Button.tsx#Button",
      "storybook:UI/Button",
      "figma:published.button[variant=quiet]",
      "__proto__.size",
      "constructor/prototype"
    ]

    for (const value of values) {
      expect(hasUnsafeIdentifierCodePoint(value)).toBe(false)
      expect(isSafeIdentifier(value)).toBe(true)
    }
  })

  test("rejects every agreed control and bidirectional formatting range", () => {
    const range = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
    const unsafeCodePoints = [
      ...range(0x00, 0x1f),
      ...range(0x7f, 0x9f),
      0x061c,
      0x200e,
      0x200f,
      ...range(0x202a, 0x202e),
      ...range(0x2066, 0x2069)
    ]

    for (const codePoint of unsafeCodePoints) {
      const value = `safe${String.fromCodePoint(codePoint)}suffix`
      expect(hasUnsafeIdentifierCodePoint(value)).toBe(true)
      expect(isSafeIdentifier(value)).toBe(false)
    }
  })

  test("does not reject neighboring printable code points", () => {
    const safeCodePoints = [0x20, 0x7e, 0xa0, 0x061b, 0x061d, 0x200d, 0x2010, 0x2029, 0x2065, 0x206a]
    for (const codePoint of safeCodePoints) {
      expect(isSafeIdentifier(`a${String.fromCodePoint(codePoint)}b`)).toBe(true)
    }
  })

  test("enforces the default and caller-provided limits", () => {
    expect(isSafeIdentifier("a".repeat(DEFAULT_MAX_IDENTIFIER_CHARS))).toBe(true)
    expect(isSafeIdentifier("a".repeat(DEFAULT_MAX_IDENTIFIER_CHARS + 1))).toBe(false)
    expect(isSafeIdentifier("abcd", 4)).toBe(true)
    expect(isSafeIdentifier("abcde", 4)).toBe(false)
    expect(isSafeIdentifier("", 0)).toBe(true)
    expect(isSafeIdentifier("a", 0)).toBe(false)
    expect(isSafeIdentifier("a", Number.NaN)).toBe(false)
  })

  test("enforces non-empty bounded identifiers and paths without normalization", () => {
    const decomposed = "component/e\u0301"
    expect(isSafeNonEmptyIdentifier("")).toBe(false)
    expect(isSafeNonEmptyIdentifier(decomposed)).toBe(true)
    expect(isSafeIdentifierPath(["props", "__proto__.size", decomposed])).toBe(true)
    expect(isSafeIdentifierPath([])).toBe(false)
    expect(isSafeIdentifierPath(Array.from({ length: MAX_IDENTIFIER_PATH_SEGMENTS + 1 }, () => "safe"))).toBe(false)
    expect(isSafeIdentifierPath(["props", "unsafe\nsegment"])).toBe(false)
  })

  test("measures durable participant IDs as UTF-8 and enforces both ceilings", () => {
    expect(identifierListUtf8Bytes(["a", "\u00e9"])).toBe(3)
    expect(isWithinDurableParticipantBounds(Array.from({ length: MAX_CONFLICT_COMPONENT_IDS }, () => "id"))).toBe(true)
    expect(isWithinDurableParticipantBounds(Array.from({ length: MAX_CONFLICT_COMPONENT_IDS + 1 }, () => "id"))).toBe(
      false
    )
    expect(isWithinDurableParticipantBounds(["x".repeat(MAX_CONFLICT_COMPONENT_ID_BYTES + 1)])).toBe(false)
  })
})
