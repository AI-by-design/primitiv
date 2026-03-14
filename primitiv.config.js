/** @type {import('./src/types').PrimitivConfig} */
module.exports = {
  // Where to find your tokens and primitives
  sources: {
    codebase: {
      root: "./src",
      patterns: ["**/*.css", "**/*.ts", "**/*.tsx"],
      ignore: ["node_modules", "dist", ".next"]
    },
    // Uncomment when you have Figma set up
    // figma: {
    //   token: process.env.FIGMA_ACCESS_TOKEN,
    //   fileId: "your-figma-file-id"
    // },
    // Uncomment when you have Storybook set up
    // storybook: {
    //   url: "http://localhost:6006"
    // }
  },

  // How to resolve conflicts when sources disagree
  governance: {
    // Which source wins when values conflict
    // "codebase" | "figma" | "storybook" | "manual"
    sourceOfTruth: "codebase",
    // What to do when a conflict is found
    // "error" | "warn" | "auto-resolve"
    onConflict: "warn"
  },

  // Where to write the resolved contract
  output: {
    path: "./primitiv.contract.json"
  }
}
