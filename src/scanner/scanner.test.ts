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

describe("token redefinition capture", () => {
  test("same name defined twice with different values → first wins + a redefinition record", async () => {
    writeFixture(
      "tokens.css",
      `:root { --color-bg: #ffffff; }
:root { --color-bg: #000000; }`
    )
    const { tokens, redefinitions } = await new CodebaseScanner(source()).scan()
    expect(tokens.colors["color-bg"]?.value).toBe("#ffffff")
    expect(redefinitions).toHaveLength(1)
    expect(redefinitions[0].name).toBe("color-bg")
    expect(redefinitions[0].kept.value).toBe("#ffffff")
    expect(redefinitions[0].kept.source.line).toBe(1)
    expect(redefinitions[0].discarded).toEqual([
      { value: "#000000", source: { adapter: "codebase", file: "tokens.css", line: 2 } }
    ])
  })

  test("same name with the SAME value twice is harmless — no redefinition", async () => {
    writeFixture("a.css", `:root { --color-bg: #ffffff; }`)
    writeFixture("b.css", `:root { --color-bg: #ffffff; }`)
    const { redefinitions } = await new CodebaseScanner(source()).scan()
    expect(redefinitions).toHaveLength(0)
  })

  test("cross-file redefinition within the source is captured with both provenances", async () => {
    writeFixture("a.css", `:root { --space-md: 16px; }`)
    writeFixture("b.css", `:root { --space-md: 20px; }`)
    const { tokens, redefinitions } = await new CodebaseScanner(source()).scan()
    expect(tokens.spacing["space-md"]?.value).toBe("16px")
    expect(redefinitions).toHaveLength(1)
    expect(redefinitions[0].kept.source.file).toBe("a.css")
    expect(redefinitions[0].discarded[0].source.file).toBe("b.css")
  })

  test("a media-query override is a legitimate second value — not a redefinition", async () => {
    writeFixture(
      "responsive.css",
      `:root { --space-page: 16px; }
@media (min-width: 768px) { :root { --space-page: 24px; } }`
    )
    const { tokens, redefinitions } = await new CodebaseScanner(source()).scan()
    expect(tokens.spacing["space-page"]?.value).toBe("16px")
    expect(redefinitions).toHaveLength(0)
  })

  test("an unconditional definition upgrades over a conditional first sighting — no redefinition", async () => {
    writeFixture(
      "responsive.css",
      `@media (min-width: 768px) { :root { --space-page: 24px; } }
:root { --space-page: 16px; }`
    )
    const { tokens, redefinitions } = await new CodebaseScanner(source()).scan()
    // The unconditioned value is the canonical default even though it scanned second.
    expect(tokens.spacing["space-page"]?.value).toBe("16px")
    expect(redefinitions).toHaveLength(0)
  })

  test("TS theme objects redefining the same token name are captured too", async () => {
    writeFixture(
      "themes.ts",
      `export const base = { colors: { brand: "#111111" } }
export const alt = { colors: { brand: "#222222" } }`
    )
    const { tokens, redefinitions } = await new CodebaseScanner(source()).scan()
    expect(tokens.colors["colors-brand"]?.value).toBe("#111111")
    expect(redefinitions).toHaveLength(1)
    expect(redefinitions[0].discarded[0].value).toBe("#222222")
  })
})

