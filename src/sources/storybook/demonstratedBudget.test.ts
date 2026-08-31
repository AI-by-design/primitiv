import { describe, expect, test } from "bun:test"
import { boundDemonstratedEvidence } from "./demonstratedBudget"

describe("boundDemonstratedEvidence", () => {
  test("retains canonical args and marks values omitted by the aggregate budget", () => {
    const bounded = boundDemonstratedEvidence(
      {
        title: "Button",
        extraction: "source",
        storyCount: 1,
        defaultArgs: { z: "z".repeat(100), a: 1 },
        stories: [{ id: "button--primary", args: { label: "Primary" } }]
      },
      180
    )

    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(180)
    expect(bounded.defaultArgs).toEqual({ a: 1 })
    expect(bounded.truncatedDefaultArgs).toContain("z")
  })

  test("caps story identities when the aggregate budget is exhausted", () => {
    const bounded = boundDemonstratedEvidence(
      {
        title: "Button",
        extraction: "source",
        storyCount: 3,
        stories: [
          { id: `button--${"a".repeat(60)}` },
          { id: `button--${"b".repeat(60)}` },
          { id: `button--${"c".repeat(60)}` }
        ]
      },
      210
    )

    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(210)
    expect(bounded.stories?.length ?? 0).toBeLessThan(3)
    expect(bounded.truncatedStories).toBe(true)
  })

  test("keeps previously retained stories when the next identity exceeds the budget", () => {
    const bounded = boundDemonstratedEvidence(
      {
        title: "Button",
        extraction: "source",
        storyCount: 3,
        stories: [{ id: "button--one" }, { id: "button--two" }, { id: `button--${"z".repeat(100)}` }]
      },
      180
    )

    expect(bounded.stories?.map((story) => story.id)).toEqual(["button--one", "button--two"])
    expect(Buffer.byteLength(JSON.stringify(bounded), "utf8")).toBeLessThanOrEqual(180)
  })

  test("uses name and import path as deterministic story tie-breakers", () => {
    const input = {
      title: "Button",
      extraction: "source" as const,
      storyCount: 2,
      stories: [
        { id: "button--same", exportName: "Same", name: "Zed", importPath: "./z.stories.ts" },
        { id: "button--same", exportName: "Same", name: "Alpha", importPath: "./a.stories.ts" }
      ]
    }

    const forward = boundDemonstratedEvidence(input)
    const reverse = boundDemonstratedEvidence({ ...input, stories: [...input.stories].reverse() })

    expect(forward).toEqual(reverse)
    expect(forward.stories?.map(({ name, importPath }) => ({ name, importPath }))).toEqual([
      { name: "Alpha", importPath: "./a.stories.ts" },
      { name: "Zed", importPath: "./z.stories.ts" }
    ])
  })
})
