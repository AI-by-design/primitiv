import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CodebaseSource } from "../types"
import { CodebaseScanner } from "./scanner"

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-scanner-test-"))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeFixture(rel: string, content: string): void {
  const abs = path.join(tempDir, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

function source(): CodebaseSource {
  return { root: tempDir, patterns: ["**/*.css", "**/*.tsx"], ignore: [] }
}

describe("token taxonomy", () => {
  test("CSS custom properties categorize into the expanded buckets, leaving 'other' empty", async () => {
    writeFixture(
      "theme.css",
      `:root {
        --color-primary: #3b82f6;
        --space-md: 16px;
        --line-height-base: 1.5;
        --radius-sm: 4px;
        --shadow-md: 0 1px 2px rgba(0,0,0,0.1);
        --z-index-modal: 100;
        --breakpoint-md: 768px;
        --duration-fast: 150ms;
      }`
    )
    const { tokens } = await new CodebaseScanner(source()).scan()
    expect(Object.keys(tokens.colors)).toContain("color-primary")
    expect(Object.keys(tokens.spacing)).toContain("space-md")
    expect(Object.keys(tokens.typography)).toContain("line-height-base")
    expect(Object.keys(tokens.borderRadius)).toContain("radius-sm")
    expect(Object.keys(tokens.shadows)).toContain("shadow-md")
    expect(Object.keys(tokens.zIndex ?? {})).toContain("z-index-modal")
    expect(Object.keys(tokens.breakpoints ?? {})).toContain("breakpoint-md")
    expect(Object.keys(tokens.motion ?? {})).toContain("duration-fast")
    expect(Object.keys(tokens.other ?? {})).toHaveLength(0)
  })

  test("letter-spacing lands in typography, not spacing", async () => {
    writeFixture("type.css", `:root { --letter-spacing-tight: -0.01em; }`)
    const { tokens } = await new CodebaseScanner(source()).scan()
    expect(Object.keys(tokens.typography)).toContain("letter-spacing-tight")
    expect(Object.keys(tokens.spacing)).not.toContain("letter-spacing-tight")
  })
})

describe("component extraction (AST)", () => {
  test("captures every component in a file, not just the first", async () => {
    writeFixture(
      "Card.tsx",
      `export function Card() { return <div /> }
export function CardHeader() { return <header /> }
export const CardBody = () => <section />`
    )
    const { components } = await new CodebaseScanner(source()).scan()
    expect(Object.keys(components)).toContain("Card")
    expect(Object.keys(components)).toContain("CardHeader")
    expect(Object.keys(components)).toContain("CardBody")
  })

  test("detects forwardRef/memo components exported via a local specifier", async () => {
    writeFixture(
      "Button.tsx",
      `import { forwardRef, memo } from "react"
const Button = forwardRef((props, ref) => <button ref={ref} {...props} />)
const Badge = memo(() => <span />)
export { Button, Badge }`
    )
    const { components } = await new CodebaseScanner(source()).scan()
    expect(Object.keys(components)).toContain("Button")
    expect(Object.keys(components)).toContain("Badge")
  })

  test("ignores re-exports from another module (no barrel double-count / false collision)", async () => {
    writeFixture("ui/Button.tsx", `export function Button() { return <button /> }`)
    writeFixture("ui/index.tsx", `export { Button } from "./Button"`)
    const { components, collisions } = await new CodebaseScanner(source()).scan()
    expect(Object.keys(components).filter((n) => n === "Button")).toHaveLength(1)
    expect(collisions.find((c) => c.name === "Button")).toBeUndefined()
  })

  test("excludes non-components (hooks, constants, plain objects)", async () => {
    writeFixture(
      "stuff.tsx",
      `export const MAX = 42
export function useThing() { return 5 }
export const config = { a: 1 }
export function Widget() { return <div /> }`
    )
    const { components } = await new CodebaseScanner(source()).scan()
    expect(Object.keys(components)).toEqual(["Widget"])
  })

  test("classifies kind (icon / provider / component)", async () => {
    writeFixture("ChevronIcon.tsx", `export const ChevronIcon = () => <svg />`)
    writeFixture("ThemeProvider.tsx", `export function ThemeProvider() { return <div /> }`)
    writeFixture("Button.tsx", `export function Button() { return <button /> }`)
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.ChevronIcon?.kind).toBe("icon")
    expect(components.ThemeProvider?.kind).toBe("provider")
    expect(components.Button?.kind).toBe("component")
  })

  test("surfaces same-name collisions instead of silently dropping them", async () => {
    writeFixture("list/Item.tsx", `export function Item() { return <li /> }`)
    writeFixture("menu/Item.tsx", `export function Item() { return <li /> }`)
    const { components, collisions } = await new CodebaseScanner(source()).scan()
    expect(Object.keys(components).filter((n) => n === "Item")).toHaveLength(1)
    const itemCollision = collisions.find((c) => c.name === "Item")
    expect(itemCollision).toBeDefined()
    expect(itemCollision?.files).toHaveLength(2)
  })
})
