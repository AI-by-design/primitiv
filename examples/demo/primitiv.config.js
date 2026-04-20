// Detected: react + TypeScript
/** @type {import('../../src/types').PrimitivConfig} */
module.exports = {
  sources: {
    codebase: {
      root: "./src",
      patterns: ["**/*.css", "**/*.ts", "**/*.tsx"],
      ignore: ["node_modules", "dist"]
    }
    // Figma and Storybook are commented out: the demo is codebase-only so it
    // runs without credentials or a local Storybook server. In a real project,
    // you'd add one or both to surface reconciliation and conflicts.
    // figma: { token: process.env.FIGMA_ACCESS_TOKEN, fileId: "..." },
    // storybook: { url: "http://localhost:6006", sourceRoot: "." }
  },

  governance: {
    sourceOfTruth: "codebase",
    onConflict: "warn"
  },

  output: {
    path: "./primitiv.contract.json"
  },

  rationale: {
    path: "./primitiv.rationale.yml"
  }
}
