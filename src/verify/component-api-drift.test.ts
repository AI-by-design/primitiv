import { describe, expect, test } from "bun:test"
import { boundDemonstratedEvidence } from "../sources/storybook/demonstratedBudget"
import type { Component, ComponentMap, PrimitivContract } from "../types"
import { compareComponentApi, formatComponentFieldPath } from "./component-api-drift"

function component(overrides: Partial<Component> = {}): Component {
  return { name: "Button", source: { adapter: "codebase", file: "Button.tsx" }, ...overrides }
}

function contract(value: Component, id = "components/Button"): PrimitivContract {
  const components = Object.create(null) as ComponentMap
  Object.defineProperty(components, id, { value, enumerable: true, configurable: true, writable: true })
  return {
    version: "1",
    generatedAt: "2026-01-01T00:00:00Z",
    sources: [],
    sourceRoot: ".",
    configPath: "config.js",
    tokens: { colors: {}, spacing: {}, typography: {}, borderRadius: {}, shadows: {} },
    components,
    conflicts: []
  }
}

function compare(oldComponent: Component, newComponent: Component, id = "components/Button") {
  return compareComponentApi({
    committed: contract(oldComponent, id),
    fresh: contract(newComponent, id),
    pairs: [{ committedId: id, freshId: id }],
    failedSources: new Set()
  })
}

