import type * as t from "@babel/types"
import { z } from "zod"
import {
  DEFAULT_MAX_IDENTIFIER_CHARS,
  isSafeIdentifierPath,
  isSafeNonEmptyIdentifier,
  isWithinDurableParticipantBounds,
  MAX_CONFLICT_COMPONENT_ID_BYTES,
  MAX_CONFLICT_COMPONENT_IDS,
  MAX_IDENTIFIER_PATH_SEGMENTS
} from "./safe-identifier"

// Core types for Primitiv

export interface PrimitivConfig {
  sources: {
    codebase?: CodebaseSource
    figma?: FigmaSource
    storybook?: StorybookSource
  }
  governance: {
    sourceOfTruth: "codebase" | "figma" | "storybook" | "manual"
    onConflict: "error" | "warn" | "auto-resolve"
  }
  output: {
    path: string
  }
  reconciliation?: {
    // Exact, user-confirmed links between durable source-specific component IDs.
    // Each mapping must name at least two adapters. These links take precedence
    // over conservative display-name association.
    componentMappings?: ComponentMapping[]
  }
  // Optional per-token / per-component rationale: why it exists and when to use it.
  // Load from a sidecar YAML (default: ./primitiv.rationale.yml) or inline.
  rationale?: {
    path?: string
    inline?: RationaleMap
  }
}

export type SourceAdapter = "codebase" | "figma" | "storybook"

export interface ComponentMapping {
  codebase?: string
  figma?: string
  storybook?: string
}

export interface Rationale {
  why?: string
  when?: string
  deprecated?: boolean
  alternatives?: string[]
  examples?: string[]
  tags?: string[]
}

export interface RationaleMap {
  // Keys are dotted token paths: "colors.primary", "spacing.sm".
  tokens?: Record<string, Rationale>
  // Keys are component names as they appear in the contract.
  components?: Record<string, Rationale>
}

export interface CodebaseSource {
  root: string
  patterns: string[]
  ignore: string[]
  // `optional: false` marks the source required: a failed scan fails the whole build.
  // Default (true/absent): a failed scan is recorded in sourceStatuses and the build
  // continues. The governance.sourceOfTruth is always required regardless of this flag.
  optional?: boolean
}

export interface ComponentAnalysisModule {
  content: string
  file: string
  program: t.Program
}

export interface FigmaSource {
  token: string
  fileId: string
  // Explicit mappings keyed by Figma's publish-stable variable `key` (and mode `modeId`).
  // They are opt-in declarations, never name-based inference.
  numericUnits?: Record<string, string>
  tokenAliases?: Record<string, string>
  modeAliases?: Record<string, string>
  optional?: boolean
}

export interface StorybookSource {
  url: string
  // Optional: filesystem path where Storybook's `importPath` entries resolve.
  // When set, the adapter reads story source files to extract argTypes as props.
  // Usually the project root. Resolved relative to primitiv.config.js when relative.
  sourceRoot?: string
  optional?: boolean
}

export interface Source {
  scan(): Promise<{ tokens: TokenMap; components: ComponentMap }>
}

// Source provenance — tracks where every token and component came from
export interface SourceProvenance {
  adapter: SourceAdapter
  file?: string
  line?: number
  metadata?: Record<string, unknown>
}

// Scan outcome per known source, recorded on every build so the contract can
// distinguish "not configured" (skipped) from "configured but failed" (failed).
// One field covering every source — not a failures-only error list — so consumers
// (verify, the MCP server, a future diff engine) read one complete picture.
export type SourceScanStatus = "ok" | "failed" | "skipped"

export interface SourceStatus {
  status: SourceScanStatus
  // Present on "ok": what the scan contributed.
  tokens?: number
  components?: number
  // Present on "failed": sanitized message — status code + short reason only,
  // never a response body or URL (the contract gets committed and fed to LLMs).
  error?: string
}

