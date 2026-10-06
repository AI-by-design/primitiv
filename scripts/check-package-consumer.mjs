import { execFileSync } from "node:child_process"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Exercise the shipped declarations with a clean dependency tree, rather than
// the repository's permissive skipLibCheck setting or its development compiler.
const root = fileURLToPath(new URL("../", import.meta.url))
const consumer = mkdtempSync(path.join(tmpdir(), "primitiv-package-types-"))
try {
  run("bun", ["run", "build"], root)
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", consumer], {
      cwd: root,
      encoding: "utf8"
    })
  )
  writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true }))
  run("npm", [
    "install", "--ignore-scripts", "--no-audit", "--no-fund",
    path.join(consumer, packed[0].filename), "typescript@6.0.2", "@types/node@^26.0.1"
  ], consumer)
  const compiler = path.join(consumer, "node_modules/typescript/bin/tsc")
  console.log(`Consumer TypeScript ${JSON.parse(readFileSync(path.join(consumer, "node_modules/typescript/package.json"), "utf8")).version}`)
  for (const extension of ["cts", "mts"]) {
    copyFileSync(path.join(root, "test/package-consumer/consumer.ts"), path.join(consumer, `consumer.${extension}`))
    for (const mode of ["Node16", "NodeNext", "Bundler"]) {
      writeFileSync(path.join(consumer, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          target: "ES2022", module: mode === "Bundler" ? "Preserve" : mode,
          moduleResolution: mode, strict: true, skipLibCheck: false, noEmit: true, types: ["node"]
        },
        files: [`consumer.${extension}`]
      }))
      run(process.execPath, [compiler, "--project", "tsconfig.json"], consumer)
      console.log(`${mode} consumer.${extension}: passed (strict, skipLibCheck=false)`)
    }
  }
} finally {
  rmSync(consumer, { recursive: true, force: true })
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" })
}
