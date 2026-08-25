import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { CodebaseSource } from "../types"
import { CodebaseScanner } from "./scanner"

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-component-analysis-test-"))
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function writeFixture(relativePath: string, content: string, root = tempDir): void {
  const absolutePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
  fs.writeFileSync(absolutePath, content)
}

function source(root = tempDir, patterns = ["**/*.ts", "**/*.tsx", "**/*.jsx"]): CodebaseSource {
  return { root, patterns, ignore: [] }
}

describe("component JSX relationships", () => {
  test("resolves supported relative imports and export aliases to qualified component ids", async () => {
    writeFixture("ui/Button.tsx", `export function Button() { return <button /> }`)
    writeFixture(
      "ui/Badge.tsx",
      `const Badge = () => <span />
export default Badge`
    )
    writeFixture(
      "ui/Card/index.jsx",
      `const Card = () => <article />
export { Card, Card as Panel, Card as default }`
    )
    writeFixture("list/Item.tsx", `export function Item() { return <li /> }`)
    writeFixture("menu/Item.tsx", `export function Item() { return <li /> }`)
    writeFixture(
      "App.tsx",
      `import { Button, Button as Primary } from "./ui/Button.tsx"
import Badge from "./ui/Badge"
import { default as BadgeAgain } from "./ui/Badge"
import Card, { Card as NamedCard, Panel } from "./ui/Card"
import { Item as ListItem } from "./list/Item"
import { Item as MenuItem } from "./menu/Item"

export function App() {
  return <><Button /><Primary /><Badge /><BadgeAgain /><Card /><NamedCard /><Panel /><ListItem /><MenuItem /></>
}`
    )

    const { components } = await new CodebaseScanner(source()).scan()

    expect(components.App?.uses).toEqual({
      "list/Item": 1,
      "menu/Item": 1,
      "ui/Badge": 2,
      "ui/Button": 2,
      "ui/Card/index": 3
    })
    expect(components["ui/Button"]?.usage).toEqual({ sites: 2 })
    expect(components["ui/Badge"]?.usage).toEqual({ sites: 2 })
    expect(components["ui/Card/index"]?.usage).toEqual({ sites: 3 })
    expect(Object.values(components).filter((component) => component.displayName === "Card")).toHaveLength(1)
  })

  test("counts same-file, ownerless, repeated, and self JSX sites", async () => {
    writeFixture(
      "Family.tsx",
      `<Child />

export function Parent() { return <><Child /><Child /></> }
export const Sibling = () => <Child />
export function DestructuringOwner() {
  const [arrayFallback = <Child />] = []
  const { value: objectFallback = <Child /> } = {}
  try { throw {} } catch ({ catchFallback = <Child /> }) { void catchFallback }
  return <>{arrayFallback}{objectFallback}</>
}
export function Child() { return <div /> }
export function Recursive() { return <Recursive /> }`
    )

    const { components } = await new CodebaseScanner(source()).scan()

    expect(components["Family#Parent"]?.uses).toEqual({ "Family#Child": 2 })
    expect(components["Family#Sibling"]?.uses).toEqual({ "Family#Child": 1 })
    expect(components["Family#DestructuringOwner"]?.uses).toEqual({ "Family#Child": 3 })
    expect(components["Family#Recursive"]?.uses).toEqual({ "Family#Recursive": 1 })
    expect(components["Family#Child"]?.usage).toEqual({ sites: 7 })
    expect(components["Family#Recursive"]?.usage).toEqual({ sites: 1 })
    expect(components["Family#Child"]?.uses).toBeUndefined()
  })

  test("omits JSX sites hidden by lexical shadowing", async () => {
    writeFixture("ui/Button.tsx", `export function Button() { return <button /> }`)
    writeFixture(
      "Shadows.tsx",
      `import { Button } from "./ui/Button"

export function Param(Button: unknown) { return <Button /> }
export function Destructured({ Button }: { Button: unknown }) { return <Button /> }
export function Block() {
  const valid = <Button />
  { const hidden = <Button />; const Button = () => null }
  return valid
}
export function CatchScope() {
  try { throw 0 } catch (Button) { const hidden = <Button /> }
  return <Button />
}
export function Nested() {
  function helper(Button: unknown) { return <Button /> }
  return <Button />
}
export function HoistedVar() {
  const hidden = <Button />
  var Button
  return hidden
}`
    )

    const { components } = await new CodebaseScanner(source()).scan()

    expect(components["ui/Button"]?.usage).toEqual({ sites: 3 })
    expect(components["Shadows#Block"]?.uses).toEqual({ "ui/Button": 1 })
    expect(components["Shadows#CatchScope"]?.uses).toEqual({ "ui/Button": 1 })
    expect(components["Shadows#Nested"]?.uses).toEqual({ "ui/Button": 1 })
    expect(components["Shadows#Param"]?.uses).toBeUndefined()
    expect(components["Shadows#Destructured"]?.uses).toBeUndefined()
    expect(components["Shadows#HoistedVar"]?.uses).toBeUndefined()
  })

  test("resolves named-expression self bindings only for detected component roots", async () => {
    writeFixture(
      "NamedExpressions.tsx",
      `export const FunctionRoot = function InternalFunction() { return <InternalFunction /> }
export const ClassRoot = class InternalClass { render() { return <InternalClass /> } }
export function Owner() {
  const helper = function Owner() { return <Owner /> }
  const HelperClass = class Owner { render() { return <Owner /> } }
  return <div data-values={String(helper) + String(HelperClass)} />
}`
    )

    const { components } = await new CodebaseScanner(source()).scan()

    expect(components["NamedExpressions#FunctionRoot"]?.uses).toEqual({
      "NamedExpressions#FunctionRoot": 1
    })
    expect(components["NamedExpressions#ClassRoot"]?.uses).toEqual({
      "NamedExpressions#ClassRoot": 1
    })
    expect(components["NamedExpressions#Owner"]?.uses).toBeUndefined()
    expect(components["NamedExpressions#FunctionRoot"]?.usage).toEqual({ sites: 1 })
    expect(components["NamedExpressions#ClassRoot"]?.usage).toEqual({ sites: 1 })
    expect(components["NamedExpressions#Owner"]?.usage).toBeUndefined()
  })

  test("conservatively omits unsupported and ambiguous references", async () => {
    writeFixture("ui/Button.tsx", `export function Button() { return <button /> }`)
    writeFixture("ui/index.tsx", `export { Button } from "./Button"`)
    writeFixture("ui/Thing.tsx", `export default function Thing() { return <div /> }`)
    writeFixture("ui/Thing/index.tsx", `export default function Thing() { return <div /> }`)
    writeFixture(
      "Consumer.tsx",
      `import { Button } from "./ui/Button"
import * as UI from "./ui/Button"
import External from "external-package"
import PathAlias from "@/ui/Button"
import { Button as Barrel } from "./ui"
import Ambiguous from "./ui/Thing"
import React from "react"

const Dynamic = Button
const Required = require("./ui/Button")
const Lazy = React.lazy(() => import("./ui/Button"))

export function Consumer() {
  return <><button /><UI.Button /><External /><PathAlias /><Barrel /><Ambiguous /><Dynamic /><Required /><Lazy /></>
}`
    )

    const { components } = await new CodebaseScanner(source()).scan()

    expect(components.Consumer?.uses).toBeUndefined()
    expect(components["ui/Button"]?.usage).toBeUndefined()
    expect(components["ui/Thing"]?.usage).toBeUndefined()
    expect(components["ui/Thing/index"]?.usage).toBeUndefined()
  })

  test("deduplicates overlapping patterns and emits deterministic sorted relationships", async () => {
    const firstRoot = path.join(tempDir, "first")
    const secondRoot = path.join(tempDir, "second")
    const fixtures: Array<[string, string]> = [
      ["a/Alpha.tsx", `export function Alpha() { return <div /> }`],
      ["b/Beta.tsx", `export function Beta() { return <div /> }`],
      [
        "z/Owner.tsx",
        `import { Alpha } from "../a/Alpha"
import { Beta } from "../b/Beta"
export function Owner() { return <><Beta /><Alpha /><Beta /></> }`
      ]
    ]
    for (const [file, content] of fixtures) writeFixture(file, content, firstRoot)
    for (const [file, content] of [...fixtures].reverse()) writeFixture(file, content, secondRoot)

    const first = await new CodebaseScanner(source(firstRoot, ["**/*.tsx", "a/**/*.tsx", "z/*.tsx"])).scan()
    const second = await new CodebaseScanner(source(secondRoot, ["z/*.tsx", "a/**/*.tsx", "**/*.tsx"])).scan()

    expect(first.components).toEqual(second.components)
    expect(Object.keys(first.components)).toEqual(["a/Alpha", "b/Beta", "z/Owner"])
    expect(Object.keys(first.components["z/Owner"].uses ?? {})).toEqual(["a/Alpha", "b/Beta"])
    expect(first.components["z/Owner"].uses).toEqual({ "a/Alpha": 1, "b/Beta": 2 })
    expect(first.components["z/Owner"].usage).toBeUndefined()
    expect(first.components["a/Alpha"].uses).toBeUndefined()
  })

  test("does not infer relationships from a recovered parser-error AST", async () => {
    writeFixture("ui/Button.tsx", `export function Button() { return <button /> }`)
    writeFixture(
      "Broken.tsx",
      `import { Button } from "./ui/Button"
export function Broken() { return <Button /> }
let duplicate
let duplicate`
    )

    const { components } = await new CodebaseScanner(source()).scan()

    expect(components["ui/Button"]?.usage).toBeUndefined()
    expect(components.Broken?.uses).toBeUndefined()
  })
})

