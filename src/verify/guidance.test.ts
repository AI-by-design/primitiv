import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildContract } from "../index"
import { verify } from "./verify"

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-guidance-verify-"))
  fs.writeFileSync(path.join(root, "Card.tsx"), "export const Card = () => <div />")
  writeConfig()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))
function writeConfig(rationale?: unknown) {
  fs.writeFileSync(
    path.join(root, "primitiv.config.js"),
    `module.exports = ${JSON.stringify({ sources: { codebase: { root: ".", patterns: ["*.tsx", "*.css"], ignore: [] } }, governance: { sourceOfTruth: "codebase", onConflict: "warn" }, output: { path: "contract.json" }, rationale })}`
  )
}
function sidecar(annotation: unknown) {
  fs.writeFileSync(path.join(root, "primitiv.rationale.yml"), JSON.stringify({ components: { Card: annotation } }))
}
async function save() {
  const contract = await buildContract(undefined, { silent: true, cwd: root })
  fs.writeFileSync(path.join(root, "contract.json"), JSON.stringify(contract))
  return contract
}
describe("guidance freshness", () => {
  test("classification-only and legacy rationale-only edits are semantic drift", async () => {
    sidecar({ why: "original", classification: { atomicLevel: "atom" } })
    await save()
    sidecar({ why: "original", classification: { atomicLevel: "molecule" } })
    expect((await verify(undefined, { cwd: root })).drift.changes).toEqual(["component classification changed: Card"])
    await save()
    sidecar({ why: "revised", classification: { atomicLevel: "molecule" } })
    expect((await verify(undefined, { cwd: root })).drift.changes).toEqual(["component rationale changed: Card"])
  })
  test("object key order, whitespace, and intent set order preserve semantic freshness", async () => {
    sidecar({
      why: "why",
      classification: { intents: ["input", "feedback"], atomicLevel: "atom" },
      examples: ["first", "second"]
    })
    await save()
    fs.writeFileSync(
      path.join(root, "primitiv.rationale.yml"),
      "components:\n  Card:\n    examples: [first, second]\n    classification:\n      atomicLevel: atom\n      intents: [feedback, input]\n    why: why\n"
    )
    expect((await verify(undefined, { cwd: root })).status).toBe("clean")
  })
  test("avoidance and example ordering remain meaningful", async () => {
    const annotation = { avoidWhen: [{ condition: "first" }, { condition: "second" }], examples: ["first", "second"] }
    sidecar(annotation)
    await save()
    sidecar({ ...annotation, avoidWhen: [...annotation.avoidWhen].reverse() })
    expect((await verify(undefined, { cwd: root })).drift.changes).toContain("component rationale changed: Card")
    await save()
    sidecar({ ...annotation, avoidWhen: [...annotation.avoidWhen].reverse(), examples: ["second", "first"] })
    expect((await verify(undefined, { cwd: root })).drift.changes).toContain("component rationale changed: Card")
  })
  test("inline edits and loss of selected sidecar evidence are reported", async () => {
    writeConfig({ inline: { components: { Card: { why: "before" } } } })
    await save()
    writeConfig({ inline: { components: { Card: { why: "after" } } } })
    expect((await verify(undefined, { cwd: root })).status).toBe("stale")
    writeConfig()
    sidecar({ why: "sidecar" })
    await save()
    fs.unlinkSync(path.join(root, "primitiv.rationale.yml"))
    const result = await verify(undefined, { cwd: root })
    expect(result.drift.changes).toContain("guidance health changed")
    expect(result.status).toBe("stale")
  })
  test("invalid guidance is warn-and-continue but never verified fresh, strict exits 2", async () => {
    sidecar({ classification: { atomicLevel: "invalid" } })
    await save()
    const result = await verify(undefined, { cwd: root })
    expect(result.status).toBe("guidance-unverified")
    expect(result.exitCode).toBe(0)
    expect(result.guidanceVerified).toBe(false)
    expect(result.messages.join("\n")).not.toContain("Contract is fresh")
    expect((await verify(undefined, { cwd: root, strict: true })).exitCode).toBe(2)
  })
  test.each([
    42,
    0,
    false,
    null
  ])("malformed selected-path metadata %s preserves scanning and produces unverified evidence", async (value) => {
    writeConfig({ path: value })
    const result = await save()
    expect(result.components.Card).toBeDefined()
    expect(result.guidanceHealth?.sources[0]).toMatchObject({ readState: "invalid", complete: false })
    for (const fast of [false, true])
      expect((await verify(undefined, { cwd: root, fast })).status).toBe("guidance-unverified")
  })
  test("an empty configured path retains the legacy default-sidecar fallback", async () => {
    writeConfig({ path: "" })
    const result = await save()
    expect(result.guidanceHealth?.sources[0]).toMatchObject({
      sourceId: "sidecar:primitiv.rationale.yml",
      selection: "default",
      readState: "absent"
    })
    expect((await verify(undefined, { cwd: root, fast: true })).status).toBe("clean")
  })
  test("malformed health and reached guidance fields refuse before comparison", async () => {
    for (const value of [
      { classification: { atomicLevel: "unknown" } },
      { rationale: { avoidWhen: [null] } },
      { guidanceOrigin: { sourceId: 1 } }
    ]) {
      const contract = await save()
      Object.assign(contract.components.Card, value)
      fs.writeFileSync(path.join(root, "contract.json"), JSON.stringify(contract))
      expect((await verify(undefined, { cwd: root })).status).toBe("invalid-contract")
    }
    const contract = await save()
    if (contract.guidanceHealth) contract.guidanceHealth.total = 2
    fs.writeFileSync(path.join(root, "contract.json"), JSON.stringify(contract))
    for (const fast of [false, true])
      expect((await verify(undefined, { cwd: root, fast })).status).toBe("invalid-contract")
  })
  test("token guidance preserves opaque legacy extensions and ordered extension arrays", async () => {
    fs.writeFileSync(path.join(root, "tokens.css"), ":root { --color-primary: #000; }")
    const tokenGuidance = { why: 42, intents: ["second", "first"], extension: { nested: "kept" } }
    fs.writeFileSync(
      path.join(root, "primitiv.rationale.yml"),
      JSON.stringify({ tokens: { "colors.color-primary": tokenGuidance } })
    )
    const saved = await save()
    expect(saved.tokens.colors["color-primary"].rationale).toEqual(tokenGuidance)
    expect((await verify(undefined, { cwd: root })).status).toBe("clean")
    fs.writeFileSync(
      path.join(root, "primitiv.rationale.yml"),
      JSON.stringify({ tokens: { "colors.color-primary": { ...tokenGuidance, intents: ["first", "second"] } } })
    )
    expect((await verify(undefined, { cwd: root })).drift.changes).toContain(
      "token rationale changed: colors.color-primary"
    )
  })
  test("fast checks configured sidecar modifications/deletion and configuration changes", async () => {
    writeConfig({ path: "selected.json" })
    fs.writeFileSync(path.join(root, "selected.json"), JSON.stringify({ components: { Card: { why: "before" } } }))
    await save()
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(path.join(root, "selected.json"), future, future)
    expect((await verify(undefined, { cwd: root, fast: true })).drift.changes).toContain(
      "selected guidance file modified or added"
    )
    await save()
    fs.unlinkSync(path.join(root, "selected.json"))
    expect((await verify(undefined, { cwd: root, fast: true })).drift.changes).toContain(
      "selected guidance file missing or deleted"
    )
    writeConfig()
    await save()
    fs.utimesSync(path.join(root, "primitiv.config.js"), future, future)
    expect((await verify(undefined, { cwd: root, fast: true })).drift.changes).toContain("guidance config modified")
  })
  test("fast cannot prove legacy unknown health, inline dependency coverage, or an external selected path", async () => {
    const contract = await save()
    delete contract.guidanceHealth
    fs.writeFileSync(path.join(root, "contract.json"), JSON.stringify(contract))
    const legacy = await verify(undefined, { cwd: root, fast: true })
    expect(legacy.status).toBe("guidance-unverified")
    expect(legacy.exitCode).toBe(0)
    expect((await verify(undefined, { cwd: root, fast: true, strict: true })).exitCode).toBe(2)
    writeConfig({ inline: { components: { Card: {} } } })
    await save()
    expect((await verify(undefined, { cwd: root, fast: true })).status).toBe("guidance-unverified")
    writeConfig({ path: "../external-guidance.json" })
    await save()
    expect((await verify(undefined, { cwd: root, fast: true })).guidanceVerified).toBe(false)
  })
  test.each(["leaf", "parent"])("fast declines external %s symlinks even with old target mtimes", async (kind) => {
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-external-guidance-"))
    try {
      const target = path.join(external, "guidance.json")
      fs.writeFileSync(target, JSON.stringify({ components: { Card: { why: "external" } } }))
      const old = new Date(Date.now() - 60_000)
      fs.utimesSync(target, old, old)
      const selected = kind === "leaf" ? "linked.json" : "linked/guidance.json"
      fs.symlinkSync(kind === "leaf" ? target : external, path.join(root, kind === "leaf" ? "linked.json" : "linked"))
      writeConfig({ path: selected })
      await save()
      expect((await verify(undefined, { cwd: root })).status).toBe("clean")
      const fast = await verify(undefined, { cwd: root, fast: true })
      expect(fast.status).toBe("guidance-unverified")
      expect(fast.guidanceVerified).toBe(false)
      expect(fast.drift.isStale).toBe(false)
      expect((await verify(undefined, { cwd: root, fast: true, strict: true })).exitCode).toBe(2)
    } finally {
      fs.rmSync(external, { recursive: true, force: true })
    }
  })
  test("fast loads configuration once even while inspecting inline guidance freshness", async () => {
    const configPath = path.join(root, "primitiv.config.js")
    writeConfig({ inline: { components: { Card: {} } } })
    fs.appendFileSync(configPath, '\nrequire("node:fs").appendFileSync(__dirname + "/loads.txt", "load\\n")')
    await save()
    fs.writeFileSync(path.join(root, "loads.txt"), "")
    await verify(undefined, { cwd: root, fast: true })
    expect(fs.readFileSync(path.join(root, "loads.txt"), "utf8")).toBe("load\n")
  })
})