describe("CSS theme-scoped tokens (modes)", () => {
  test("a `.dark` value becomes the token's dark mode, not a redefinition conflict", async () => {
    writeFixture(
      "theme.css",
      `:root { --color-bg: #ffffff; }
.dark { --color-bg: #000000; }`
    )
    const { tokens, redefinitions } = await new CodebaseScanner(source()).scan()
    const token = tokens.colors["color-bg"]
    expect(token?.value).toBe("#ffffff")
    expect(token?.modes).toEqual({ dark: "#000000" })
    expect(redefinitions).toHaveLength(0)
  })

  test("a theme-only var (no :root default) still enters the contract — the cal.com `--cal-*` case", async () => {
    writeFixture("dark.css", `[data-theme="dark"] { --cal-brand: #292929; }`)
    const { tokens } = await new CodebaseScanner(source()).scan()
    const token = tokens.colors["cal-brand"]
    // Value promoted from the only definition; provenance points at that definition.
    expect(token?.value).toBe("#292929")
    expect(token?.modes).toEqual({ dark: "#292929" })
    expect(token?.source.file).toBe("dark.css")
  })

  test("`@media (prefers-color-scheme: dark)` wrapping :root is a dark mode, not a responsive override", async () => {
    writeFixture(
      "scheme.css",
      `:root { --color-bg: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --color-bg: #000000; } }`
    )
    const { tokens, redefinitions } = await new CodebaseScanner(source()).scan()
    expect(tokens.colors["color-bg"]?.value).toBe("#ffffff")
    expect(tokens.colors["color-bg"]?.modes).toEqual({ dark: "#000000" })
    expect(redefinitions).toHaveLength(0)
  })

  test("`.dark .card` (descendant combinator) stays component-internal", async () => {
    writeFixture(
      "nested.css",
      `:root { --color-bg: #ffffff; }
.dark .card { --card-pad: 4px; }`
    )
    const { tokens, internalCssVars } = await new CodebaseScanner(source()).scan()
    const allNames = Object.values(tokens).flatMap((cat) => Object.keys(cat))
    expect(allNames).not.toContain("card-pad")
    expect(internalCssVars).toBe(1)
    // The theme root token gained no `.dark .card` mode.
    expect(tokens.colors["color-bg"]?.modes).toBeUndefined()
  })

  test("anchored theme selectors and `theme-*` classes derive the mode key", async () => {
    writeFixture(
      "themes.css",
      `:root { --color-bg: #ffffff; }
html.dark { --color-bg: #000000; }
:root.theme-dim { --color-bg: #111111; }`
    )
    const { tokens } = await new CodebaseScanner(source()).scan()
    expect(tokens.colors["color-bg"]?.modes).toEqual({ dark: "#000000", dim: "#111111" })
  })

  test("a `--pc-` prefixed var inside a theme selector stays component-internal (name wins over scope)", async () => {
    writeFixture("dark.css", `.dark { --pc-thumb: #000000; }`)
    const { tokens, internalCssVars } = await new CodebaseScanner(source()).scan()
    const allNames = Object.values(tokens).flatMap((cat) => Object.keys(cat))
    expect(allNames).not.toContain("pc-thumb")
    expect(internalCssVars).toBe(1)
  })

  test("a theme value seen before its :root default is upgraded when the default arrives", async () => {
    // Files scan in sorted order, so `a-dark.css` (the `.dark` value) is read before `b-root.css`.
    writeFixture("a-dark.css", `.dark { --color-bg: #000000; }`)
    writeFixture("b-root.css", `:root { --color-bg: #ffffff; }`)
    const { tokens, redefinitions } = await new CodebaseScanner(source()).scan()
    // :root is the canonical default even though the `.dark` value scanned first.
    expect(tokens.colors["color-bg"]?.value).toBe("#ffffff")
    expect(tokens.colors["color-bg"]?.source.file).toBe("b-root.css")
    expect(tokens.colors["color-bg"]?.modes).toEqual({ dark: "#000000" })
    expect(redefinitions).toHaveLength(0)
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
  test("captures every component in a file under distinct ids (#Name qualifier for siblings)", async () => {
    writeFixture(
      "Card.tsx",
      `export function Card() { return <div /> }
export function CardHeader() { return <header /> }
export const CardBody = () => <section />`
    )
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.Card?.displayName).toBe("Card")
    expect(components["Card#CardHeader"]?.displayName).toBe("CardHeader")
    expect(components["Card#CardBody"]?.displayName).toBe("CardBody")
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
    expect(components.Button?.displayName).toBe("Button")
    expect(components["Button#Badge"]?.displayName).toBe("Badge")
  })

  test("ignores re-exports from another module (no barrel double-count)", async () => {
    writeFixture("ui/Button.tsx", `export function Button() { return <button /> }`)
    writeFixture("ui/index.tsx", `export { Button } from "./Button"`)
    const { components } = await new CodebaseScanner(source()).scan()
    const buttons = Object.values(components).filter((c) => c.displayName === "Button")
    expect(buttons).toHaveLength(1)
    expect(components["ui/Button"]).toBeDefined()
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
    expect(Object.keys(components)).toEqual(["stuff#Widget"])
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

  test("same-name components in different files coexist under path-qualified ids", async () => {
    writeFixture("list/Item.tsx", `export function Item() { return <li /> }`)
    writeFixture("menu/Item.tsx", `export function Item() { return <li /> }`)
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components["list/Item"]?.displayName).toBe("Item")
    expect(components["menu/Item"]?.displayName).toBe("Item")
    expect(components["list/Item"]?.source.file).toBe("list/Item.tsx")
    expect(components["menu/Item"]?.source.file).toBe("menu/Item.tsx")
  })
})

describe("component props (per-component scoping)", () => {
  test("each component in a multi-component file gets its OWN props, not the first's", async () => {
    writeFixture(
      "Card.tsx",
      `interface CardProps { title: string; elevation?: number }
export function Card(props: CardProps) {
  return <div />
}

interface CardHeaderProps { sticky?: boolean }
export function CardHeader(props: CardHeaderProps) {
  return <header />
}`
    )
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.Card?.props).toEqual({
      title: { type: "string", required: true },
      elevation: { type: "number", required: false }
    })
    // The bug: CardHeader used to inherit the first *Props block (CardProps). It must
    // carry only its own prop.
    expect(components["Card#CardHeader"]?.props).toEqual({
      sticky: { type: "boolean", required: false }
    })
  })

  test("an inline object prop type resolves", async () => {
    writeFixture("Tag.tsx", `export const Tag = (props: { label: string; round?: boolean }) => <span />`)
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.Tag?.props).toEqual({
      label: { type: "string", required: true },
      round: { type: "boolean", required: false }
    })
  })

  test("forwardRef<_, Props> resolves the props generic", async () => {
    writeFixture(
      "Button.tsx",
      `import { forwardRef } from "react"
interface ButtonProps { variant: string }
export const Button = forwardRef<HTMLButtonElement, ButtonProps>((props, ref) => <button ref={ref} />)`
    )
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.Button?.props).toEqual({ variant: { type: "string", required: true } })
  })

  test("a props type imported from another module degrades to empty (honest, not wrong)", async () => {
    writeFixture(
      "Widget.tsx",
      `import type { WidgetProps } from "./props"
export function Widget(props: WidgetProps) {
  return <div />
}`
    )
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.Widget?.props).toEqual({})
  })
})