describe("component prop literal values and defaults", () => {
  test("extracts complete primitive domains and direct destructured defaults", async () => {
    writeFixture(
      "Button.tsx",
      `interface ButtonProps {
  size?: "sm" | "md" | "sm"
  elevation: -1 | 0 | 2
  disabled?: false | true
  mixed?: 1 | "1"
  label: string
  unsupported?: "x" | string
}

export function Button({
  size: localSize = "md" as const,
  elevation = -(1 as const),
  disabled = false,
  mixed = 1,
  label = "button",
  unsupported = "x",
  ignored = "ignored"
}: ButtonProps) {
  return <button>{localSize}{elevation}{disabled}{mixed}{label}{unsupported}{ignored}</button>
}`
    )

    const { components } = await new CodebaseScanner(source()).scan()

    expect(components.Button?.props).toEqual({
      size: { type: '"sm" | "md" | "sm"', required: false, values: ["md", "sm"], default: "md" },
      elevation: { type: "-1 | 0 | 2", required: true, values: [-1, 0, 2], default: "-1" },
      disabled: { type: "false | true", required: false, values: [false, true], default: "false" },
      mixed: { type: '1 | "1"', required: false, values: [1, "1"] },
      label: { type: "string", required: true, default: "button" },
      unsupported: { type: '"x" | string', required: false, default: "x" }
    })
  })

  test("keeps safe defaults through FC and forwardRef wrappers", async () => {
    writeFixture(
      "Wrapped.tsx",
      `import { forwardRef, type FC } from "react"
interface Props { tone?: "quiet" | "loud"; count?: 0 | 1 }
export const Badge: FC<Props> = ({ tone = "quiet" as const, count = +1 }) => <span />
export const Button = forwardRef<HTMLButtonElement, Props>(({ tone = "loud", count = 0 }, ref) => <button ref={ref} />)`
    )

    const { components } = await new CodebaseScanner(source()).scan()

    expect(components["Wrapped#Badge"]?.props).toEqual({
      tone: { type: '"quiet" | "loud"', required: false, values: ["loud", "quiet"], default: "quiet" },
      count: { type: "0 | 1", required: false, values: [0, 1], default: "1" }
    })
    expect(components["Wrapped#Button"]?.props).toEqual({
      tone: { type: '"quiet" | "loud"', required: false, values: ["loud", "quiet"], default: "loud" },
      count: { type: "0 | 1", required: false, values: [0, 1], default: "0" }
    })
  })

  test("omits incomplete domains and non-direct defaults", async () => {
    writeFixture(
      "Cases.tsx",
      `interface Props {
  single: "solo"
  orderA?: "b" | "a"
  orderB?: 2 | 1 | 2
  dynamic?: "x" | "y"
  nested?: "nested"
  computed?: "computed"
  rest?: "rest"
  unsupported?: "ok" | undefined
}

const dynamicDefault = "x"
const computedKey = "computed"
export function Cases({
  single = "solo",
  orderA = "a",
  orderB = 1,
  dynamic = dynamicDefault,
  nested: { value } = { value: "nested" },
  [computedKey]: computedValue = "computed",
  extra = "extra",
  ...restProps
}: Props) {
  return <div />
}`
    )

    const { components } = await new CodebaseScanner(source()).scan()

    expect(components.Cases?.props).toEqual({
      single: { type: '"solo"', required: true, values: ["solo"], default: "solo" },
      orderA: { type: '"b" | "a"', required: false, values: ["a", "b"], default: "a" },
      orderB: { type: "2 | 1 | 2", required: false, values: [1, 2], default: "1" },
      dynamic: { type: '"x" | "y"', required: false, values: ["x", "y"] },
      nested: { type: '"nested"', required: false, values: ["nested"] },
      computed: { type: '"computed"', required: false, values: ["computed"] },
      rest: { type: '"rest"', required: false, values: ["rest"] },
      unsupported: { type: '"ok" | undefined', required: false }
    })
  })

  test("omits defaults when a wrapper has multiple possible component callbacks", async () => {
    writeFixture(
      "Ambiguous.tsx",
      `interface Props { tone?: "quiet" | "loud" }
interface OtherProps { tone?: "wrong" }
declare function wrapper<T>(...callbacks: Array<(props: T) => unknown>): (props: T) => unknown

export const Ambiguous = wrapper<Props>(
  ({ tone = "wrong" }: OtherProps) => <aside>{tone}</aside>,
  ({ tone = "quiet" }: Props) => <button>{tone}</button>
)`
    )

    const { components } = await new CodebaseScanner(source()).scan()

    expect(components.Ambiguous?.props).toEqual({
      tone: { type: '"quiet" | "loud"', required: false, values: ["loud", "quiet"] }
    })
  })
})