// The resolved contract — single source of truth
export interface PrimitivContract {
  version: string
  generatedAt: string
  sources: string[]
  sourceRoot: string
  configPath: string
  tokens: TokenMap
  components: ComponentMap
  // displayName → component ids. The lookup bridge from the bare names agents know
  // ("Card") to the qualified keys in `components`. Optional so pre-0.3 contracts load.
  componentNameIndex?: Record<string, string[]>
  // Optional governance-only lookup winner for a bare component name. Kept
  // separate from conflicts because complementary cross-source components are
  // no longer unconditional identity conflicts.
  componentNameResolutions?: Record<string, string>
  conflicts: Conflict[]
  inferredRules?: InferredRules
  // Optional so older contract files (pre-1.6) load without crashing.
  violations?: Violation[]
  // Optional so pre-2.2 contracts load. Keyed "codebase" | "figma" | "storybook".
  sourceStatuses?: Record<string, SourceStatus>
}

export interface TokenMap {
  colors: Record<string, Token>
  spacing: Record<string, Token>
  typography: Record<string, Token>
  borderRadius: Record<string, Token>
  shadows: Record<string, Token>
  [key: string]: Record<string, Token>
}

// The canonical token-category vocabulary — the single source of truth for the category set.
// Every category-assigning function is typed against this (so a misspelled or unaccounted-for
// category is a compile error, not a silent miscategorization), and `emptyTokenMap()` seeds
// from it (so the "starter" map never drifts from the real set). Adding a category is a one-line
// change here. ("other" is the on-demand fallback bucket, created lazily when a token matches no
// category — deliberately not seeded into the empty map.)
export const TOKEN_CATEGORIES = [
  "colors",
  "spacing",
  "sizes",
  "typography",
  "borderRadius",
  "shadows",
  "zIndex",
  "breakpoints",
  "motion"
] as const

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number]

// A fresh, empty token map carrying every canonical category. The one place a blank TokenMap is
// produced — call this instead of hand-typing the category list, so the set lives in exactly one
// spot. Every contract therefore lists all categories (some empty), a stable shape for consumers.
export function emptyTokenMap(): TokenMap {
  return Object.fromEntries(TOKEN_CATEGORIES.map((category) => [category, {}])) as TokenMap
}

// The lint surface is its own, narrower vocabulary: token-misuse detection only covers color and
// spacing literals. Kept separate from TOKEN_CATEGORIES so neither pollutes the other — so
// get_violations advertises exactly these and never the full token set.
export const LINT_CATEGORIES = ["colors", "spacing"] as const

export type LintCategory = (typeof LINT_CATEGORIES)[number]

export interface Token {
  name: string
  value: string
  source: SourceProvenance
  references?: string[]
  rationale?: Rationale
  // Theme-scoped values keyed by mode (`dark`, `light`, `dim`, …). `value` is the default —
  // the value under `:root`/unscoped selectors — while each entry here is the SAME token's value
  // under a theme selector (`.dark`, `[data-theme="dim"]`) or `@media (prefers-color-scheme: …)`.
  // A theme value is the token in another mode, not a separate token, so it lives here instead of
  // spawning a `-dark` name or a false cross-value conflict. Mirrors Figma's valuesByMode with a
  // default mode: future non-default Figma modes land in this field with no schema change. Absent
  // when the token has no theme variants.
  modes?: Record<string, string>
  // Provenance for each theme-mode value. This stays separate from `source`, whose value tracks
  // the default token only: governance may legitimately select a default from one source and a
  // mode from another. Optional for backwards compatibility with existing contracts.
  modeSources?: Record<string, SourceProvenance>
}

// A token name defined more than once with DIFFERENT values inside one source.
// Cross-source conflict detection can never see these — each source's token map is
// collapsed before merging — so the scanner reports them and ContractBuilder surfaces
// them as pending conflicts (rule 11: conflicts surface, never silence). Same-value
// duplicates are harmless and not reported.
export interface TokenRedefinition {
  category: string
  name: string
  // The definition the contract keeps (first write wins).
  kept: { value: string; source: SourceProvenance }
  // Later definitions with different values, in scan order.
  discarded: Array<{ value: string; source: SourceProvenance }>
}

