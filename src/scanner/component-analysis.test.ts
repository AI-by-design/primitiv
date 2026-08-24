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
