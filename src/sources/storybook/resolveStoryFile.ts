import * as fs from "node:fs"
import * as path from "node:path"
import { MAX_METADATA_STRING_BYTES, MAX_SOURCE_BYTES } from "./limits"

/** Extensions accepted by the Babel JavaScript/TypeScript parser. */
export const SUPPORTED_STORY_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx"
])

export type StoryFileFailureCode =
  | "invalid-root"
  | "invalid-import-path"
  | "metadata-too-large"
  | "absolute-import-path"
  | "path-traversal"
  | "unsupported-extension"
  | "root-not-found"
  | "file-not-found"
  | "outside-root"
  | "not-a-file"
  | "too-large"
  | "read-failed"
  | "changed-during-read"

/** A safe, serializable failure. Deliberately contains no filesystem paths. */
export interface StoryFileFailure {
  readonly code: StoryFileFailureCode
}

export interface StoryFileResolution {
  readonly ok: true
  /** The canonical path. Only successful resolutions expose it. */
  readonly path: string
  readonly size: number
}

export interface StoryFileResolutionFailure {
  readonly ok: false
  readonly error: StoryFileFailure
}

export type StoryFileResolutionResult = StoryFileResolution | StoryFileResolutionFailure

export interface StoryFileRead {
  readonly ok: true
  /** The canonical path. Only successful reads expose it. */
  readonly path: string
  readonly bytesRead: number
  readonly source: string
}

export interface StoryFileReadFailure {
  readonly ok: false
  readonly error: StoryFileFailure
}

export type StoryFileReadResult = StoryFileRead | StoryFileReadFailure

/**
 * Resolve a manifest importPath to a regular file inside sourceRoot.
 *
 * Every manifest value is untrusted. This performs lexical checks before any
 * filesystem access, then canonicalizes both root and candidate before using
 * path.relative for the actual containment check. The file's size is checked
 * before a caller reads it.
 */
export function resolveStoryFile(sourceRoot: string, importPath: string): StoryFileResolutionResult {
  if (typeof sourceRoot !== "string" || sourceRoot.length === 0) {
    return failure("invalid-root")
  }
  if (typeof importPath !== "string" || importPath.length === 0 || importPath.includes("\0")) {
    return failure("invalid-import-path")
  }
  if (Buffer.byteLength(importPath, "utf8") > MAX_METADATA_STRING_BYTES) {
    return failure("metadata-too-large")
  }

  // path.resolve on POSIX does not treat Windows drive/UNC paths as absolute;
  // reject both forms because the manifest may have been produced elsewhere.
  if (path.isAbsolute(importPath) || path.win32.isAbsolute(importPath)) {
    return failure("absolute-import-path")
  }

  // Reject traversal itself, including traversal that would eventually land
  // back inside the root. Backslashes are treated as separators for safety
  // even on POSIX, where they otherwise have filename semantics.
  if (importPath.split(/[\\/]/).some((segment) => segment === "..")) {
    return failure("path-traversal")
  }

  const extension = path.extname(importPath).toLowerCase()
  if (!SUPPORTED_STORY_FILE_EXTENSIONS.has(extension)) {
    return failure("unsupported-extension")
  }

  let canonicalRoot: string
  try {
    canonicalRoot = fs.realpathSync(sourceRoot)
    if (!fs.statSync(canonicalRoot).isDirectory()) return failure("invalid-root")
  } catch {
    return failure("root-not-found")
  }

  const candidatePath = path.resolve(canonicalRoot, importPath)
  let canonicalCandidate: string
  try {
    canonicalCandidate = fs.realpathSync(candidatePath)
  } catch {
    return failure("file-not-found")
  }

  const relative = path.relative(canonicalRoot, canonicalCandidate)
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return failure("outside-root")
  }

  try {
    const stats = fs.statSync(canonicalCandidate)
    if (!stats.isFile()) return failure("not-a-file")
    if (stats.size > MAX_SOURCE_BYTES) return failure("too-large")
    return { ok: true, path: canonicalCandidate, size: stats.size }
  } catch {
    return failure("file-not-found")
  }
}

/**
 * Resolve and read a story without ever allocating more than MAX_SOURCE_BYTES
 * plus one byte for the source buffer. The extra byte detects a file that grew
 * between stat and read, so a successful result always proves its byte bound.
 */
export function readStoryFile(sourceRoot: string, importPath: string): StoryFileReadResult {
  const resolved = resolveStoryFile(sourceRoot, importPath)
  if (!resolved.ok) return resolved

  let descriptor: number | undefined
  try {
    // The canonical path was checked above. O_NOFOLLOW closes the final
    // component race where a file is replaced with a symlink between the
    // realpath/stat checks and opening it for reading.
    const noFollow = fs.constants.O_NOFOLLOW ?? 0
    descriptor = fs.openSync(resolved.path, fs.constants.O_RDONLY | noFollow)
    const openedStats = fs.fstatSync(descriptor)
    if (!openedStats.isFile()) return failure("not-a-file")
    if (openedStats.size > MAX_SOURCE_BYTES) return failure("too-large")

    const sourceBuffer = Buffer.allocUnsafe(MAX_SOURCE_BYTES + 1)
    let bytesRead = 0

    while (bytesRead < sourceBuffer.length) {
      const read = fs.readSync(descriptor, sourceBuffer, bytesRead, sourceBuffer.length - bytesRead, null)
      if (read === 0) break
      bytesRead += read
    }

    if (bytesRead > MAX_SOURCE_BYTES) return failure("changed-during-read")
    return {
      ok: true,
      path: resolved.path,
      bytesRead,
      source: sourceBuffer.subarray(0, bytesRead).toString("utf8")
    }
  } catch {
    return failure("read-failed")
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor)
      } catch {
        // The read result is already determined; never leak a close failure.
      }
    }
  }
}

function failure(code: StoryFileFailureCode): StoryFileResolutionFailure {
  return { ok: false, error: { code } }
}
