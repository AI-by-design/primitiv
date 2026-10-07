import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { writeAgentInstructions, writeSkillFile } from "./init"

let root: string
const relative = ".claude/commands/build-component.md"
const template = fs.readFileSync(path.join(__dirname, "../../skills/build-component.md"), "utf8")
const old = fs.readFileSync(path.join(__dirname, "fixtures/build-component-v2.20.0.md"), "utf8")
const inlineOld = fs.readFileSync(path.join(__dirname, "fixtures/build-component-v1.10.0.md"), "utf8")
const hash = (content: string) => createHash("sha256").update(content).digest("hex")
const target = () => path.join(root, relative)
const metadata = () => `${target()}.primitiv.json`

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "primitiv-skill-test-"))
  fs.mkdirSync(path.dirname(target()), { recursive: true })
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe("managed skill refresh", () => {
  test("fresh installation records shipped version and exact hash, and repeated init is stable", () => {
    writeSkillFile(root)
    expect(fs.readFileSync(target(), "utf8")).toBe(template)
    expect(JSON.parse(fs.readFileSync(metadata(), "utf8"))).toEqual({
      template: "build-component",
      templateVersion: "3",
      sha256: hash(template)
    })
    const first = fs.statSync(target()).mtimeMs
    const firstMetadata = fs.statSync(metadata()).mtimeMs
    writeSkillFile(root)
    expect(fs.statSync(target()).mtimeMs).toBe(first)
    expect(fs.statSync(metadata()).mtimeMs).toBe(firstMetadata)
  })

  test.each([
    ["external", old],
    ["inline", inlineOld]
  ])("exact shipped %s old bytes refresh without provenance", (_delivery, prior) => {
    fs.writeFileSync(target(), prior)
    writeSkillFile(root)
    expect(fs.readFileSync(target(), "utf8")).toBe(template)
    expect(fs.readdirSync(path.dirname(target())).some((file) => file.includes("backup"))).toBe(false)
  })

  test.each([
    ["customized", `${old}\n# Project-specific instructions\n`],
    ["unknown", "# Handwritten component instructions"]
  ])("%s template is preserved, with a stable reviewable patch and explicit backed-up refresh", (_name, original) => {
    fs.writeFileSync(target(), original)
    writeSkillFile(root)
    expect(fs.readFileSync(target(), "utf8")).toBe(original)
    expect(fs.existsSync(metadata())).toBe(false)
    const candidate = `${target()}.primitiv-${hash(template).slice(0, 12)}.md`
    const diff = `${candidate}.diff`
    expect(fs.readFileSync(candidate, "utf8")).toBe(template)
    // Validate the actual review artifact rather than matching markdown phrases.
    execFileSync("patch", ["--dry-run", "--batch", "-p0", "-i", diff], { cwd: root })
    const diffMtime = fs.statSync(diff).mtimeMs
    const files = fs.readdirSync(path.dirname(target()))
    writeSkillFile(root)
    expect(fs.statSync(diff).mtimeMs).toBe(diffMtime)
    expect(fs.readdirSync(path.dirname(target()))).toEqual(files)

    writeSkillFile(root, { refreshSkill: true })
    expect(fs.readFileSync(target(), "utf8")).toBe(template)
    expect(fs.readFileSync(`${target()}.backup-${hash(original)}`, "utf8")).toBe(original)
    writeSkillFile(root, { refreshSkill: true })
    expect(fs.readdirSync(path.dirname(target())).filter((file) => file.includes("backup"))).toHaveLength(1)
  })

  test("forged metadata cannot authorize replacement of modified bytes", () => {
    const custom = `${old}\nKeep this change\n`
    fs.writeFileSync(target(), custom)
    fs.writeFileSync(
      metadata(),
      JSON.stringify({ template: "build-component", templateVersion: "2", sha256: hash(custom) })
    )
    writeSkillFile(root)
    expect(fs.readFileSync(target(), "utf8")).toBe(custom)
  })

  test("explicit backup preserves arbitrary original bytes", () => {
    const bytes = Buffer.from([0xff, 0x0a, 0xfe])
    fs.writeFileSync(target(), bytes)
    writeSkillFile(root, { refreshSkill: true })
    const backup = fs.readdirSync(path.dirname(target())).find((file) => file.includes("backup"))
    if (!backup) throw new Error("expected skill backup")
    expect(fs.readFileSync(path.join(path.dirname(target()), backup)).equals(bytes)).toBe(true)
  })
})

describe("owned agent instruction blocks", () => {
  test("preserves exact surrounding bytes, including blank lines and dollar replacements", () => {
    const prefix = "# My notes\n\n\nKeep $& and $` and $'\n\n"
    const suffix = "\n\n\n## User-owned footer\n"
    const file = path.join(root, "AGENTS.md")
    fs.writeFileSync(file, `${prefix}<!-- primitiv -->\nold\n<!-- /primitiv -->${suffix}`)
    writeAgentInstructions(root)
    const after = fs.readFileSync(file, "utf8")
    expect(after.slice(0, after.indexOf("<!-- primitiv -->"))).toBe(prefix)
    expect(after.slice(after.indexOf("<!-- /primitiv -->") + "<!-- /primitiv -->".length)).toBe(suffix)
    writeAgentInstructions(root)
    expect(fs.readFileSync(file, "utf8")).toBe(after)
  })

  test("leaves an incomplete user marker untouched", () => {
    const original = "# Project\n<!-- primitiv -->\nCustom incomplete block\n"
    const file = path.join(root, "AGENTS.md")
    fs.writeFileSync(file, original)
    writeAgentInstructions(root)
    expect(fs.readFileSync(file, "utf8")).toBe(original)
  })
})