// Keyed by component id, not bare name, so same-name components coexist instead of
// overwriting each other. Codebase ids are path-qualified: the file's path relative to the
// scan root, sans extension (`components/ui/Card`), with `#Name` appended only when the
// component's name doesn't match its filename (`components/ui/Card#CardHeader` for a
// compound sibling; normalized match, so `card-header.tsx` ↔ `CardHeader` and `index.*` ↔
// folder name). Figma/Storybook components have no fs path; their ids are source-prefixed
// (`figma:<published-key>` for Figma's published identity, `storybook:<manifest-title>` for
// Storybook's hierarchy-qualified identity) so they can never collide with path ids.
export interface ComponentMap {
  [id: string]: Component
}

export type ComponentKind = "component" | "screen" | "provider" | "icon" | "other"

export type DemonstratedValue =
  | string
  | number
  | boolean
  | null
  | DemonstratedValue[]
  | { [key: string]: DemonstratedValue }

export interface StorybookControlChoice {
  option: string | number | boolean
  mappedValue?: DemonstratedValue
  mappingUnresolved?: boolean
}

export interface StorybookControlEvidence {
  control?: string | false
  choices?: StorybookControlChoice[]
  unresolvedChoices?: boolean
  truncatedChoices?: boolean
}

export interface DemonstratedStory {
  // Storybook's manifest/permalink identity. Never synthesized from a display label.
  id: string
  name?: string
  exportName?: string
  importPath?: string
  args?: Record<string, DemonstratedValue>
  unresolvedArgs?: string[]
  truncatedArgs?: string[]
  hasUnresolvedArgsSpread?: boolean
  controls?: Record<string, StorybookControlEvidence>
}

export interface DemonstratedEvidence {
  title: string
  // PR 1 records manifest identity only. PR 2 adds bounded static source extraction.
  extraction: "manifest-only" | "source"
  // Unique eligible manifest stories before the retained-story cap.
  storyCount: number
  defaultArgs?: Record<string, DemonstratedValue>
  unresolvedDefaultArgs?: string[]
  truncatedDefaultArgs?: string[]
  hasUnresolvedDefaultArgsSpread?: boolean
  controls?: Record<string, StorybookControlEvidence>
  stories?: DemonstratedStory[]
  truncatedStories?: boolean
}

export interface Component {
  name: string
  // The bare export name (`Card`) — what humans and agents call it. The map key is the
  // qualified id; lookups by name go through the contract's componentNameIndex.
  displayName?: string
  // Optional source-provided description (for example, a published Figma component description).
  description?: string
  // What the AST scanner judged this export to be. Reusable UI = "component";
  // screens/providers/icons are tagged (not dropped) so consumers can filter noise.
  kind?: ComponentKind
  // Optional explicit override for path-scope resolution when the file's own path
  // isn't the right scope (e.g. a shared component that should win in one app area).
  scope?: string
  source: SourceProvenance
  props?: Record<string, PropDefinition>
  // Bounded source-specific examples/configurations; never a formal API or runtime-frequency claim.
  demonstrated?: DemonstratedEvidence
  // Qualified target component id → statically resolved local JSX opening-site count.
  // Static source evidence only, never runtime frequency. Omitted when no edges exist.
  uses?: Record<string, number>
  // Statically resolved local JSX sites that target this component. Presence means at
  // least one site; zero is represented by absence. Observed props are bounded static
  // source evidence from explicit JSX attributes, never runtime-frequency claims.
  usage?: {
    sites: number
    props?: Record<string, Array<string | number | boolean | null>>
    // Sorted prop names whose distinct observed values exceeded the retained bound.
    truncatedProps?: string[]
  }
  rationale?: Rationale
  [key: string]: unknown
}

export interface PropDefinition {
  type?: string
  required?: boolean
  default?: string
  // Complete finite literal values declared by the prop type, preserving primitive types.
  values?: Array<string | number | boolean>
  // Source-neutral category for evidence that does not map cleanly to a language type.
  kind?: "boolean" | "text" | "variant" | "instance-swap"
  // Recommended instance-swap targets; unlike `values`, these are not an exhaustive domain.
  preferredValues?: Array<{
    type: "component" | "component-set"
    key: string
  }>
}