describe("component identity (path-qualified ids)", () => {
  test("id is the relative path sans extension when the name matches the filename", async () => {
    writeFixture("components/ui/Card.tsx", `export function Card() { return <div /> }`)
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components["components/ui/Card"]?.displayName).toBe("Card")
  })

  test("index.* files take their folder name as the effective filename", async () => {
    writeFixture("components/Card/index.tsx", `export function Card() { return <div /> }`)
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components["components/Card/index"]?.displayName).toBe("Card")
  })

  test("filename match is normalized — kebab-case file matches PascalCase component", async () => {
    writeFixture("ui/card-header.tsx", `export function CardHeader() { return <header /> }`)
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components["ui/card-header"]?.displayName).toBe("CardHeader")
    expect(Object.keys(components).some((id) => id.includes("#"))).toBe(false)
  })

  test("a component whose name doesn't match its file gets the #Name qualifier", async () => {
    writeFixture("ui/widgets.tsx", `export function Widget() { return <div /> }`)
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components["ui/widgets#Widget"]?.displayName).toBe("Widget")
  })
})

describe("directories that look like source files", () => {
  // `node_modules/ipaddr.js` is a real, extremely common case: a package directory whose
  // name ends in .js, matched by the `**/*.js` pattern `init` generates. Reading it threw
  // EISDIR and failed the whole scan, so no contract was written.
  test("a directory whose name matches a source pattern is skipped, not read", async () => {
    writeFixture("theme.css", `:root { --color-brand: #2f6bff; }`)
    fs.mkdirSync(path.join(tempDir, "vendor.css"), { recursive: true })

    const { tokens } = await new CodebaseScanner(source()).scan()

    expect(tokens.colors["color-brand"]?.value).toBe("#2f6bff")
  })

  test("scanning survives a dependency directory named like a source file", async () => {
    writeFixture("theme.css", `:root { --space-md: 16px; }`)
    fs.mkdirSync(path.join(tempDir, "node_modules/ipaddr.js"), { recursive: true })
    writeFixture("node_modules/ipaddr.js/index.ts", `export const x = 1`)

    const scanner = new CodebaseScanner({ ...source(), ignore: ["**/node_modules/**"] })
    const { tokens } = await scanner.scan()

    expect(tokens.spacing["space-md"]?.value).toBe("16px")
  })
})
