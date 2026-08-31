import { describe, expect, test } from "bun:test"
import { parse } from "@babel/parser"
import type * as t from "@babel/types"
import {
  buildStaticBindings,
  evaluateStaticObject,
  evaluateStaticValue,
  type StaticObject,
  type StaticValue
} from "./staticValue"

function program(source: string) {
  return parse(source, { sourceType: "module", plugins: ["typescript", "jsx"] }).program
}

function expression(source: string) {
  const parsed = parse(`const value = ${source}`, { sourceType: "module", plugins: ["typescript"] }).program
  const declaration = parsed.body[0]
  if (declaration.type !== "VariableDeclaration") throw new Error("fixture did not produce a declaration")
  return declaration.declarations[0].init
}

function objectExpression(source: string): t.ObjectExpression {
  const value = expression(source)
  if (!value || value.type !== "ObjectExpression") throw new Error("fixture did not produce an object")
  return value
}

function evaluate(source: string, input?: Parameters<typeof evaluateStaticValue>[1]) {
  const parsed = program(`const value = ${source}`)
  const declaration = parsed.body[0]
  if (declaration.type !== "VariableDeclaration" || !declaration.declarations[0].init)
    throw new Error("fixture did not produce a declaration")
  if (input && "type" in input && input.type === "Program")
    return evaluateStaticValue(declaration.declarations[0].init, input)
  return evaluateStaticValue(declaration.declarations[0].init, {
    bindings: buildStaticBindings(parsed),
    ...(input ?? {})
  })
}