export interface Conflict {
  type: "token" | "component"
  // New writers always set scope. Optional only so contracts written before
  // scoped findings were introduced remain readable.
  scope?: ConflictScope
  name: string
  sources: ConflictEvidence[]
  // Structured component field identity. The array is authoritative; `name`
  // remains a human-facing compatibility label and must never be parsed.
  fieldPath?: string[]
  // Every durable component ID whose evidence participates in this field finding.
  componentIds?: string[]
  comparison?: "exact" | "subset"
  // Field governance is deliberately separate from `resolved`, which remains
  // an identity-level selected component ID for legacy component conflicts.
  fieldResolution?: {
    adapter: SourceAdapter
    componentIds: string[]
    fieldPath: string[]
    structuredValue: ConflictStructuredValue
  }
  resolved?: string
  resolution?: "auto" | "manual" | "pending"
  suggestedFix?: string
  actionable?: boolean
  // Present when the bounded sources array is a representative subset of the
  // complete evidence used to establish this conflict.
  evidenceTotal?: number
  evidenceTruncated?: true
}

export type ConflictScope = "cross-source" | "within-source"

export type ConflictStructuredValue =
  | string
  | number
  | boolean
  | null
  | ConflictStructuredValue[]
  | { [key: string]: ConflictStructuredValue }

export interface ConflictEvidence {
  source: SourceProvenance
  // Bounded, escaped display value retained for existing string consumers.
  value: string
  // Optional type-preserving value for field-level machine consumers.
  structuredValue?: ConflictStructuredValue
  componentId?: string
  // Actual source evidence path. It may differ from Conflict.fieldPath for
  // directional observed/demonstrated checks.
  factPath?: string[]
}

export interface InferredRule {
  id: string
  category: "spacing" | "colors" | "typography" | "borderRadius" | "naming" | "components"
  rule: string
  confidence: "high" | "medium" | "low"
  evidence: string[]
}

export interface InferredRules {
  // New contracts use the enclosing contract's generatedAt timestamp. Keep this optional
  // so contracts written before that consolidation still load without migration.
  generatedAt?: string
  rules: InferredRule[]
}

// A token-misuse violation: a hardcoded literal in component code that
// bypasses the contract. Surfaced by `primitiv build` and `primitiv verify`.
export interface Violation {
  type: "token-misuse"
  // Only colors and spacing are linted today (see LINT_CATEGORIES); typed against that surface
  // so the contract can't claim a violation category the linter never emits.
  category: LintCategory
  // The raw literal as captured (e.g. "#ff0000", "7px").
  found: string
  // The surrounding utility (e.g. "bg-[#ff0000]") for context in the report.
  context: string
  source: { file: string; line: number; column: number }
  // Present iff a contract token's value matches `found` after normalization.
  // The smart-match suggestion that turns the report into a fix.
  suggestion?: {
    token: string
    category: string
    value: string
  }
}

// ─── Boundary validation (Rule 12) ───────────────────────────────────────────
// Two lean schemas guarding Primitiv's two untrusted inputs: the user-authored
// config (loaded via require) and the contract JSON (read by the MCP server and
// by verify). Deliberately shallow — they check the top-level shape consumers
// actually dereference, not every leaf token/component/prop. `looseObject` keeps
// unknown and future fields instead of stripping them (backward-compat: pre-1.6
// contracts, fields added later). Deep value validation would walk thousands of
// tokens on every hot-reload for zero crash-safety gain, and would couple the
// contract schema to the token/prop shapes it has no reason to know about — so
// `tokens`/`components` are validated only as objects, their values left opaque.

const figmaStableKeyMappings = z.record(z.string().min(1), z.string().min(1))
const machineIdentifierSchema = z
  .string()
  .min(1, "must be a non-empty machine identifier")
  .max(DEFAULT_MAX_IDENTIFIER_CHARS, `must be at most ${DEFAULT_MAX_IDENTIFIER_CHARS} characters`)
  .refine((value) => isSafeNonEmptyIdentifier(value), {
    message: "must not contain control or bidirectional formatting code points"
  })

