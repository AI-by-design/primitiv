import type { Conflict } from "./types"

type ConflictOrderingFields = Pick<Conflict, "type" | "name" | "scope" | "fieldPath" | "comparison">

/** Canonical order shared by durable serialization and interactive pagination. */
export function compareConflictsCanonical(a: ConflictOrderingFields, b: ConflictOrderingFields): number {
  return (
    compareStrings(a.type, b.type) ||
    compareStrings(a.name, b.name) ||
    compareStrings(a.scope ?? "", b.scope ?? "") ||
    compareStrings(JSON.stringify(a.fieldPath ?? []), JSON.stringify(b.fieldPath ?? [])) ||
    compareStrings(a.comparison ?? "", b.comparison ?? "")
  )
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