describe("component API drift", () => {
  test("formats ordinary segments and quotes punctuation-bearing and opaque keys", () => {
    expect(formatComponentFieldPath(["props", "size", "required"])).toBe("props.size.required")
    expect(formatComponentFieldPath(["demonstrated", "stories", "ui-button--primary", "args", "a.b"])).toBe(
      'demonstrated.stories["ui-button--primary"].args["a.b"]'
    )
    expect(formatComponentFieldPath(["props", "__proto__", "values"])).toBe("props.__proto__.values")
  })

  test("compares every formal field with typed set equality", () => {
    const oldValue = component({
      props: {
        size: {
          type: "string",
          required: false,
          default: "sm",
          values: [0, "0", false],
          kind: "variant",
          preferredValues: [{ type: "component", key: "a" }]
        }
      }
    })
    const reordered = component({
      props: {
        size: {
          type: "string",
          required: false,
          default: "sm",
          values: [false, "0", 0, false],
          kind: "variant",
          preferredValues: [
            { type: "component", key: "a" },
            { type: "component", key: "a" }
          ]
        }
      }
    })
    expect(compare(oldValue, reordered)).toEqual([])

    const changed = component({
      props: {
        size: {
          type: "number",
          required: true,
          default: "md",
          values: ["0"],
          kind: "text",
          preferredValues: [{ type: "component-set", key: "a" }]
        }
      }
    })
    const result = compare(oldValue, changed)
    expect(result).toHaveLength(6)
    expect(result).toContain("component field changed: components/Button props.size.required (false → true)")
    expect(result.find((line) => line.includes("props.size.values"))).toContain('[false,0,"0"]')
  })

  test("uses own opaque prop keys and renders their paths safely", () => {
    const oldProps = Object.create(null) as NonNullable<Component["props"]>
    const newProps = Object.create(null) as NonNullable<Component["props"]>
    Object.defineProperty(oldProps, "constructor", { value: { required: false }, enumerable: true })
    Object.defineProperty(newProps, "constructor", { value: { required: true }, enumerable: true })
    Object.defineProperty(newProps, "a/b", { value: { type: "string" }, enumerable: true })
    expect(compare(component({ props: oldProps }), component({ props: newProps }))).toEqual([
      'component prop added: components/Button props["a/b"]',
      "component field changed: components/Button props.constructor.required (false → true)"
    ])

    const addedOpaque = Object.create(null) as NonNullable<Component["props"]>
    Object.defineProperty(addedOpaque, "__proto__", { value: { type: "string" }, enumerable: true })
    Object.defineProperty(addedOpaque, "constructor", { value: { type: "string" }, enumerable: true })
    expect(compare(component({ props: {} }), component({ props: addedOpaque }))).toEqual([
      "component prop added: components/Button props.__proto__",
      "component prop added: components/Button props.constructor"
    ])
    expect(compare(component({ props: addedOpaque }), component({ props: {} }))).toEqual([
      "component prop removed: components/Button props.__proto__",
      "component prop removed: components/Button props.constructor"
    ])
  })

  test("reports directional observed values only when the proving side is complete", () => {
    const oldValue = component({ usage: { sites: 1, props: { tone: [false, 0, "0"] }, truncatedProps: ["tone"] } })
    const newValue = component({ usage: { sites: 1, props: { tone: [true, 0] } } })
    expect(compare(oldValue, newValue)).toEqual([
      "component observed value removed: components/Button usage.props.tone (false)",
      'component observed value removed: components/Button usage.props.tone ("0")',
      "component evidence added: components/Button usage.props.tone"
    ])
  })

  test("compares demonstrated values structurally and ignores presentation fields", () => {
    const oldValue = component({
      demonstrated: {
        title: "UI/Button",
        extraction: "source",
        storyCount: 1,
        defaultArgs: { config: { b: 2, a: [1, 2] } },
        stories: [
          {
            id: "ui-button--primary",
            name: "Old",
            args: { size: "sm" },
            controls: {
              tone: {
                control: "select",
                choices: [{ option: "a", mappedValue: { dark: true, n: 1 } }, { option: "b" }]
              }
            }
          }
        ]
      }
    })
    const reordered = component({
      demonstrated: {
        title: "Other label",
        extraction: "source",
        storyCount: 1,
        defaultArgs: { config: { a: [1, 2], b: 2 } },
        stories: [
          {
            id: "ui-button--primary",
            name: "New",
            exportName: "Primary",
            args: { size: "sm" },
            controls: {
              tone: { control: "radio", choices: [{ option: "b" }, { option: "a", mappedValue: { n: 1, dark: true } }] }
            }
          }
        ]
      }
    })
    expect(compare(oldValue, reordered)).toEqual([])

    const changed = structuredClone(reordered)
    if (!changed.demonstrated?.stories?.[0]) throw new Error("invalid test fixture")
    changed.demonstrated.defaultArgs = { config: { a: [2, 1], b: 2 } }
    changed.demonstrated.stories[0].args = { size: "lg" }
    expect(compare(oldValue, changed)).toEqual([
      expect.stringContaining("demonstrated.defaultArgs.config"),
      'component field changed: components/Button demonstrated.stories["ui-button--primary"].args.size ("sm" → "lg")'
    ])
  })

  test("turns per-field unknown and mapping uncertainty into availability changes", () => {
    const oldValue = component({
      demonstrated: {
        title: "Button",
        extraction: "source",
        storyCount: 0,
        defaultArgs: { safe: 1, unknown: 2 },
        controls: { tone: { choices: [{ option: "a", mappedValue: "x" }] } }
      }
    })
    const newValue = component({
      demonstrated: {
        title: "Button",
        extraction: "source",
        storyCount: 0,
        defaultArgs: { safe: 2 },
        unresolvedDefaultArgs: ["unknown"],
        controls: { tone: { choices: [{ option: "a", mappingUnresolved: true }] } }
      }
    })
    expect(compare(oldValue, newValue)).toEqual([
      "component field changed: components/Button demonstrated.defaultArgs.safe (1 → 2)",
      "component evidence unavailable: components/Button demonstrated.defaultArgs.unknown",
      'component evidence unavailable: components/Button demonstrated.controls.tone.choices["string:\\"a\\""]' +
        ".mappedValue"
    ])
  })

  test("applies directional completeness to bounded control choices", () => {
    const oldValue = component({
      demonstrated: {
        title: "Button",
        extraction: "source",
        storyCount: 0,
        controls: { tone: { choices: [{ option: "a" }], truncatedChoices: true } }
      }
    })
    const newValue = component({
      demonstrated: {
        title: "Button",
        extraction: "source",
        storyCount: 0,
        controls: { tone: { choices: [{ option: "a" }, { option: "b" }] } }
      }
    })
    expect(compare(oldValue, newValue)).toEqual([
      "component evidence added: components/Button demonstrated.controls.tone.choices"
    ])

    const completeOld = component({
      demonstrated: {
        title: "Button",
        extraction: "source",
        storyCount: 0,
        controls: { tone: { choices: [{ option: "a" }] } }
      }
    })
    const truncatedNew = component({
      demonstrated: {
        title: "Button",
        extraction: "source",
        storyCount: 0,
        controls: { tone: { choices: [{ option: "a" }, { option: "b" }], truncatedChoices: true } }
      }
    })
    expect(compare(completeOld, truncatedNew)).toEqual([
      'component demonstrated choice added: components/Button demonstrated.controls.tone.choices ("b")',
      "component evidence unavailable: components/Button demonstrated.controls.tone.choices"
    ])
    expect(
      compare(
        component({
          demonstrated: {
            ...oldValue.demonstrated,
            controls: { tone: { choices: [{ option: "a" }], truncatedChoices: true } }
          }
        }),
        component({
          demonstrated: {
            ...oldValue.demonstrated,
            controls: { tone: { choices: [{ option: "b" }], truncatedChoices: true } }
          }
        })
      )
    ).toEqual([])

    const choices = (values: string[], truncated: boolean) =>
      component({
        demonstrated: {
          title: "Button",
          extraction: "source",
          storyCount: 0,
          controls: {
            tone: { choices: values.map((option) => ({ option })), ...(truncated ? { truncatedChoices: true } : {}) }
          }
        }
      })
    expect(compare(choices(["a", "b"], true), choices(["a"], false))).toEqual([
      'component demonstrated choice removed: components/Button demonstrated.controls.tone.choices ("b")',
      "component evidence added: components/Button demonstrated.controls.tone.choices"
    ])
    expect(compare(choices(["a", "b"], false), choices(["a"], true))).toEqual([
      "component evidence unavailable: components/Button demonstrated.controls.tone.choices"
    ])
    expect(compare(choices(["c", "a"], false), choices(["d", "b"], false))).toEqual([
      'component demonstrated choice added: components/Button demonstrated.controls.tone.choices ("b")',
      'component demonstrated choice added: components/Button demonstrated.controls.tone.choices ("d")',
      'component demonstrated choice removed: components/Button demonstrated.controls.tone.choices ("a")',
      'component demonstrated choice removed: components/Button demonstrated.controls.tone.choices ("c")'
    ])
  })

  test("does not let cross-source ambiguity or within-adapter disagreement hide local drift", () => {
    const committed = contract(component({ props: { size: { required: false } } }))
    const fresh = contract(component({ props: { size: { required: true } } }))
    fresh.comparisonDiagnostics = {
      total: 2,
      truncated: false,
      byReason: { "ambiguous-identity": 1, "within-adapter-disagreement": 1 },
      items: [
        { type: "could-not-compare", reason: "ambiguous-identity", componentIds: ["components/Button"] },
        {
          type: "could-not-compare",
          reason: "within-adapter-disagreement",
          componentIds: ["components/Button"],
          fieldPath: ["props", "size", "required"]
        }
      ]
    }
    expect(
      compareComponentApi({
        committed,
        fresh,
        pairs: [{ committedId: "components/Button", freshId: "components/Button" }],
        failedSources: new Set()
      })
    ).toEqual(["component field changed: components/Button props.size.required (false → true)"])
  })

  test("suppresses a pair when either snapshot records its source as failed", () => {
    const committed = contract(component({ props: { size: { required: false } } }))
    const fresh = contract(component({ props: { size: { required: true } } }))
    committed.sourceStatuses = { codebase: { status: "failed", error: "old failure" } }
    expect(
      compareComponentApi({
        committed,
        fresh,
        pairs: [{ committedId: "components/Button", freshId: "components/Button" }],
        failedSources: new Set()
      })
    ).toEqual([])
  })

  test("projects preferred targets to typed target identity", () => {
    const oldValue = component({
      props: { icon: { preferredValues: [{ type: "component", key: "icon", label: "Old" } as never] } }
    })
    const newValue = component({
      props: { icon: { preferredValues: [{ type: "component", key: "icon", label: "New" } as never] } }
    })
    expect(compare(oldValue, newValue)).toEqual([])
  })

  test("retains duplicate-option mapping disagreement independent of input order", () => {
    const conflictingChoices = [
      { option: "a", mappedValue: 1 },
      { option: "a", mappedValue: 2 }
    ]
    const withChoices = (choices: typeof conflictingChoices) =>
      component({
        demonstrated: {
          title: "Button",
          extraction: "source",
          storyCount: 0,
          controls: { tone: { choices } }
        }
      })
    const resolved = withChoices([{ option: "a", mappedValue: 1 }])
    const expected = [
      'component evidence added: components/Button demonstrated.controls.tone.choices["string:\\"a\\""]' +
        ".mappedValue"
    ]
    expect(compare(withChoices(conflictingChoices), resolved)).toEqual(expected)
    expect(compare(withChoices([...conflictingChoices].reverse()), resolved)).toEqual(expected)
  })

  test("handles usage truncation in both directions and on both sides", () => {
    const usage = (values: string[], truncated: boolean) =>
      component({
        usage: {
          sites: 1,
          props: { tone: values },
          ...(truncated ? { truncatedProps: ["tone"] } : {})
        }
      })
    expect(compare(usage(["a"], false), usage(["a", "b"], true))).toEqual([
      'component observed value added: components/Button usage.props.tone ("b")',
      "component evidence unavailable: components/Button usage.props.tone"
    ])
    expect(compare(usage(["a", "b"], false), usage(["a"], true))).toEqual([
      "component evidence unavailable: components/Button usage.props.tone"
    ])
    expect(compare(usage(["a"], true), usage(["b"], true))).toEqual([])
  })

  test("keeps durable fields visible when diagnostics are truncated", () => {
    const committed = contract(component({ props: { size: { kind: "variant", required: false } } }))
    committed.comparisonDiagnostics = {
      total: 1,
      truncated: false,
      byReason: { "unsupported-type-vocabulary": 1 },
      items: [
        {
          type: "could-not-compare",
          reason: "unsupported-type-vocabulary",
          componentIds: ["components/Button"],
          fieldPath: ["props", "size", "type"]
        }
      ]
    }
    const fresh = contract(component({ props: { size: { kind: "variant", required: true } } }))
    const items = Array.from({ length: 100 }, (_, index) => ({
      type: "could-not-compare" as const,
      reason: "ambiguous-identity" as const,
      componentIds: [`remote:${index}`]
    }))
    fresh.comparisonDiagnostics = {
      total: 101,
      truncated: true,
      byReason: { "ambiguous-identity": 100, "unsupported-type-vocabulary": 1 },
      items
    }
    expect(
      compareComponentApi({
        committed,
        fresh,
        pairs: [{ committedId: "components/Button", freshId: "components/Button" }],
        failedSources: new Set()
      })
    ).toEqual(["component field changed: components/Button props.size.required (false → true)"])
  })

  test("scopes retained formal diagnostics to their affected field", () => {
    const committed = contract(component({ props: { size: { type: "string", required: false } } }))
    const fresh = contract(component({ props: { size: { required: true, unsupportedFields: ["type"] } } }))
    fresh.comparisonDiagnostics = {
      total: 1,
      truncated: false,
      byReason: { "unsupported-type-vocabulary": 1 },
      items: [
        {
          type: "could-not-compare",
          reason: "unsupported-type-vocabulary",
          componentIds: ["components/Button"]
        }
      ]
    }
    expect(
      compareComponentApi({
        committed,
        fresh,
        pairs: [{ committedId: "components/Button", freshId: "components/Button" }],
        failedSources: new Set()
      })
    ).toEqual([
      "component evidence unavailable: components/Button props.size.type",
      "component field changed: components/Button props.size.required (false → true)"
    ])
  })

  test("reports marker-only args and spread availability without hiding retained values", () => {
    const oldValue = component({
      demonstrated: {
        title: "Button",
        extraction: "source",
        storyCount: 0,
        defaultArgs: { safe: 1 }
      }
    })
    const newValue = component({
      demonstrated: {
        title: "Button",
        extraction: "source",
        storyCount: 0,
        defaultArgs: { safe: 2 },
        unresolvedDefaultArgs: ["onlyMarker"],
        hasUnresolvedDefaultArgsSpread: true
      }
    })
    expect(compare(oldValue, newValue)).toEqual([
      "component evidence unavailable: components/Button demonstrated.defaultArgs.onlyMarker",
      "component field changed: components/Button demonstrated.defaultArgs.safe (1 → 2)",
      "component evidence unavailable: components/Button demonstrated.defaultArgs"
    ])
  })

  test("uses aggregate demonstrated incompleteness directionally", () => {
    const evidence = (args: Record<string, string>, incomplete: boolean) =>
      component({
        demonstrated: {
          title: "Button",
          extraction: "source",
          storyCount: 0,
          defaultArgs: args,
          ...(incomplete ? { incomplete: true } : {})
        }
      })
    expect(compare(evidence({ a: "1" }, false), evidence({ a: "1", b: "2" }, true))).toEqual([
      "component evidence added: components/Button demonstrated.defaultArgs.b",
      "component evidence unavailable: components/Button demonstrated"
    ])
    expect(compare(evidence({ a: "1", b: "2" }, true), evidence({ a: "1" }, false))).toEqual([
      "component evidence removed: components/Button demonstrated.defaultArgs.b",
      "component evidence added: components/Button demonstrated"
    ])
    expect(compare(evidence({ a: "1" }, true), evidence({ b: "2" }, true))).toEqual([])
  })

  test("honors aggregate incompleteness produced by the real demonstrated budget", () => {
    const lostName = "veryLongPropName".repeat(8)
    const oldEvidence = {
      title: "Button",
      extraction: "source" as const,
      storyCount: 0,
      defaultArgs: { shared: "old", [lostName]: "lost" }
    }
    const freshEvidence = boundDemonstratedEvidence(
      {
        ...oldEvidence,
        defaultArgs: { shared: "new", [lostName]: "lost" }
      },
      150
    )
    expect(freshEvidence.incomplete).toBe(true)
    const result = compare(component({ demonstrated: oldEvidence }), component({ demonstrated: freshEvidence }))
    expect(result).toContain(
      'component field changed: components/Button demonstrated.defaultArgs.shared ("old" → "new")'
    )
    expect(result).toContain(`component evidence unavailable: components/Button demonstrated.defaultArgs.${lostName}`)
    expect(result.some((change) => change.includes("evidence removed"))).toBe(false)
  })

  test("compares story completeness directionally", () => {
    const story = { id: "button--one", args: { tone: "a" } }
    const evidence = (stories: (typeof story)[], truncated: boolean) =>
      component({
        demonstrated: {
          title: "Button",
          extraction: "source",
          storyCount: 2,
          stories,
          ...(truncated ? { truncatedStories: true } : {})
        }
      })
    expect(compare(evidence([], false), evidence([story], true))).toEqual([
      'component evidence added: components/Button demonstrated.stories["button--one"]',
      "component evidence unavailable: components/Button demonstrated.stories"
    ])
    expect(compare(evidence([story], true), evidence([], false))).toEqual([
      'component evidence removed: components/Button demonstrated.stories["button--one"]',
      "component evidence added: components/Button demonstrated.stories"
    ])
    expect(compare(evidence([{ id: "old", args: { tone: "a" } }], true), evidence([story], true))).toEqual([])
  })

  test("reports precise leaves when source extraction first becomes available", () => {
    const oldValue = component({ demonstrated: { title: "Button", extraction: "manifest-only", storyCount: 1 } })
    const newValue = component({
      demonstrated: {
        title: "Button",
        extraction: "source",
        storyCount: 1,
        defaultArgs: { size: "sm" },
        stories: [{ id: "button--one", args: { tone: "a" } }]
      }
    })
    expect(compare(oldValue, newValue)).toEqual([
      "component evidence added: components/Button demonstrated.defaultArgs.size",
      'component evidence added: components/Button demonstrated.stories["button--one"].args.tone'
    ])
    expect(compare(newValue, oldValue)).toEqual(["component evidence unavailable: components/Button demonstrated"])
  })
})
