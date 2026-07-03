# Changelog

## [2.1.2](https://github.com/AI-by-design/primitiv/compare/v2.1.1...v2.1.2) (2026-07-02)


### Bug Fixes

* **mcp:** declare omittable tool args optional so no-arg calls pass validation ([#63](https://github.com/AI-by-design/primitiv/issues/63)) ([9b03cd3](https://github.com/AI-by-design/primitiv/commit/9b03cd34015b6208a3f044c7868e1d8fd944fd94))

## [2.1.1](https://github.com/AI-by-design/primitiv/compare/v2.1.0...v2.1.1) (2026-06-30)


### Bug Fixes

* **init:** harden init against bad input and unsafe codex wiring ([1ab6aa1](https://github.com/AI-by-design/primitiv/commit/1ab6aa18c40c6093d2486b142973c58a32f11cf1))
* **scanner:** resolve component props per-component, not from the first Props block ([419ebce](https://github.com/AI-by-design/primitiv/commit/419ebcefd33dad5926a45cfda47b571ad89de3cc))
* validate config and contract at trust boundaries with zod ([c3e773b](https://github.com/AI-by-design/primitiv/commit/c3e773b0da247d262ff36d6d7813f2db470d4f5b))

## [2.1.0](https://github.com/AI-by-design/primitiv/compare/v2.0.0...v2.1.0) (2026-06-24)


### Features

* **contract:** single source of truth for token categories ([ebeeabe](https://github.com/AI-by-design/primitiv/commit/ebeeabe57eb5ff24e5a0f71240db84d735508279))
* **contract:** single source of truth for token categories ([7dbc29f](https://github.com/AI-by-design/primitiv/commit/7dbc29f3f1d54cc9a64966027295d41cb310ff87))

## [2.0.0](https://github.com/AI-by-design/primitiv/compare/v1.12.0...v2.0.0) (2026-06-15)


### ⚠ BREAKING CHANGES

* **mcp:** component contract keys moved from bare name to path-qualified id (contract version 0.2.0 -> 0.3.0), first shipped in 1.12.0. 2.0.0 re-releases it with the correct major version. The first rebuild reports a one-time informative re-key diff; the MCP server reads pre-0.3 contracts via a derived name index.

### Features

* **mcp:** surface contract schema version in get_design_context ([a1d7fe0](https://github.com/AI-by-design/primitiv/commit/a1d7fe054480f8605eaac900c3cfb9dde82bb77a))
* **mcp:** surface contract schema version in get_design_context ([93a94d1](https://github.com/AI-by-design/primitiv/commit/93a94d1938a8c8a317e2f950d85eb3ab71fcc7ff))

## [1.12.0](https://github.com/AI-by-design/primitiv/compare/v1.11.0...v1.12.0) (2026-06-15)


### Features

* **contract:** path-qualified component identity + governed resolution ([45bfa27](https://github.com/AI-by-design/primitiv/commit/45bfa27e95d5d89645a4b992de9e891feb2c589b))
* **contract:** path-qualified component identity + governed resolution ([16e1f19](https://github.com/AI-by-design/primitiv/commit/16e1f192ef6663c3e6b78d4c58772e6efb1425fa))

## [1.11.0](https://github.com/AI-by-design/primitiv/compare/v1.10.0...v1.11.0) (2026-06-09)


### Features

* **init:** rewrite build-component skill with reuse + token ladders ([1c7575a](https://github.com/AI-by-design/primitiv/commit/1c7575aa1952b86dd38558b34ca63dee7b2fabb6))
* **init:** rewrite build-component skill with reuse + token ladders ([19befaa](https://github.com/AI-by-design/primitiv/commit/19befaa4e8193fd0ec71be4e73edc982f112d945))

## [1.10.0](https://github.com/AI-by-design/primitiv/compare/v1.9.0...v1.10.0) (2026-06-05)


### Features

* **scanner:** AST token extraction + CSS selector-scope split ([03f699f](https://github.com/AI-by-design/primitiv/commit/03f699fabda7b9693b1208614a839218a06e9fc3))
* **scanner:** AST-based component detection + classification ([936b1e9](https://github.com/AI-by-design/primitiv/commit/936b1e9a79d5804c8ab641ab6b27eda2931e1397))
* **scanner:** AST-based extraction (Phases 1–3 — components, TS tokens, CSS scope) ([762ca5c](https://github.com/AI-by-design/primitiv/commit/762ca5c261bc957a8b2fa1e1c8811d3d891b8c39))

## [1.9.0](https://github.com/AI-by-design/primitiv/compare/v1.8.1...v1.9.0) (2026-06-05)


### Features

* **scanner:** expand token taxonomy, capture all components per file, surface collisions ([f3faa61](https://github.com/AI-by-design/primitiv/commit/f3faa616cd45f696bcaa41de7cf2250e62a64b60))
* **scanner:** expand token taxonomy, capture all components per file, surface collisions ([db4074d](https://github.com/AI-by-design/primitiv/commit/db4074d8945e42a7196951141345bc4691833bc3))

## [1.8.1](https://github.com/AI-by-design/primitiv/compare/v1.8.0...v1.8.1) (2026-06-03)


### Bug Fixes

* **mcp:** align inferred-rule categories with token vocabulary ([3479c04](https://github.com/AI-by-design/primitiv/commit/3479c048658cca022ff8418f6cc74ce47cf9a77d))
* **mcp:** align inferred-rule categories with token vocabulary ([b30cda2](https://github.com/AI-by-design/primitiv/commit/b30cda262865e8c857b8fcc3fe44efd7ed9978ee))

## [1.8.0](https://github.com/AI-by-design/primitiv/compare/v1.7.1...v1.8.0) (2026-05-26)


### Features

* **init:** scope /primitiv-setup Bash via skill frontmatter ([1b0083d](https://github.com/AI-by-design/primitiv/commit/1b0083d81dcac9d5953c7db20460e657759ec702))
* **init:** scope /primitiv-setup Bash via skill frontmatter ([f2f536d](https://github.com/AI-by-design/primitiv/commit/f2f536df35581d50bc8dc09eed74fb11dd41c53b))

## [1.7.1](https://github.com/AI-by-design/primitiv/compare/v1.7.0...v1.7.1) (2026-05-22)


### Bug Fixes

* **license:** restore canonical Apache-2.0 layout for GitHub detection ([ee09ae1](https://github.com/AI-by-design/primitiv/commit/ee09ae1ae5b50e3945d3ec846571266f256fbe51))

## [1.7.0](https://github.com/AI-by-design/primitiv/compare/v1.6.0...v1.7.0) (2026-05-19)


### Features

* structured cold-install path via /primitiv-setup ([2047f02](https://github.com/AI-by-design/primitiv/commit/2047f0265fe76fa868b9dfe32421c8722ef870e5))
* structured cold-install path via /primitiv-setup ([529bc2f](https://github.com/AI-by-design/primitiv/commit/529bc2f195f567cd1cd25eb7d8bf4c3fc9cf3652))

## [1.6.0](https://github.com/AI-by-design/primitiv/compare/v1.5.2...v1.6.0) (2026-05-08)


### Features

* **init:** broaden framework detection beyond next/vite/react ([5c98c43](https://github.com/AI-by-design/primitiv/commit/5c98c436a2a41513e74f514902104167510ce3b0))
* token-misuse detection + init AGENTS/CLAUDE and framework fixes ([66f9919](https://github.com/AI-by-design/primitiv/commit/66f991932b73b430e382e353ea9c3b3a2b201e30))
* token-misuse detection in verify (smart-match against contract) ([07040bd](https://github.com/AI-by-design/primitiv/commit/07040bd778868014d11dfbdd479224a44d2c8e3c))


### Bug Fixes

* **init:** write Primitiv block to both AGENTS.md and CLAUDE.md when both exist ([3794e8f](https://github.com/AI-by-design/primitiv/commit/3794e8f3c4086a53ec6388c00144e197adf30344))

## [1.5.2](https://github.com/AI-by-design/primitiv/compare/v1.5.1...v1.5.2) (2026-05-05)


### Bug Fixes

* **docker:** switch builder stage to bun, use bun.lock ([5e5d3fb](https://github.com/AI-by-design/primitiv/commit/5e5d3fb724c0557517fcce5c746d2a9e5a3ce90b))

## [1.5.1](https://github.com/AI-by-design/primitiv/compare/v1.5.0...v1.5.1) (2026-05-05)


### Bug Fixes

* correct export order in rationale and verify modules ([4c9cf6d](https://github.com/AI-by-design/primitiv/commit/4c9cf6de858558f4b37c179fc0a51bf59f15e14b))

## [1.5.0](https://github.com/AI-by-design/primitiv/compare/v1.4.0...v1.5.0) (2026-05-04)


### Features

* content-based verify + auto-install CI workflow ([445f31f](https://github.com/AI-by-design/primitiv/commit/445f31f8364154c8e2941625ab9019092f692904))

## [1.4.0](https://github.com/AI-by-design/primitiv/compare/v1.3.1...v1.4.0) (2026-04-20)


### Features

* init polish, verify CLI, rationale layer, storybook argTypes ([ad7cdb3](https://github.com/AI-by-design/primitiv/commit/ad7cdb32f67f61a9ed61b5ddf962f5bd293d7c47))
* init polish, verify CLI, rationale layer, storybook argTypes ([1ba5197](https://github.com/AI-by-design/primitiv/commit/1ba5197e66e33b9e24d476f472dd925165c98aae))
* **init:** detect package manager from lockfile for MCP runner ([5b02284](https://github.com/AI-by-design/primitiv/commit/5b02284400e3380ca03388b5a728c210ba2d2e44))

## [1.3.1](https://github.com/AI-by-design/primitiv/compare/v1.3.0...v1.3.1) (2026-04-16)


### Bug Fixes

* **tsconfig:** add explicit types array for TS 6.x compatibility ([2871a88](https://github.com/AI-by-design/primitiv/commit/2871a88a1f89a4eb3136325b926d90f74ff874eb))

## [1.3.0](https://github.com/AI-by-design/primitiv/compare/v1.2.0...v1.3.0) (2026-04-03)


### Features

* implement Figma and Storybook adapters with source provenance ([4d897a0](https://github.com/AI-by-design/primitiv/commit/4d897a02264fb9e5c45d512866ff807e3742cb77))

## [1.2.0](https://github.com/AI-by-design/primitiv/compare/v1.1.0...v1.2.0) (2026-03-24)


### Features

* add Figma and Storybook adapters to support new source types in the build process ([ebc2109](https://github.com/AI-by-design/primitiv/commit/ebc21096f1dbeda82b4129afa98c8965b1d61086))
* add sourceRoot to contract and implement warnings for contract mismatches and staleness ([b8b5f0c](https://github.com/AI-by-design/primitiv/commit/b8b5f0c73f85daf80ff2fd465a38bae16e55088a))
* enhance README and update contract handling with project-specific config paths and improved warning messages ([dc34c2c](https://github.com/AI-by-design/primitiv/commit/dc34c2c36e71412a427ed06e6ad740f28090bf86))

## [1.1.0](https://github.com/AI-by-design/primitiv/compare/v1.0.2...v1.1.0) (2026-03-18)


### Features

* add suggestedFix property to Conflict interface and implement fix message generation in ContractBuilder ([ca5d3d9](https://github.com/AI-by-design/primitiv/commit/ca5d3d9c35058a03821751be28674dceb25a9b8a))
* enhance Conflict handling by adding actionable property and updating fix message generation in ContractBuilder ([df5462f](https://github.com/AI-by-design/primitiv/commit/df5462fb0967b8d98c13650ef9fc4b145c72db6a))

## [1.0.2](https://github.com/AI-by-design/primitiv/compare/v1.0.1...v1.0.2) (2026-03-17)


### Bug Fixes

* update command argument for Primitiv server configuration ([37c70a1](https://github.com/AI-by-design/primitiv/commit/37c70a145b142fa2776b564d723a8b4692b95477))

## [1.0.1](https://github.com/AI-by-design/primitiv/compare/v1.0.0...v1.0.1) (2026-03-17)


### Bug Fixes

* publish to GitHub Packages registry ([1275743](https://github.com/AI-by-design/primitiv/commit/127574329b5ad5f933615cee150ade63a05fc93f))

## 1.0.0 (2026-03-17)


### Bug Fixes

* add npm install instructions to README ([a5dbcac](https://github.com/AI-by-design/primitiv/commit/a5dbcacbec6d3ceb12658f22aeae5c06e290d85b))
