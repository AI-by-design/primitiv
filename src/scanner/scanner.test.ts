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
  return { root: tempDir, patterns: ["**/*.css", "**/*.ts", "**/*.tsx"], ignore: [] }
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

  test("border-radius/border-width/line-height categorize past the broad 'border' color net", async () => {
    writeFixture(
      "tokens.css",
      `:root {
        --border-radius-md: 8px;
        --border-width-thin: 1px;
        --line-height-tight: 1.2;
        --border-color: #cccccc;
      }`
    )
    const { tokens } = await new CodebaseScanner(source()).scan()
    expect(Object.keys(tokens.borderRadius)).toContain("border-radius-md")
    // No borderWidth bucket — a width is a dimension, so it lands in sizes, not colors.
    expect(Object.keys(tokens.sizes ?? {})).toContain("border-width-thin")
    expect(Object.keys(tokens.typography)).toContain("line-height-tight")
    expect(Object.keys(tokens.colors)).toContain("border-color")
  })
})

describe("CSS selector scope (global vs component-internal)", () => {
  test("keeps global :root vars, drops component-scoped + prefixed vars, counts the drop", async () => {
    writeFixture(
      "styles.css",
      `:root {
        --color-bg: #ffffff;
        --space-lg: 24px;
        --pc-prefixed: 4px;
      }
      .Card {
        --card-padding: 12px;
      }`
    )
    const { tokens, internalCssVars } = await new CodebaseScanner(source()).scan()
    expect(Object.keys(tokens.colors)).toContain("color-bg")
    expect(Object.keys(tokens.spacing)).toContain("space-lg")
    // `.Card` is a component selector, not `:root` → its var is internal.
    const allNames = Object.values(tokens).flatMap((cat) => Object.keys(cat))
    expect(allNames).not.toContain("card-padding")
    // `--pc-` is a component-prefix convention → internal even though it sits in :root.
    expect(allNames).not.toContain("pc-prefixed")
    expect(internalCssVars).toBe(2)
  })

  test("a value containing braces/semicolons doesn't corrupt the scope stack", async () => {
    writeFixture(
      "tricky.css",
      `:root { --token-global: 10px; }
      .x::after { content: "}"; --internal: 1px; }
      :root { --token-after: #abcdef; }`
    )
    const { tokens } = await new CodebaseScanner(source()).scan()
    // Both :root vars survive — the `}` inside content:"}" did not prematurely close the rule.
    const allNames = Object.values(tokens).flatMap((cat) => Object.keys(cat))
    expect(allNames).toContain("token-global")
    expect(Object.keys(tokens.colors)).toContain("token-after")
    // The var inside `.x::after` stays internal — proof the scope stack wasn't corrupted.
    expect(allNames).not.toContain("internal")
  })
})

describe("TS theme-token extraction (AST)", () => {
  test("walks a nested `export const theme = {…} as const` and categorizes by group key", async () => {
    writeFixture(
      "theme.ts",
      `export const theme = {
        colors: { primary: "#3b82f6", danger: "rgb(255,0,0)" },
        spacing: { sm: "8px", md: "16px" },
        radii: { sm: "4px" },
        fontSizes: { body: "14px" },
      } as const`
    )
    const { tokens } = await new CodebaseScanner(source()).scan()
    expect(Object.keys(tokens.colors)).toEqual(expect.arrayContaining(["colors-primary", "colors-danger"]))
    expect(Object.keys(tokens.spacing)).toEqual(expect.arrayContaining(["spacing-sm", "spacing-md"]))
    expect(Object.keys(tokens.borderRadius)).toContain("radii-sm")
    expect(Object.keys(tokens.typography)).toContain("fontSizes-body")
  })

  test("rejects Tailwind className strings (createTheme objects) via the value gate", async () => {
    writeFixture(
      "Badge.theme.ts",
      `export const badgeTheme = {
        root: {
          base: "flex h-fit items-center gap-1 font-semibold",
          color: { info: "bg-cyan-100 text-cyan-800 hover:bg-cyan-200 dark:bg-cyan-200" },
          size: { xs: "p-1 text-xs", sm: "p-1.5 text-sm" },
        },
      }`
    )
    const { tokens } = await new CodebaseScanner(source()).scan()
    const total = Object.values(tokens).reduce((n, cat) => n + Object.keys(cat).length, 0)
    expect(total).toBe(0)
  })

  test("a multi-part shadow value (spaces) is kept — not mistaken for a className", async () => {
    writeFixture("shadows.ts", `export const boxShadow = { card: "0 2px 5px 0 rgba(0, 0, 0, 0.1)" }`)
    const { tokens } = await new CodebaseScanner(source()).scan()
    expect(tokens.shadows["boxShadow-card"]?.value).toBe("0 2px 5px 0 rgba(0, 0, 0, 0.1)")
  })

  test("resolves alias tokens that reference a base scale (meta-token `{ value }` wrapper)", async () => {
    writeFixture(
      "tokens.ts",
      `export const size = { "100": "4px", "200": "8px" }
export const radius = {
  "radius-100": { value: size["100"] },
  "radius-full": { value: "9999px" },
}`
    )
    const { tokens } = await new CodebaseScanner(source()).scan()
    expect(tokens.borderRadius["radius-100"]?.value).toBe("4px")
    expect(tokens.borderRadius["radius-full"]?.value).toBe("9999px")
    expect(tokens.sizes?.["size-100"]?.value).toBe("4px")
  })

  test("resolves an object exported by reference (`const config = {…}; export default config`)", async () => {
    writeFixture(
      "config.ts",
      `const config = { colors: { brand: "#abcdef" } }
export default config`
    )
    const { tokens } = await new CodebaseScanner(source()).scan()
    expect(tokens.colors["colors-brand"]?.value).toBe("#abcdef")
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