export const primitivConfigSchema = z.looseObject({
  sources: z.looseObject({
    codebase: z
      .looseObject({
        root: z.string(),
        patterns: z.array(z.string()),
        ignore: z.array(z.string()),
        optional: z.boolean().optional()
      })
      .optional(),
    figma: z
      .looseObject({
        token: z.string(),
        fileId: z.string(),
        // Empty keys would act as accidental wildcards for Figma variables that lack a
        // publish-stable key; empty values would erase a token or mode name.
        numericUnits: figmaStableKeyMappings.optional(),
        tokenAliases: figmaStableKeyMappings.optional(),
        modeAliases: figmaStableKeyMappings.optional(),
        optional: z.boolean().optional()
      })
      .optional(),
    storybook: z
      .looseObject({
        url: z.string(),
        sourceRoot: z.string().optional(),
        optional: z.boolean().optional()
      })
      .optional()
  }),
  governance: z.looseObject({
    sourceOfTruth: z.enum(["codebase", "figma", "storybook", "manual"]),
    onConflict: z.enum(["error", "warn", "auto-resolve"])
  }),
  output: z.looseObject({ path: z.string() }),
  reconciliation: z
    .looseObject({
      componentMappings: z
        .array(
          z
            .looseObject({
              codebase: machineIdentifierSchema.optional(),
              figma: machineIdentifierSchema.optional(),
              storybook: machineIdentifierSchema.optional()
            })
            .refine(
              (mapping) =>
                [mapping.codebase, mapping.figma, mapping.storybook].filter((id) => id !== undefined).length >= 2,
              { message: "must link at least two component adapters" }
            )
        )
        .optional()
    })
    .optional()
})

export const primitivContractSchema = z
  .looseObject({
    version: z.string(),
    generatedAt: z.string(),
    sources: z.array(z.string()),
    tokens: z.record(z.string(), z.unknown()),
    components: z.record(z.string(), z.unknown()),
    conflicts: z.array(z.unknown())
  })
  .superRefine((contract, context) => {
    for (const issue of contractIdentifierBoundaryIssues(contract)) {
      context.addIssue({ code: "custom", path: issue.path, message: issue.message })
    }
  })

type BoundaryPath = Array<string | number>

interface BoundaryIssue {
  path: BoundaryPath
  message: string
}

interface BoundaryValueValidation {
  issues: BoundaryIssue[]
  value: unknown
  path: BoundaryPath
}

interface BoundaryRecordFieldValidation {
  issues: BoundaryIssue[]
  record: Record<string, unknown>
  field: string
  path: BoundaryPath
}

interface IdentifierIndexValidation extends BoundaryValueValidation {
  valueShape: "array" | "single"
}

function contractIdentifierBoundaryIssues(contract: Record<string, unknown>): BoundaryIssue[] {
  const issues: BoundaryIssue[] = []

  // A map key is itself the durable component ID. Address bad keys by ordinal so
  // diagnostics never reproduce the unsafe key text.
  for (const [index, componentId] of Object.keys(contract.components as Record<string, unknown>).entries()) {
    addIdentifierIssue({ issues, value: componentId, path: ["components", index, "(key)"] })
  }

  validateIdentifierIndex({
    issues,
    value: contract.componentNameIndex,
    path: ["componentNameIndex"],
    valueShape: "array"
  })
  validateIdentifierIndex({
    issues,
    value: contract.componentNameResolutions,
    path: ["componentNameResolutions"],
    valueShape: "single"
  })

  for (const [conflictIndex, conflictValue] of (contract.conflicts as unknown[]).entries()) {
    if (!isUnknownRecord(conflictValue)) continue
    const conflictPath: BoundaryPath = ["conflicts", conflictIndex]
    addOptionalIdentifierIssue({ issues, record: conflictValue, field: "resolved", path: conflictPath })
    validateParticipantList({
      issues,
      value: conflictValue.componentIds,
      path: [...conflictPath, "componentIds"]
    })
    addOptionalPathIssue({ issues, record: conflictValue, field: "fieldPath", path: conflictPath })

    if (Array.isArray(conflictValue.sources)) {
      for (const [sourceIndex, sourceValue] of conflictValue.sources.entries()) {
        if (!isUnknownRecord(sourceValue)) continue
        const sourcePath = [...conflictPath, "sources", sourceIndex]
        addOptionalIdentifierIssue({ issues, record: sourceValue, field: "componentId", path: sourcePath })
        addOptionalPathIssue({ issues, record: sourceValue, field: "factPath", path: sourcePath })
      }
    }

    if (isUnknownRecord(conflictValue.fieldResolution)) {
      const resolutionPath = [...conflictPath, "fieldResolution"]
      validateParticipantList({
        issues,
        value: conflictValue.fieldResolution.componentIds,
        path: [...resolutionPath, "componentIds"]
      })
      addOptionalPathIssue({
        issues,
        record: conflictValue.fieldResolution,
        field: "fieldPath",
        path: resolutionPath
      })
    }
  }

  return issues
}