describe("static Storybook value evaluation", () => {
  test("resolves supported literals, wrappers, signed numbers, and templates", () => {
    expect(evaluate("null").value).toBeNull()
    expect(evaluate("'hello'").value).toBe("hello")
    expect(evaluate("-4").value).toBe(-4)
    expect(evaluate("+4.5").value).toBe(4.5)
    expect(evaluate("`hello world`").value).toBe("hello world")
    expect(evaluate("`hello " + "${" + "name}`").status).toBe("unresolved")
    expect(evaluate("(true as boolean)!").value).toBe(true)
  })

  test("resolves immutable local consts and rejects reassigned or imported bindings", () => {
    const parsed = program(`
      import { external } from "./external"
      const label = "Primary"
      const args = { label, count: -2 }
      let mutable = "nope"
      mutable = "still nope"
      const imported = external
    `)
    const args = parsed.body.find(
      (statement): statement is (typeof parsed.body)[number] & { type: "VariableDeclaration" } =>
        statement.type === "VariableDeclaration" &&
        statement.declarations.some(
          (declaration) => declaration.id.type === "Identifier" && declaration.id.name === "args"
        )
    )
    if (!args || args.type !== "VariableDeclaration") throw new Error("args declaration missing")
    const init = args.declarations.find(
      (declaration) => declaration.id.type === "Identifier" && declaration.id.name === "args"
    )?.init
    expect(init).toBeDefined()
    const result = evaluateStaticValue(init, parsed)
    expect(result.status).toBe("resolved")
    expect((result.value as StaticObject).label).toBe("Primary")
    expect((result.value as StaticObject).count).toBe(-2)
    expect(evaluate("mutable", parsed).status).toBe("unresolved")
    expect(evaluate("imported", parsed).status).toBe("unresolved")
  })

  test("rejects const object bindings whose members are mutated", () => {
    const parsed = program(`
      const updated = { nested: { count: 1 } }
      updated.nested.count++
      const deleted = { safe: true }
      delete deleted.safe
    `)

    expect(buildStaticBindings(parsed).has("updated")).toBe(false)
    expect(buildStaticBindings(parsed).has("deleted")).toBe(false)
  })

  test("resolves exported top-level const bindings", () => {
    const parsed = program(`export const options = ["one", "two"]; const args = { options }`)
    const declaration = parsed.body[1]
    if (declaration.type !== "VariableDeclaration") throw new Error("args declaration missing")
    const result = evaluateStaticValue(declaration.declarations[0].init, parsed)
    expect(result).toMatchObject({ status: "resolved", value: { options: ["one", "two"] } })
  })

  test("keeps object values null-prototype and applies ordered overwrite semantics", () => {
    const result = evaluateStaticObject(
      objectExpression(`{ __proto__: 1, constructor: 2, ...{ a: 1, b: 2 }, a: 3, b: choose() }`)
    )
    expect(result.status).toBe("unresolved")
    expect(Object.getPrototypeOf(result.value)).toBeNull()
    expect(Reflect.getOwnPropertyDescriptor(result.value, "__proto__")).toBeDefined()
    expect(result.value?.__proto__).toBe(1)
    expect(result.value?.a).toBe(3)
    expect(result.value?.b).toBeUndefined()
    expect(result.unresolvedKeys).toEqual(["b"])
    expect(result.truncatedKeys).toEqual([])
  })

  test("a later static property supersedes earlier unresolved or truncated writes", () => {
    const unresolved = evaluateStaticObject(objectExpression(`{ value: choose(), value: "known" }`))
    expect(unresolved.status).toBe("resolved")
    expect(unresolved.value?.value).toBe("known")
    expect(unresolved.unresolvedKeys).toEqual([])

    const truncated = evaluateStaticObject(objectExpression(`{ value: [1, 2, 3], value: true }`), { maxEntries: 2 })
    expect(truncated.value?.value).toBe(true)
    expect(truncated.unresolvedKeys).toEqual([])
    expect(truncated.truncatedKeys).toEqual([])
  })

  test("does not leak partially dynamic nested objects", () => {
    const result = evaluateStaticObject(objectExpression(`{ nested: { good: true, bad: call() }, okay: false }`))
    expect(result.status).toBe("unresolved")
    expect(result.value?.nested).toBeUndefined()
    expect(result.value?.okay).toBe(false)
    expect(result.unresolvedKeys).toEqual(["nested"])
  })

  test("marks uncertain spreads and retains explicitly proven writes after them", () => {
    const result = evaluateStaticObject(objectExpression(`{ before: true, ...getArgs(), after: "safe" }`))
    expect(result.status).toBe("unresolved")
    expect(result.hasUnresolvedSpread).toBe(true)
    expect(result.value?.before).toBeUndefined()
    expect(result.value?.after).toBe("safe")
  })

  test("clears earlier values when an unknown computed key may overwrite them", () => {
    const result = evaluateStaticObject(objectExpression(`{ safe: true, [key]: false, after: "safe" }`))
    expect(result.status).toBe("unresolved")
    expect(result.value?.safe).toBeUndefined()
    expect(result.value?.after).toBe("safe")
    expect(result.hasUnresolvedSpread).toBe(true)
  })

  test("caps aggregate object keys from static spreads deterministically", () => {
    const result = evaluateStaticObject(
      objectExpression(`{
        ...{ b: 2, a: 1 },
        ...{ d: 4, c: 3 }
      }`),
      { maxEntries: 3 }
    )
    expect(result.status).toBe("truncated")
    expect(Object.keys(result.value ?? {})).toEqual(["a", "b", "c"])
    expect(result.truncatedKeys).toEqual(["d"])
  })

  test("bounds immutable binding recursion instead of overflowing the stack", () => {
    const aliases = Array.from({ length: 66 }, (_, index) =>
      index === 65 ? `const value${index} = true` : `const value${index} = value${index + 1}`
    ).join("\n")
    const parsed = program(aliases)
    const first = parsed.body[0]
    if (first.type !== "VariableDeclaration" || !first.declarations[0].init)
      throw new Error("first binding declaration missing")
    expect(evaluateStaticValue(first.declarations[0].init, parsed).status).toBe("truncated")

    const short = program(`const first = second; const second = third; const third = true`)
    const shortFirst = short.body[0]
    if (shortFirst.type !== "VariableDeclaration" || !shortFirst.declarations[0].init)
      throw new Error("short binding declaration missing")
    expect(evaluateStaticValue(shortFirst.declarations[0].init, short)).toEqual({ status: "resolved", value: true })
  })

  test("canonicalizes nested object keys for deterministic serialization", () => {
    const first = evaluate("{ nested: { b: 2, a: 1 } }")
    const second = evaluate("{ nested: { a: 1, b: 2 } }")
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value))
    expect(Object.keys((first.value as StaticObject).nested as StaticObject)).toEqual(["a", "b"])
  })

  test("preserves known diagnostics through statically keyed object spreads", () => {
    const parsed = program(`
      const base = { known: 1, dynamic: choose() }
      const args = { inherited: true, ...base, after: false }
    `)
    const declaration = parsed.body[1]
    if (declaration.type !== "VariableDeclaration") throw new Error("args declaration missing")
    const init = declaration.declarations[0].init
    if (!init || init.type !== "ObjectExpression") throw new Error("args object missing")
    const result = evaluateStaticObject(init, parsed)
    expect(result.value).toEqual({ after: false, inherited: true, known: 1 })
    expect(result.unresolvedKeys).toEqual(["dynamic"])
    expect(result.hasUnresolvedSpread).toBe(false)
  })

  test("does not promote nested block bindings and treats computed keys as unknown overwrite evidence", () => {
    const parsed = program(`
      { const nested = "not module-wide" }
      const safe = "module-wide"
    `)
    expect(buildStaticBindings(parsed).has("nested")).toBe(false)
    expect(evaluate("nested", parsed).status).toBe("unresolved")
    const computed = evaluateStaticObject(objectExpression(`{ safe: true, [key]: false }`))
    expect(computed.status).toBe("unresolved")
    expect(computed.hasUnresolvedSpread).toBe(true)
  })

  test("rejects calls, members, methods, computed keys, and non-finite numbers", () => {
    for (const source of [
      "call()",
      "thing.value",
      "() => true",
      "{ get value() { return true } }",
      "{ [key]: true }",
      "Infinity"
    ]) {
      expect(evaluate(source).status).toBe("unresolved")
    }
    expect(evaluate("[true, call()]").status).toBe("unresolved")
  })

  test("returns truncation for depth, collection, and serialized-size limits", () => {
    expect(evaluate("{ a: { b: { c: { d: { e: { f: true } } } } } }").status).toBe("truncated")
    expect(evaluate("[1, 2, 3]", { maxEntries: 2 }).status).toBe("truncated")
    expect(evaluate("'123456'", { maxBytes: 5 }).status).toBe("truncated")
  })
})

// Keep the local union exercised in this file: this also documents the shape
// that a later CSF parser can safely pass through.
const _staticValueTypeCheck: StaticValue | undefined = undefined
void _staticValueTypeCheck
