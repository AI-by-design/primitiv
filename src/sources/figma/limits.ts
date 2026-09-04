// Keep these limits local to the Figma adapter: they bound untrusted API input
// without changing the shared source model.
export const FIGMA_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const FIGMA_MAX_SCAN_RESPONSE_BYTES = 64 * 1024 * 1024
export const FIGMA_MAX_PUBLISHED_ASSETS = 10_000
export const FIGMA_MAX_METADATA_STRING_BYTES = 1_024
export const FIGMA_MAX_DESCRIPTION_BYTES = 4_096
export const FIGMA_MAX_PROPERTY_NAME_BYTES = 512
export const FIGMA_MAX_PROPERTY_VALUE_STRING_BYTES = 4_096
export const FIGMA_MAX_PROPERTY_DEFINITIONS = 1_000
export const FIGMA_MAX_PROPERTY_VALUES = 1_000