function validateIdentifierIndex({ issues, value, path, valueShape }: IdentifierIndexValidation): void {
  if (value === undefined) return
  if (!isUnknownRecord(value)) {
    issues.push({ path, message: "must be an object when present" })
    return
  }

  for (const [entryIndex, [key, ids]] of Object.entries(value).entries()) {
    // Retain useful legacy schema paths for safe display-name keys, but fall
    // back to an ordinal when the key itself would make the error unsafe or unbounded.
    const entryPath = [...path, isSafeNonEmptyIdentifier(key) ? key : entryIndex]
    if (valueShape === "array") {
      if (!Array.isArray(ids)) {
        issues.push({ path: entryPath, message: "must contain an array of machine identifiers" })
        continue
      }
      for (const [idIndex, id] of ids.entries()) {
        addIdentifierIssue({ issues, value: id, path: [...entryPath, idIndex] })
      }
    } else {
      addIdentifierIssue({ issues, value: ids, path: entryPath })
    }
  }
}

function validateParticipantList({ issues, value, path }: BoundaryValueValidation): void {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array of machine identifiers when present" })
    return
  }
  if (value.length > MAX_CONFLICT_COMPONENT_IDS) {
    issues.push({ path, message: `must contain at most ${MAX_CONFLICT_COMPONENT_IDS} machine identifiers` })
    return
  }

  const allStrings = value.every((id) => typeof id === "string")
  for (const [idIndex, id] of value.entries()) {
    addIdentifierIssue({ issues, value: id, path: [...path, idIndex] })
  }
  if (allStrings && !isWithinDurableParticipantBounds(value as string[])) {
    issues.push({ path, message: `must contain at most ${MAX_CONFLICT_COMPONENT_ID_BYTES} UTF-8 bytes of ID text` })
  }
}

function addOptionalIdentifierIssue({ issues, record, field, path }: BoundaryRecordFieldValidation): void {
  if (record[field] !== undefined) {
    addIdentifierIssue({ issues, value: record[field], path: [...path, field] })
  }
}

function addIdentifierIssue({ issues, value, path }: BoundaryValueValidation): void {
  if (typeof value !== "string" || !isSafeNonEmptyIdentifier(value)) {
    issues.push({
      path,
      message: `must be a non-empty machine identifier of at most ${DEFAULT_MAX_IDENTIFIER_CHARS} characters without control or bidirectional formatting code points`
    })
  }
}

function addOptionalPathIssue({ issues, record, field, path }: BoundaryRecordFieldValidation): void {
  const value = record[field]
  if (value === undefined) return
  if (isSafeIdentifierPath(value)) return
  const fieldPath = [...path, field]
  if (!Array.isArray(value)) {
    issues.push({ path: fieldPath, message: "must be an array of machine-identifier path segments when present" })
    return
  }
  if (value.length === 0 || value.length > MAX_IDENTIFIER_PATH_SEGMENTS) {
    issues.push({
      path: fieldPath,
      message: `must contain between 1 and ${MAX_IDENTIFIER_PATH_SEGMENTS} path segments`
    })
    return
  }
  for (const [segmentIndex, segment] of value.entries()) {
    addIdentifierIssue({ issues, value: segment, path: [...fieldPath, segmentIndex] })
  }
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Compact, human-readable reason a config/contract failed validation — the
// actionable tail of every boundary error/warning. Caps at three issues so the
// message stays a single readable line.
export function summarizeValidationIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ")
}