describe("imported and composed component props", () => {
  test("resolves direct named interfaces, aliases, default declarations, and TS/TSX/index modules", async () => {
    writeFixture(
      "types.ts",
      `export interface NamedProps { label: string; size?: "sm" | "lg" }
export type AliasProps = { count: 0 | 1 }`
    )
    writeFixture("default.tsx", `export default interface DefaultProps { tone?: "quiet" | "loud" }`)
    writeFixture("folder/index.ts", `export interface FolderProps { active?: boolean }`)
    writeFixture(
      "Components.tsx",
      `import type { NamedProps as RenamedProps, AliasProps } from "./types"
import type DefaultProps from "./default"
import type { FolderProps } from "./folder"

export function Named(props: RenamedProps) { return <div /> }
export const Alias = (props: AliasProps) => <div />
export const Default = (props: DefaultProps) => <div />
export const Folder = (props: FolderProps) => <div />`
    )

    const { components } = await new CodebaseScanner(source()).scan()

    expect(components["Components#Named"]?.props).toEqual({
      label: { type: "string", required: true },
      size: { type: '"sm" | "lg"', required: false, values: ["lg", "sm"] }
    })
    expect(components["Components#Alias"]?.props).toEqual({
      count: { type: "0 | 1", required: true, values: [0, 1] }
    })
    expect(components["Components#Default"]?.props).toEqual({
      tone: { type: '"quiet" | "loud"', required: false, values: ["loud", "quiet"] }
    })
    expect(components["Components#Folder"]?.props).toEqual({
      active: { type: "boolean", required: false }
    })
  })

  test("resolves local barrels, export-star barrels, and multi-hop barrel chains", async () => {
    writeFixture("shared/base.ts", `export interface BaseProps { id: string; disabled?: boolean }`)
    writeFixture("shared/index.ts", `export * from "./base"`)
    writeFixture(
      "bridge.ts",
      `import type { BaseProps } from "./shared"
export type { BaseProps }`
    )
    writeFixture("ui/index.ts", `export { BaseProps as CardProps } from "../bridge"`)
    writeFixture(
      "Card.tsx",
      `import type { CardProps } from "./ui"
export function Card(props: CardProps) { return <article /> }`
    )

    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.Card?.props).toEqual({
      id: { type: "string", required: true },
      disabled: { type: "boolean", required: false }
    })
  })

  test("merges extensions and intersections, accepts identical duplicates, and handles Pick/Omit", async () => {
    writeFixture("base.ts", `export interface Base { id: string; tone?: "quiet" | "loud"; count?: 0 | 1 }`)
    writeFixture(
      "props.ts",
      `import type { Base } from "./base"
export interface Extended extends Base { label: string }
export type Picked = Pick<Extended, "id" | "label">
export type Omitted = Omit<Extended, "tone">
export type Duplicate = { id: string } & { id: string; label?: string }
export type Conflict = { id: string } & { id: number }`
    )
    writeFixture(
      "Composed.tsx",
      `import type { Extended, Picked, Omitted, Duplicate, Conflict } from "./props"
export const Extended = (props: Extended) => <div />
export const Picked = (props: Picked) => <div />
export const Omitted = (props: Omitted) => <div />
export const Duplicate = (props: Duplicate) => <div />
export const Conflict = (props: Conflict) => <div />`
    )

    const { components } = await new CodebaseScanner(source()).scan()
    expect(components["Composed#Extended"]?.props).toEqual({
      id: { type: "string", required: true },
      tone: { type: '"quiet" | "loud"', required: false, values: ["loud", "quiet"] },
      count: { type: "0 | 1", required: false, values: [0, 1] },
      label: { type: "string", required: true }
    })
    expect(components["Composed#Picked"]?.props).toEqual({
      id: { type: "string", required: true },
      label: { type: "string", required: true }
    })
    expect(components["Composed#Omitted"]?.props).toEqual({
      id: { type: "string", required: true },
      count: { type: "0 | 1", required: false, values: [0, 1] },
      label: { type: "string", required: true }
    })
    expect(components["Composed#Duplicate"]?.props).toEqual({
      id: { type: "string", required: true },
      label: { type: "string", required: false }
    })
    expect(components["Composed#Conflict"]?.props).toEqual({})
  })

  test("preserves FC and forwardRef wrappers, values, and direct defaults through imported types", async () => {
    writeFixture("props.ts", `export interface Props { tone?: "quiet" | "loud"; count?: 0 | 1 }`)
    writeFixture(
      "Wrapped.tsx",
      `import { forwardRef, type FC } from "react"
import type { Props } from "./props"
export const Badge: FC<Props> = ({ tone = "quiet", count = +1 }) => <span />
export const Button = forwardRef<HTMLButtonElement, Props>(({ tone = "loud", count = 0 }, ref) => <button ref={ref} />)`
    )

    const { components } = await new CodebaseScanner(source()).scan()
    expect(components["Wrapped#Badge"]?.props).toEqual({
      tone: { type: '"quiet" | "loud"', required: false, values: ["loud", "quiet"], default: "quiet" },
      count: { type: "0 | 1", required: false, values: [0, 1], default: "1" }
    })
    expect(components["Wrapped#Button"]?.props).toEqual({
      tone: { type: '"quiet" | "loud"', required: false, values: ["loud", "quiet"], default: "loud" },
      count: { type: "0 | 1", required: false, values: [0, 1], default: "0" }
    })
  })

  test("is independent of source/file enumeration order", async () => {
    const firstRoot = path.join(tempDir, "first")
    const secondRoot = path.join(tempDir, "second")
    const fixtures: Array<[string, string]> = [
      ["types.ts", `export interface Props { label: string; size?: "sm" | "lg" }`],
      ["Widget.tsx", `import type { Props } from "./types"\nexport function Widget(props: Props) { return <div /> }`]
    ]
    for (const [file, content] of fixtures) writeFixture(file, content, firstRoot)
    for (const [file, content] of [...fixtures].reverse()) writeFixture(file, content, secondRoot)

    const first = await new CodebaseScanner(source(firstRoot, ["**/*.tsx", "**/*.ts"])).scan()
    const second = await new CodebaseScanner(source(secondRoot, ["**/*.ts", "**/*.tsx"])).scan()
    expect(first.components).toEqual(second.components)
  })

  test("treats multiple matching relative modules as ambiguous", async () => {
    writeFixture("types.ts", `export interface Props { id: string }`)
    writeFixture("types/index.ts", `export interface Props { id: string }`)
    writeFixture(
      "Widget.tsx",
      `import type { Props } from "./types"
export function Widget(props: Props) { return <div /> }`
    )

    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.Widget?.props).toEqual({})
  })

  test("rejects explicitly unsupported relative module extensions", async () => {
    writeFixture("types.js.ts", `export interface Props { id: string }`)
    writeFixture(
      "Widget.tsx",
      `import type { Props } from "./types.js"
export function Widget(props: Props) { return <div /> }`
    )

    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.Widget).toBeDefined()
    expect(components.Widget?.props).toEqual({})
  })

  test("does not treat an export-star barrel as a default type re-export", async () => {
    writeFixture("types.ts", `export default interface Props { id: string }`)
    writeFixture("index.ts", `export * from "./types"`)
    writeFixture(
      "Widget.tsx",
      `import type Props from "./index"
export function Widget(props: Props) { return <div /> }`
    )

    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.Widget?.props).toEqual({})
  })

  test("ignores unrelated star exports but propagates nested barrel ambiguity", async () => {
    writeFixture("good.ts", `export interface Props { id: string }`)
    writeFixture("unrelated.ts", `export interface OtherProps { label: string }`)
    writeFixture("valid/index.ts", `export * from "../good"\nexport * from "../unrelated"`)
    writeFixture("a.ts", `export interface Props { id: string }`)
    writeFixture("b.ts", `export interface Props { id: number }`)
    writeFixture("ambiguous/index.ts", `export * from "../a"\nexport * from "../b"`)
    writeFixture("invalid/index.ts", `export * from "../ambiguous"\nexport * from "../good"`)
    writeFixture(
      "Components.tsx",
      `import type { Props as ValidProps } from "./valid"
import type { Props as InvalidProps } from "./invalid"
export function Valid(props: ValidProps) { return <div /> }
export function Invalid(props: InvalidProps) { return <div /> }`
    )

    const { components } = await new CodebaseScanner(source()).scan()
    expect(components["Components#Valid"]?.props).toEqual({ id: { type: "string", required: true } })
    expect(components["Components#Invalid"]?.props).toEqual({})
  })

  test("bounds deeply nested declaration graphs without throwing", async () => {
    const aliases = Array.from({ length: 70 }, (_, index) =>
      index === 69 ? `type P${index} = { id: string }` : `type P${index} = P${index + 1}`
    ).join("\n")
    writeFixture("types.ts", `${aliases}\nexport type Props = P0`)
    writeFixture(
      "Widget.tsx",
      `import type { Props } from "./types"
export function Widget(props: Props) { return <div /> }`
    )

    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.Widget).toBeDefined()
    expect(components.Widget?.props).toEqual({})
  })

  test.each([
    [
      "missing module",
      `import type { Props } from "./missing"\nexport function Widget(props: Props) { return <div /> }`,
      []
    ],
    [
      "missing export",
      `import type { Props } from "./types"\nexport function Widget(props: Props) { return <div /> }`,
      [`interface Props { id: string }`]
    ],
    [
      "package import",
      `import type { Props } from "some-package"\nexport function Widget(props: Props) { return <div /> }`,
      []
    ],
    [
      "path alias",
      `import type { Props } from "@/types"\nexport function Widget(props: Props) { return <div /> }`,
      [`export interface Props { id: string }`]
    ],
    [
      "namespace import",
      `import * as Types from "./types"\nexport function Widget(props: Types.Props) { return <div /> }`,
      [`export interface Props { id: string }`]
    ],
    [
      "unsupported utility",
      `import type { Props } from "./types"\nexport function Widget(props: Props) { return <div /> }`,
      [`export interface Base { id: string }\nexport type Props = Partial<Base>`]
    ],
    [
      "Pick with a missing key",
      `import type { Props } from "./types"\nexport function Widget(props: Props) { return <div /> }`,
      [`export interface Base { id: string }\nexport type Props = Pick<Base, "missing">`]
    ],
    [
      "unsupported generic",
      `import type { Props } from "./types"\nexport function Widget(props: Props<string>) { return <div /> }`,
      [`export interface Props<T> { value: T }`]
    ],
    [
      "partial composed failure",
      `import type { Props } from "./types"\nexport function Widget(props: Props) { return <div /> }`,
      [`export type Props = { id: string } & Missing`]
    ],
    [
      "unsupported package base",
      `import type { Props } from "./types"\nexport function Widget(props: Props) { return <div /> }`,
      [
        `import type { HTMLAttributes } from "react"\nexport interface Props extends HTMLAttributes<HTMLElement> { id: string }`
      ]
    ],
    [
      "barrel conflict",
      `import type { Props } from "./index"\nexport function Widget(props: Props) { return <div /> }`,
      [
        `export * from "./a"\nexport * from "./b"`,
        `export interface Props { id: string }`,
        `export interface Props { id: number }`
      ]
    ],
    [
      "cycle",
      `import type { Props } from "./a"\nexport function Widget(props: Props) { return <div /> }`,
      [
        `import type { Props as BProps } from "./b"\nexport type Props = BProps`,
        `import type { Props as AProps } from "./a"\nexport type Props = AProps`
      ]
    ]
  ] as Array<
    [string, string, string[]]
  >)("%s degrades to empty props without dropping the component", async (_name, component, support) => {
    writeFixture("Widget.tsx", component)
    if (_name === "barrel conflict") writeFixture("index.ts", support[0])
    if (_name === "barrel conflict") {
      writeFixture("a.ts", support[1])
      writeFixture("b.ts", support[2])
    } else if (_name === "cycle") {
      writeFixture("a.ts", support[0])
      writeFixture("b.ts", support[1])
    } else {
      for (const [index, content] of support.entries())
        writeFixture(index === 0 ? "types.ts" : `support-${index}.ts`, content)
    }
    const { components } = await new CodebaseScanner(source()).scan()
    expect(components.Widget).toBeDefined()
    expect(components.Widget?.props).toEqual({})
  })
})
