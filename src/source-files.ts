import * as fs from "node:fs"
import * as path from "node:path"
import { hasMagic } from "glob"
import type { CodebaseSource } from "./types"

// Early init templates used literal directory names as ignores. glob ignores
// those entries themselves, but needs a descendant pattern to omit their files.
// Keep existing file/glob patterns intact and never rewrite the user's config.
export function sourceIgnorePatterns(source: CodebaseSource): string[] {
  const patterns = new Set(source.ignore)
  for (const ignore of source.ignore) {
    if (hasMagic(ignore)) continue
    try {
      if (fs.statSync(path.resolve(source.root, ignore)).isDirectory()) patterns.add(`${ignore.replace(/\/+$/, "")}/**`)
    } catch {
      // Keep the original pattern when the path cannot be identified as a directory.
    }
  }
  return [...patterns]
}
